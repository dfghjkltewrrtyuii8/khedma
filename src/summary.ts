// Standalone P&L report: reads data/positions.json and prints the summary
// without starting the bot. Run with: npm run summary

import { PositionStore } from './positions';
import { printSummary } from './pnl';

async function main(): Promise<void> {
  const store = new PositionStore();
  store.load();
  await printSummary(store);
}

main().catch((error) => {
  console.error(`Failed to print summary: ${(error as Error).message}`);
  process.exit(1);
});
