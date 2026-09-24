// Standalone P&L report: reads data/positions.json and prints the summary
// without starting the bot.
//
//   npm run summary          -> the latest run on its own (the current one, if the bot is running)
//   npm run summary -- all   -> every run together
//
// Open positions are marked to market — one quote-only Jupiter call each,
// spaced by the shared rate limiter — so you can judge a wallet that buys and
// holds without waiting for it to sell.

import { loadConfig } from './config';
import { JupiterClient } from './jupiter';
import { printSummary } from './pnl';
import { PositionStore } from './positions';
import { RateLimiter } from './rateLimiter';
import { copySlots, printRoster, rotationOn, WalletRoster } from './walletRoster';

const JUPITER_MIN_GAP_MS = 1_100;

async function main(): Promise<void> {
  const config = loadConfig('report');
  const store = new PositionStore();
  store.load();

  // Only build a Jupiter client when there is something to price.
  const openCount = store.byStatus('open').length;
  const jupiter = openCount > 0 ? new JupiterClient(config.jupiterApiKey, new RateLimiter(JUPITER_MIN_GAP_MS)) : undefined;
  const wantsAll = process.argv.slice(2).some((a) => a.replace(/^-+/, '').toLowerCase() === 'all');
  const run = wantsAll ? null : store.lastRun();
  if (run) {
    const started = new Date(run.startedAt);
    const label =
      `the latest run (started ${started.toLocaleString()}` +
      (run.endedAt ? `, stopped ${new Date(run.endedAt).toLocaleTimeString()})` : ', still running or stopped without Ctrl+C)');
    await printSummary(store, jupiter, config.slippageBps, config, true, { since: started.getTime(), label });
  } else {
    if (!wantsAll) console.log('(No run recorded yet — showing every position.)');
    await printSummary(store, jupiter, config.slippageBps, config, true);
  }

  if (rotationOn(config)) {
    const pool = [...config.trackedWallets, ...config.benchWallets].map((w) => w.toBase58());
    const roster = new WalletRoster(pool, copySlots(config));
    roster.load();
    printRoster(roster, store.all(), config);
  }
}

main().catch((error) => {
  console.error(`Failed to print summary: ${(error as Error).message}`);
  process.exit(1);
});
