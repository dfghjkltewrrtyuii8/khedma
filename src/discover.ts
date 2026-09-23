// Find new wallets now, instead of waiting for the bench to run low:
//   npm run discover
//
// Prints every candidate with the evidence behind it, and adds the new ones
// to the back of the bench (data/wallets.json). Safe to run while the bot is
// stopped; with the bot running, it picks them up at its next rotation check.
// The first thing to run if DISCOVERY seems to find nothing — the report says
// how far it got (pools read, trades read) and where it broke.

import { loadConfig } from './config';
import { discoverWallets, printDiscoveryReport } from './discovery';
import { printRoster, WalletRoster } from './walletRoster';

async function main(): Promise<void> {
  const config = loadConfig('report');
  const pool = [...config.trackedWallets, ...config.benchWallets].map((w) => w.toBase58());
  const roster = new WalletRoster(pool, config.trackedWallets.length);
  roster.load();

  console.log('\n🔎 Looking for new wallets on GeckoTerminal — about a minute…\n');
  const report = await discoverWallets(roster.known());
  printDiscoveryReport(report);

  const added = roster.addDiscovered(report.candidates, Date.now());
  console.log(added.length ? `\nAdded ${added.length} to the back of the bench.\n` : '\nNothing new to add.\n');
  if (!config.discovery && config.benchWallets.length === 0) {
    console.log('Note: rotation is off (no BENCH_WALLETS and DISCOVERY=false), so the bot will not use these yet.');
    console.log('Set DISCOVERY=true in .env to have it rotate through them and keep finding more.\n');
  }
  printRoster(roster);
}

main().catch((error) => {
  console.error(`Discovery failed: ${(error as Error).message}`);
  process.exit(1);
});
