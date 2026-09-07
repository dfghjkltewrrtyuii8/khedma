// Manually write off a position the bot can never resolve on its own — e.g. a
// token that rugged (lost all liquidity) before it could be sold. The bot only
// auto-resolves a position when the wallet balance reads zero (see 'abandoned'
// in trader.ts); a rugged token you still hold has no route to sell but isn't
// zero-balance, so without this it stays 'stuck' forever, permanently
// occupying a position slot.
//
// Usage:
//   npm run writeoff                  -> lists every real position still
//                                         occupying a slot (open or stuck)
//   npm run writeoff -- <position-id> -> marks that one written off: frees
//                                         its slot, records no P&L (you're
//                                         declaring it unrecoverable, not
//                                         claiming a known loss)

import { PositionStore } from './positions';

function main(): void {
  const store = new PositionStore();
  store.load();
  const id = process.argv[2];

  const atRisk = store.all().filter((p) => !p.dryRun && (p.status === 'open' || p.status === 'stuck'));

  if (!id) {
    if (atRisk.length === 0) {
      console.log('No real positions are occupying a slot right now.');
      return;
    }
    console.log(`Real positions currently occupying a slot (${atRisk.length}):\n`);
    for (const p of atRisk) {
      console.log(`  ${p.id}`);
      console.log(`    status: ${p.status}${p.stuckReason ? ` — ${p.stuckReason}` : ''}`);
      console.log(`    mint:   ${p.mint}`);
      console.log(`    spent:  ${p.spentSol} SOL`);
      console.log('');
    }
    console.log('Only write off one you are sure is unrecoverable (rugged, no liquidity left).');
    console.log('To write one off:\n  npm run writeoff -- <position-id>');
    return;
  }

  const position = atRisk.find((p) => p.id === id);
  if (!position) {
    console.error(`No open/stuck real position with id "${id}".`);
    console.error('Run "npm run writeoff" with no arguments to list the valid ids.');
    process.exit(1);
  }

  store.markAbandoned(position, 'written off manually — could not be sold (e.g. rugged / no liquidity)');
  console.log(`Wrote off ${position.id} (mint ${position.mint}).`);
  console.log('Its slot is free now. The 0.1 SOL spent stays on record, but no gain or loss is');
  console.log("counted for it — you're declaring it unrecoverable, not claiming a known loss.");
}

main();
