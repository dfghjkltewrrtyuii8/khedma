// Entry point: wires everything together and handles graceful shutdown.
//
//   npm start          -> runs the bot (dry-run unless DRY_RUN=false in .env)
//   Ctrl+C (once)      -> stop watching, try to close all positions, print P&L
//   Ctrl+C (twice)     -> force-quit immediately (never double-executes sells)

import { Connection, PublicKey } from '@solana/web3.js';
import { loadConfig } from './config';
import { JupiterClient } from './jupiter';
import { printSummary } from './pnl';
import { PositionStore } from './positions';
import { RateLimiter } from './rateLimiter';
import { describeExitRules, exitRulesEnabled } from './exitRules';
import { decideShutdown } from './shutdownDebounce';
import { tokenGateEnabled } from './tokenMarket';
import { Trader } from './trader';
import { loadKeypair } from './wallet';
import { walletMute } from './walletGate';
import { discoverWallets, printDiscoveryReport } from './discovery';
import { copySlots, paperHints, Rotation, rotationOn, WalletRoster } from './walletRoster';
import { installedWeb3Version, MIN_WEB3_VERSION, shortAddress, versionAtLeast, WalletWatcher } from './watcher';
import { getSolPriceUsd } from './solPrice';
import {
  allQuiet,
  describeActivity,
  duration,
  formatOpen,
  formatPnl,
  formatSleep,
  formatStatus,
  formatTradeEvent,
  formatWallets,
  helpText,
  quietHint,
  TelegramBot,
  TelegramClient,
  TradeFeed,
} from './telegram';

// Free-tier Jupiter = 1 request/second shared across everything, so we keep
// ~1.1s between calls to stay safely under it.
const JUPITER_MIN_GAP_MS = 1_100;

// A heartbeat that arrives this much later than scheduled means the computer
// was asleep (a busy bot is late by seconds, not minutes).
const HEARTBEAT_MS = 30_000;
const SLEEP_GAP_MS = 3 * 60_000;

// Set once Telegram is running, so even a crash can say so on your phone.
let telegramForCrash: TelegramBot | null = null;

