// Find new wallets now, instead of waiting for the bench to run low:
//   npm run discover
//
// Prints every candidate with the evidence behind it, and adds the new ones
// to the back of the bench (data/wallets.json). Safe to run while the bot is
// stopped; with the bot running, it picks them up at its next rotation check.
// The first thing to run if DISCOVERY seems to find nothing — the report says
// how far it got (pools read, trades read) and where it broke.

import { Connection } from '@solana/web3.js';
import { loadConfig } from './config';
import { discoverWallets, printDiscoveryReport } from './discovery';
import { PositionStore } from './positions';
import { RateLimiter } from './rateLimiter';
import { copySlots, printRoster, WalletRoster } from './walletRoster';
import { VetVerdict, vetWallet } from './walletVetting';
import { shortAddress } from './watcher';

async function main(): Promise<void> {
  const config = loadConfig('report');
  const pool = [...config.trackedWallets, ...config.benchWallets].map((w) => w.toBase58());
  const roster = new WalletRoster(pool, copySlots(config));
  roster.load();

  console.log('\n🔎 Looking for new wallets on GeckoTerminal — 2 to 3 minutes (their free tier only allows ~10 requests a minute)…\n');
  const report = await discoverWallets(roster.known());
  printDiscoveryReport(report);

  // Each nominee is checked against its own recent trades before it's kept.
  const connection = new Connection(config.heliusHttpsUrl, { commitment: 'confirmed' });
  const limiter = new RateLimiter(1000 / config.rpcRequestsPerSecond);
  const passed: { candidate: (typeof report.candidates)[number]; verdict: VetVerdict }[] = [];
  if (report.candidates.length > 0) console.log(`\n🧪 Checking ${report.candidates.length} nominee(s) against their own recent trades (Helius)…`);
  for (const c of report.candidates) {
    try {
      const verdict = await vetWallet(connection, limiter, c.wallet, config.minTrackedBuySol);
      console.log(`   ${{ pass: '✅', asleep: '💤', fail: '❌' }[verdict.status]} ${shortAddress(c.wallet)} — ${verdict.reason}`);
      if (verdict.status === 'fail') roster.reject(c.wallet, verdict.reason, Date.now());
      else passed.push({ candidate: c, verdict });
    } catch (error) {
      console.log(`   ⚠️ ${shortAddress(c.wallet)}: couldn't read its trades (${(error as Error).message.slice(0, 80)}) — skipped`);
    }
  }

  const added = roster.addDiscovered(passed.map((p) => p.candidate), Date.now());
  for (const w of added) {
    const verdict = passed.find((p) => p.candidate.wallet === w)!.verdict;
    roster.markVetted(w, Date.now(), verdict.hours);
    if (verdict.status === 'asleep') roster.idle(w, Date.now()); // waits on the bench until it trades
  }
  console.log(added.length ? `\nAdded ${added.length} to the back of the bench.\n` : '\nNothing new to add.\n');
  if (!config.discovery && config.benchWallets.length === 0) {
    console.log('Note: rotation is off (no BENCH_WALLETS and DISCOVERY=false), so the bot will not use these yet.');
    console.log('Set DISCOVERY=true in .env to have it rotate through them and keep finding more.\n');
  }
  const store = new PositionStore();
  store.load();
  printRoster(roster, store.all(), config);
}

main().catch((error) => {
  console.error(`Discovery failed: ${(error as Error).message}`);
  process.exit(1);
});
