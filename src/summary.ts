// Standalone P&L report: reads data/positions.json and prints the summary
// without starting the bot. Run with: npm run summary
//
// Open positions are marked to market — one quote-only Jupiter call each,
// spaced by the shared rate limiter — so you can judge a wallet that buys and
// holds without waiting for it to sell.

import { loadConfig } from './config';
import { JupiterClient } from './jupiter';
import { printSummary } from './pnl';
import { PositionStore } from './positions';
import { RateLimiter } from './rateLimiter';

const JUPITER_MIN_GAP_MS = 1_100;

async function main(): Promise<void> {
  const store = new PositionStore();
  store.load();

  const openCount = store.byStatus('open').length;
  if (openCount === 0) {
    // Nothing to price, so don't require Jupiter credentials at all.
    await printSummary(store);
    return;
  }

  const config = loadConfig();
  const jupiter = new JupiterClient(config.jupiterApiKey, new RateLimiter(JUPITER_MIN_GAP_MS));
  await printSummary(store, jupiter, config.slippageBps);
}

main().catch((error) => {
  console.error(`Failed to print summary: ${(error as Error).message}`);
  process.exit(1);
});