// @solana/web3.js prints one line per internal 429 retry. When the RPC plan is
// saturated that floods the log and buries the actual trades. Count them
// instead and report the total with each summary: the signal survives, the
// noise does not. The regex is exact so nothing else is swallowed.
let rpcRetries = 0;
function quietenRpcRetryLogs(): void {
  const isRetryLine = (args: unknown[]) =>
    typeof args[0] === 'string' && /Server responded with 429 Too Many Requests/.test(args[0]);
  for (const channel of ['log', 'error'] as const) {
    const original = console[channel].bind(console);
    console[channel] = (...args: unknown[]) => {
      if (isRetryLine(args)) {
        rpcRetries += 1;
        return;
      }
      original(...args);
    };
  }
}

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Solana Copy-Trading Bot                ║');
  console.log('╚══════════════════════════════════════════╝');

  const config = loadConfig();

  // Refuse to run blind. With an older Solana library the watcher can't read
  // the newest transaction format, so the bot would sit there looking idle
  // while the wallets it copies are trading.
  const web3Version = installedWeb3Version();
  if (!versionAtLeast(web3Version, MIN_WEB3_VERSION)) {
    console.error(
      `\n❌ The Solana library installed here is ${web3Version}; this bot needs ${MIN_WEB3_VERSION} or newer to\n` +
        '   read the transaction format Solana uses now. Without it, most trades would be invisible.\n' +
        '   Fix: run   npm install   in this folder, then start again.\n'
    );
    process.exit(1);
  }

  let keypair;
  try {
    keypair = loadKeypair(config);
  } catch (error) {
    console.error(`\n❌ Wallet error: ${(error as Error).message}\n`);
    process.exit(1);
  }

  if (config.dryRun) {
    console.log('\n🟢 MODE: DRY RUN (simulation only — no transactions will be sent).');
    console.log(`   Real quotes are fetched, trades are only recorded on paper (up to ${config.paperMaxOpenPositions} at once).`);
    console.log('   To trade for real, set DRY_RUN=false in .env — only after');
    console.log('   watching the bot behave correctly here first.\n');
  } else {
    console.log('\n🔴 MODE: REAL TRADING — this bot will spend REAL SOL from your wallet.');
    console.log(`   Each copied buy spends ${config.copyBuyAmountSol} SOL, max ${config.maxOpenPositions} positions.`);
    if (config.discovery) console.log(`   Wallets still on probation are copied on paper (up to ${config.paperMaxOpenPositions} at once).`);
    console.log('');
  }
  const tokenGate = tokenGateEnabled(config)
    ? `token must be ≥ ${config.minTokenAgeMinutes} min old with ≥ $${config.minLiquidityUsd.toLocaleString('en-US')} liquidity`
    : 'token check OFF';
  const walletGate =
    config.walletMaxConsecutiveLosses > 0
      ? `wallet muted after ${config.walletMaxConsecutiveLosses} straight copied losses` +
        (config.walletMuteHours > 0 ? ` (for ${config.walletMuteHours}h)` : ' (until removed)')
      : 'wallet muting OFF';
  console.log(`Filters: ${tokenGate}; ${walletGate}.`);
  console.log(`Exits:   ${describeExitRules(config)}.`);
  console.log(
    rotationOn(config)
      ? `Wallets: rotating — copies up to ${copySlots(config)} at a time (ACTIVE_WALLETS); ` +
          `drops after ${config.walletMaxConsecutiveLosses} straight losses or a net loss over ${config.walletDropAfterTrades}, ` +
          `benches after ${config.walletIdleMinutes} quiet min` +
          (config.discovery ? '; DISCOVERY on — finds new wallets itself when the bench runs low (paper-tested first).\n' : '.\n')
      : 'Wallets: fixed list (set BENCH_WALLETS to rotate in substitutes).\n'
  );
  if (config.dryRun) {
    const hints = paperHints(config);
    for (const hint of hints) console.log(`💡 ${hint}`);
    if (hints.length) console.log('');
  }

  const connection = new Connection(config.heliusHttpsUrl, {
    wsEndpoint: config.heliusWssUrl,
    commitment: 'confirmed',
  });

  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);
  try {
    const balance = await connection.getBalance(keypair.publicKey);
    console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);
  } catch (error) {
    console.error(`\n❌ Could not reach Helius RPC: ${(error as Error).message}`);
    console.error('   Check HELIUS_HTTPS_URL in your .env.\n');
    process.exit(1);
  }

  const store = new PositionStore();
  try {
    store.load();
  } catch (error) {
    console.error(`\n❌ data/positions.json exists but could not be read: ${(error as Error).message}`);
    console.error('   Fix or move the file, then start again (the bot will not risk overwriting it).\n');
    process.exit(1);
  }

  const stuck = store.byStatus('stuck');
  if (stuck.length > 0) {
    console.log(`\n🔴 Reminder: ${stuck.length} STUCK position(s) from before (sells failed, tokens still held).`);
    console.log('   They will be retried when you shut down with Ctrl+C.');
  }
  const openCount = store.byStatus('open').length;
  if (openCount > 0) console.log(`ℹ️  ${openCount} open position(s) carried over from last run.`);
  for (const wallet of config.trackedWallets) {
    const mute = walletMute(store.all(), wallet.toBase58(), Date.now(), config);
    if (mute.muted) console.log(`🔇 ${shortAddress(wallet.toBase58())} is muted — ${mute.reason}`);
  }

  // Rotation: decide which wallets get a slot before watching anything.
  const rotating = rotationOn(config);
  const slots = rotating ? copySlots(config) : config.trackedWallets.length;
  const pool = [...config.trackedWallets, ...config.benchWallets].map((w) => w.toBase58());
  const roster = new WalletRoster(pool, slots);
  // Declared before rotation starts, so its swaps can be announced on Telegram
  // once that's running.
  let telegram: TelegramBot | null = null;
  let rotation: Rotation | null = null;
  let toWatch = config.trackedWallets.map((w) => w.toBase58());
  if (rotating) {
    try {
      roster.load();
    } catch (error) {
      console.error(`\n❌ data/wallets.json exists but could not be read: ${(error as Error).message}`);
      console.error('   Fix or delete it, then start again.\n');
      process.exit(1);
    }
    rotation = new Rotation(
      roster,
      store,
      config,
      (message) => {
        console.log(message);
        // Wallet swaps and finds go to your phone too; the routine
        // "looking…" lines stay in the terminal.
        if (/^🔄|^🔎 Found/.test(message)) telegram?.send(message);
      },
      config.discovery
        ? {
            minBench: 3,
            cooldownMs: 30 * 60_000,
            run: async (exclude) => {
              const report = await discoverWallets(exclude);
              printDiscoveryReport(report);
              return report.candidates;
            },
          }
        : null
    );
    toWatch = rotation.startup(Date.now());
  }

  const limiter = new RateLimiter(JUPITER_MIN_GAP_MS);
  const jupiter = new JupiterClient(config.jupiterApiKey, limiter);
  const trader = new Trader(config, connection, keypair, jupiter, store);
  if (rotating) trader.setActiveWallets(roster.active());
  if (rotation) {
    const r = rotation;
    trader.setPaperOnly((wallet) => r.isPaperOnly(wallet));
  }
  const startedAt = Date.now();
  let lastSwap: { at: number; wallet: string } | null = null;
  // Separate budget from Jupiter's: this one paces Helius RPC reads.
  const rpcLimiter = new RateLimiter(1000 / config.rpcRequestsPerSecond);
  const watcher = new WalletWatcher(
    connection,
    toWatch.map((w) => new PublicKey(w)),
    (event) => {
      lastSwap = { at: Date.now(), wallet: event.sourceWallet };
      if (event.side === 'buy') rotation?.noteBuy(event.sourceWallet, Date.now());
      return trader.handleSwapEvent(event);
    },
    rpcLimiter
  );
  quietenRpcRetryLogs();

  console.log('');
  watcher.start();
  watcher.startActivityChecks();
  const activity = () => watcher.watchedWallets().map((wallet) => ({ wallet, at: watcher.lastActivityOf(wallet) }));

  // ---- Telegram: reports on your phone (optional; `npm run telegram`) ----
  const sleeps: { from: number; to: number }[] = [];
  const reportMs = config.telegramReportHours * 3_600_000;
  let lastReportAt = Date.now();
  const reportInput = async () => ({
    positions: [...store.all()],
    now: Date.now(),
    solPriceUsd: await getSolPriceUsd(),
    priceOf: (id: string) => trader.currentValue(id)?.valueSol,
  });
  if (config.telegramBotToken && config.telegramChatId) {
    const watchedCount = () => (rotation ? roster.active().length : config.trackedWallets.length);
    telegram = new TelegramBot(
      new TelegramClient(config.telegramBotToken),
      config.telegramChatId,
      {
        pnl: async () =>
          formatPnl({ ...(await reportInput()), title: 'P&L so far', recentSince: Date.now() - 24 * 3_600_000, recentLabel: 'Last 24h' }),
        open: async () => formatOpen(await reportInput()),
        wallets: async () =>
          formatWallets({
            positions: [...store.all()],
            copying: rotation ? roster.active() : config.trackedWallets.map((w) => w.toBase58()),
            bench: rotation ? roster.bench() : [],
            dropped: rotation ? roster.dropped() : [],
            isDiscovered: (w) => rotation !== null && roster.isDiscovered(w),
            isPaperOnly: (w) => rotation?.isPaperOnly(w) ?? false,
            solPriceUsd: await getSolPriceUsd(),
          }),
        status: async () =>
          formatStatus({
            now: Date.now(),
            startedAt,
            dryRun: config.dryRun,
            watching: watchedCount(),
            processed: watcher.stats().processed,
            missedUnreadable: watcher.stats().unreadableFormat,
            lastSwap,
            sleeps,
            nextReportAt: reportMs > 0 ? lastReportAt + reportMs : null,
            activity: activity(),
            rotating,
          }),
      },
      config.telegramReportHours
    );
    telegram.start();
    telegramForCrash = telegram;
    const copying = watchedCount();
    telegram.send(
      `🟢 Bot started · ${config.dryRun ? 'PAPER mode' : '💰 REAL MONEY mode'} · copying ${copying} wallet(s)` +
        (rotation && copying < slots ? `, looking for ${slots - copying} more` : '') +
        `\n\n${helpText(config.telegramReportHours)}`
    );
    console.log(
      `📱 Telegram on: ${config.telegramReportHours > 0 ? `a report every ${config.telegramReportHours}h` : 'reports on request'}` +
        `, trade alerts: ${config.telegramTradeAlerts}. On your phone, send /pnl any time.`
    );
  } else if (config.telegramBotToken) {
    console.log('📱 Telegram: token set but not linked to your chat yet — run: npm run telegram');
  } else {
    console.log('📱 Want P&L on your phone? Optional: npm run telegram');
  }

  // Trade alerts: compare the position store with the last look.
  const feed = new TradeFeed(store.all());
  const feedTimer = telegram
    ? setInterval(async () => {
        const events = feed.poll(store.all());
        if (events.length === 0) return;
        const price = await getSolPriceUsd();
        for (const event of events) {
          const message = formatTradeEvent(event, config.telegramTradeAlerts, price);
          if (message) telegram!.send(message.text, message.silent);
        }
      }, 10_000)
    : null;

  const reportTimer =
    telegram && reportMs > 0
      ? setInterval(async () => {
          const since = lastReportAt;
          lastReportAt = Date.now();
          telegram!.send(
            formatPnl({ ...(await reportInput()), title: `${config.telegramReportHours}-hour report`, recentSince: since, recentLabel: 'Since last report' })
          );
        }, reportMs)
      : null;

  // Sleep detection: a sleeping computer runs nothing, so the bot can only
  // notice afterwards — by its heartbeat arriving far too late.
  let lastBeat = Date.now();
  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastBeat > SLEEP_GAP_MS) {
      const gap = { from: lastBeat, to: now };
      sleeps.push(gap);
      console.log(`\n${formatSleep(gap)}\n`);
      telegram?.send(formatSleep(gap));
    }
    lastBeat = now;
  }, HEARTBEAT_MS);

  console.log('\nRunning. Press Ctrl+C once to stop and close positions gracefully.\n');

  // Default 30s (SUMMARY_INTERVAL_SECONDS in .env). Cheap even at short
  // intervals: deliberately NOT marked to market, since pricing open
  // positions costs one Jupiter call each, and while the bot is running that
  // budget belongs to trading. This is just a local read of the position
  // store plus an occasional (60s-cached) CoinGecko price fetch — no RPC or
  // Jupiter calls. Use `npm run summary` (or shut down) for marked-to-market
  // numbers, in both DRY_RUN and real mode alike.
  const summaryTimer = setInterval(() => {
    if (rotation) rotation.tick(Date.now(), watcher, trader).catch(() => {});
    reportWatcherHealth(watcher, rotating);
    if (rotation) console.log(`   Wallets: ${rotation.describe()}`);
    printSummary(store, undefined, config.slippageBps, config).catch(() => {});
  }, config.summaryIntervalSeconds * 1000);

  // Our own exits: price open positions and act without waiting for the
  // tracked wallet. Costs one Jupiter call (~1.1s) per open position each
  // time it runs. A trade that arrives mid-sweep waits for at most the one
  // call in progress — the sweep stops there and resumes next time. Skipped
  // entirely when every rule is off, so it then costs nothing.
  const exitTimer = exitRulesEnabled(config)
    ? setInterval(() => {
        trader.checkExits().catch(() => {});
      }, config.exitCheckSeconds * 1000)
    : null;

  // ---- graceful shutdown ----
  // A second SIGINT arriving within FORCE_QUIT_DEBOUNCE_MS of the first is
  // treated as an accidental double-tap (key-repeat, an impatient double
  // press) and ignored, not a force-quit. Real positions only get one chance
  // to close on shutdown — a stray extra keystroke cutting that off mid-sell
  // leaves them stuck for nothing. A second press after the window has
  // elapsed still force-quits, for when you genuinely mean it.
  const FORCE_QUIT_DEBOUNCE_MS = 5_000;
  let shutdownStartedAt: number | null = null;
  const shutdown = async (signal: string) => {
    const decision = decideShutdown(shutdownStartedAt, Date.now(), FORCE_QUIT_DEBOUNCE_MS);
    if (decision === 'already-quitting') {
      const elapsed = Date.now() - shutdownStartedAt!;
      console.log(`\n(Still closing positions — give it a few more seconds. Press Ctrl+C again after ${Math.ceil((FORCE_QUIT_DEBOUNCE_MS - elapsed) / 1000)}s to force-quit for real.)`);
      return;
    }
    if (decision === 'force-quit') {
      console.log('\nForce quit. (Sells were not run twice — any position not closed is still recorded as open.)');
      process.exit(130);
    }
    shutdownStartedAt = Date.now();

    console.log(`\n\n🛑 ${signal} received — stopping now.`);
    console.log('   1) No new opportunities will be taken.');
    console.log('   2) Trying to close open positions…');
    console.log(`   (A second Ctrl+C only force-quits after ~${FORCE_QUIT_DEBOUNCE_MS / 1000}s — real positions get a fair chance to close first.)\n`);

    clearInterval(summaryTimer);
    if (exitTimer) clearInterval(exitTimer);
    // The final report below covers every close, so no per-trade alerts now.
    if (feedTimer) clearInterval(feedTimer);
    if (reportTimer) clearInterval(reportTimer);
    clearInterval(heartbeatTimer);
    telegram?.stop();
    reportWatcherHealth(watcher, rotating);
    trader.beginShutdown();
    await watcher.stop();

    try {
      await trader.closeAllPositions('closing on shutdown');
    } catch (error) {
      console.error(`Error while closing positions: ${(error as Error).message}`);
    }

    // Anything that could not be closed above is priced here, so the final
    // report shows what the leftovers are actually worth.
    await printSummary(store, jupiter, config.slippageBps, config, true);
    if (telegram) {
      telegram.send(
        `🔴 Bot stopped after ${duration(Date.now() - startedAt)}.\n\n` +
          formatPnl({ ...(await reportInput()), title: 'Final P&L', recentSince: startedAt, recentLabel: 'This run' })
      );
      console.log('Sending the final report to Telegram…');
      await telegram.flush(10_000);
    }
    console.log('Goodbye. 👋');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('Ctrl+C'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('uncaughtException', (error) => {
    console.error(`\n❌ Fatal error: ${error.stack ?? error.message}`);
    void (async () => {
      if (telegram) {
        telegram.send(`❌ The bot crashed and stopped: ${error.message}\nRestart it on the computer with: npm start`, false);
        await telegram.flush(5_000);
      }
      process.exit(1);
    })();
  });
  process.on('unhandledRejection', (reason) => {
    console.error(`⚠️  Unhandled error (bot keeps running): ${reason instanceof Error ? reason.message : String(reason)}`);
  });
}

function reportWatcherHealth(watcher: WalletWatcher, rotating: boolean): void {
  const s = watcher.stats();
  const lost = s.droppedStale + s.droppedOverflow;
  const now = Date.now();
  const activity = watcher.watchedWallets().map((wallet) => ({ wallet, at: watcher.lastActivityOf(wallet) }));
  console.log(
    `\n📊 Watcher: ${s.processed} transactions examined, ${s.queued} waiting` +
      (lost > 0 ? `, ${lost} skipped as stale (${s.droppedStale} timed out, ${s.droppedOverflow} overflowed)` : '') +
      (activity.length > 0 ? `\n   Last on-chain activity: ${describeActivity(activity, now)}` : '') +
      (allQuiet(activity, now) ? `\n   ${quietHint(rotating)}` : '') +
      (s.missedByFeed > 0 ? `\n   📡 The live feed missed ${s.missedByFeed} transaction(s) so far; each time the wallet was reconnected.` : '') +
      (rpcRetries > 0 ? `\n   ${rpcRetries} RPC rate-limit retries so far — lower RPC_REQUESTS_PER_SECOND or watch fewer wallets.` : '') +
      (s.unreadableFormat > 0
        ? `\n   🚨 ${s.unreadableFormat} trade(s) were in a transaction format this build can't read — they were MISSED. Update the bot.`
        : '')
  );
}

main().catch(async (error) => {
  console.error(`\n❌ Fatal error: ${(error as Error).stack ?? (error as Error).message}`);
  if (telegramForCrash) {
    // The one message that makes the phone buzz by default: nothing is being watched now.
    telegramForCrash.send(`❌ The bot crashed and stopped: ${(error as Error).message}\nRestart it on the computer with: npm start`, false);
    await telegramForCrash.flush(5_000);
  }
  process.exit(1);
});
