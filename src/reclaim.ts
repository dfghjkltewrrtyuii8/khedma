// `npm run reclaim`: close every EMPTY token account in the bot's wallet and
// get the rent back — ~0.002 SOL each. Accounts left behind by coins already
// sold (by the bot, or by you in Phantom) pile up, and the SOL locked in them
// doesn't show in your balance.
//
// It lists what it found and asks before doing anything. Accounts that still
// hold tokens are never touched — Solana itself refuses to close those — and
// neither are coins the bot still holds. Run it with the bot stopped.

import { Connection } from '@solana/web3.js';
import { loadConfig } from './config';
import { PositionStore } from './positions';
import { createPrompter } from './prompt';
import { getSolPriceUsd } from './solPrice';
import { closeAccounts, findEmptyAccounts } from './tokenAccounts';
import { loadKeypair } from './wallet';

async function main(): Promise<void> {
  const config = loadConfig('report');
  const keypair = loadKeypair(config);
  const connection = new Connection(config.heliusHttpsUrl, { wsEndpoint: config.heliusWssUrl, commitment: 'confirmed' });

  // Coins the bot still holds are left alone, even if an account reads empty.
  const store = new PositionStore();
  store.load();
  const keep = new Set(store.all().filter((p) => !p.dryRun && (p.status === 'open' || p.status === 'stuck')).map((p) => p.mint));

  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);
  console.log('Looking for empty token accounts…');
  const empty = await findEmptyAccounts(connection, keypair.publicKey, { keep });
  if (empty.length === 0) {
    console.log('✅ None found — nothing to reclaim.');
    process.exit(0);
  }
  const total = empty.reduce((a, e) => a + e.lamports, 0) / 1e9;
  const price = await getSolPriceUsd();
  console.log(
    `\nFound ${empty.length} empty token account(s) holding ${total.toFixed(4)} SOL of rent` +
      (price ? ` (about $${(total * price).toFixed(2)})` : '') +
      '.\nClosing them sends that SOL back to your wallet (a tiny network fee per transaction).' +
      '\nAccounts that still hold tokens are never touched.\n'
  );

  const { askYesNo, done } = createPrompter('reclaim');
  if (!(await askYesNo('Close them now?'))) {
    console.log('Nothing changed.');
    done();
    process.exit(0);
  }
  const result = await closeAccounts(connection, keypair, empty, (n, of) => console.log(`   closed ${n} of ${of}…`));
  console.log(
    `\n✅ Closed ${result.closed.length} account(s): ${result.reclaimedSol.toFixed(4)} SOL is back in your wallet` +
      (price ? ` (about $${(result.reclaimedSol * price).toFixed(2)})` : '') +
      '.'
  );
  if (result.failed.length > 0) {
    console.log(`⚠️  ${result.failed.length} couldn't be closed (some tokens don't allow it). First reason: ${result.failed[0].error.slice(0, 160)}`);
  }
  done();
  process.exit(0); // don't wait on the RPC connection's open socket
}

main().catch((error) => {
  console.error(`\n❌ Reclaim failed: ${(error as Error).message}`);
  process.exit(1);
});
