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
import { Rotation, WalletRoster } from './walletRoster';
import { installedWeb3Version, MIN_WEB3_VERSION, shortAddress, versionAtLeast, WalletWatcher } from './watcher';

// Free-tier Jupiter = 1 request/second shared across everything, so we keep
// ~1.1s between calls to stay safely under it.
const JUPITER_MIN_GAP_MS = 1_100;

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
    config.benchWallets.length > 0 || config.discovery
      ? `Wallets: rotating — copies ${config.trackedWallets.length} at a time from ${config.trackedWallets.length + config.benchWallets.length}; ` +
          `drops after ${config.walletMaxConsecutiveLosses} straight losses or a net loss over ${config.walletDropAfterTrades}, ` +
          `benches after ${config.walletIdleMinutes} quiet min` +
          (config.discovery ? '; DISCOVERY on — finds new wallets itself when the bench runs low (paper-tested first).\n' : '.\n')
      : 'Wallets: fixed list (set BENCH_WALLETS to rotate in substitutes).\n'
  );

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
  const rotating = config.benchWallets.length > 0 || config.discovery;
  const pool = [...config.trackedWallets, ...config.benchWallets].map((w) => w.toBase58());
  const roster = new WalletRoster(pool, config.trackedWallets.length);
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
      console.log,
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
  // Separate budget from Jupiter's: this one paces Helius RPC reads.
  const rpcLimiter = new RateLimiter(1000 / config.rpcRequestsPerSecond);
  const watcher = new WalletWatcher(
    connection,
    toWatch.map((w) => new PublicKey(w)),
    (event) => {
      if (event.side === 'buy') rotation?.noteBuy(event.sourceWallet, Date.now());
      return trader.handleSwapEvent(event);
    },
    rpcLimiter
  );
  quietenRpcRetryLogs();

  console.log('');
  watcher.start();
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
    reportWatcherHealth(watcher);
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
    reportWatcherHealth(watcher);
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
    console.log('Goodbye. 👋');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('Ctrl+C'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    console.error(`⚠️  Unhandled error (bot keeps running): ${reason instanceof Error ? reason.message : String(reason)}`);
  });
}

function reportWatcherHealth(watcher: WalletWatcher): void {
  const s = watcher.stats();
  const lost = s.droppedStale + s.droppedOverflow;
  console.log(
    `\n📊 Watcher: ${s.processed} transactions examined, ${s.queued} waiting` +
      (lost > 0 ? `, ${lost} skipped as stale (${s.droppedStale} timed out, ${s.droppedOverflow} overflowed)` : '') +
      (rpcRetries > 0 ? `\n   ${rpcRetries} RPC rate-limit retries so far — lower RPC_REQUESTS_PER_SECOND or watch fewer wallets.` : '') +
      (s.unreadableFormat > 0
        ? `\n   🚨 ${s.unreadableFormat} trade(s) were in a transaction format this build can't read — they were MISSED. Update the bot.`
        : '')
  );
}

main().catch((error) => {
  console.error(`\n❌ Fatal error: ${(error as Error).stack ?? (error as Error).message}`);
  process.exit(1);
});
