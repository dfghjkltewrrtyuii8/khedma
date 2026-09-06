// Entry point: wires everything together and handles graceful shutdown.
//
//   npm start          -> runs the bot (dry-run unless DRY_RUN=false in .env)
//   Ctrl+C (once)      -> stop watching, try to close all positions, print P&L
//   Ctrl+C (twice)     -> force-quit immediately (never double-executes sells)

import { Connection } from '@solana/web3.js';
import { loadConfig } from './config';
import { JupiterClient } from './jupiter';
import { printSummary } from './pnl';
import { PositionStore } from './positions';
import { RateLimiter } from './rateLimiter';
import { Trader } from './trader';
import { loadKeypair } from './wallet';
import { WalletWatcher } from './watcher';

// Free-tier Jupiter = 1 request/second shared across everything, so we keep
// ~1.1s between calls to stay safely under it.
const JUPITER_MIN_GAP_MS = 1_100;
const PERIODIC_SUMMARY_MS = 15 * 60_000;

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

  let keypair;
  try {
    keypair = loadKeypair(config);
  } catch (error) {
    console.error(`\n❌ Wallet error: ${(error as Error).message}\n`);
    process.exit(1);
  }

  if (config.dryRun) {
    console.log('\n🟢 MODE: DRY RUN (simulation only — no transactions will be sent).');
    console.log('   Real quotes are fetched, trades are only recorded on paper.');
    console.log('   To trade for real, set DRY_RUN=false in .env — only after');
    console.log('   watching the bot behave correctly here first.\n');
  } else {
    console.log('\n🔴 MODE: REAL TRADING — this bot will spend REAL SOL from your wallet.');
    console.log(`   Each copied buy spends ${config.copyBuyAmountSol} SOL, max ${config.maxOpenPositions} positions.\n`);
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

  const limiter = new RateLimiter(JUPITER_MIN_GAP_MS);
  const jupiter = new JupiterClient(config.jupiterApiKey, limiter);
  const trader = new Trader(config, connection, keypair, jupiter, store);
  // Separate budget from Jupiter's: this one paces Helius RPC reads.
  const rpcLimiter = new RateLimiter(1000 / config.rpcRequestsPerSecond);
  const watcher = new WalletWatcher(
    connection,
    config.trackedWallets,
    (event) => trader.handleSwapEvent(event),
    rpcLimiter
  );
  quietenRpcRetryLogs();

  console.log('');
  watcher.start();
  console.log('\nRunning. Press Ctrl+C once to stop and close positions gracefully.\n');

  // Deliberately NOT marked to market: pricing open positions costs one Jupiter
  // call each, and while the bot is running that budget belongs to trading.
  // Use `npm run summary` (or shut down) for marked-to-market numbers.
  const summaryTimer = setInterval(() => {
    reportWatcherHealth(watcher);
    printSummary(store).catch(() => {});
  }, PERIODIC_SUMMARY_MS);

  // ---- graceful shutdown ----
  let shutdownStarted = false;
  const shutdown = async (signal: string) => {
    if (shutdownStarted) {
      console.log('\nForce quit. (Sells were not run twice — any position not closed is still recorded as open.)');
      process.exit(130);
    }
    shutdownStarted = true;

    console.log(`\n\n🛑 ${signal} received — stopping now.`);
    console.log('   1) No new opportunities will be taken.');
    console.log('   2) Trying to close open positions…');
    console.log('   (Press Ctrl+C again to force-quit without waiting.)\n');

    clearInterval(summaryTimer);
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
    await printSummary(store, jupiter, config.slippageBps);
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
      (rpcRetries > 0 ? `\n   ${rpcRetries} RPC rate-limit retries so far — lower RPC_REQUESTS_PER_SECOND or watch fewer wallets.` : '')
  );
}

main().catch((error) => {
  console.error(`\n❌ Fatal error: ${(error as Error).stack ?? (error as Error).message}`);
  process.exit(1);
});
