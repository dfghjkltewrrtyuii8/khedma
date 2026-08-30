// P&L reporting. Always separates SIMULATED (dry-run) from REAL positions,
// and never counts stuck positions as realized profit or loss.

import { PositionStore } from './positions';
import { getSolPriceUsd } from './solPrice';
import { Position } from './types';
import { shortAddress } from './watcher';

function formatSol(sol: number, solPriceUsd: number | null): string {
  const sign = sol >= 0 ? '+' : '';
  const solPart = `${sign}${sol.toFixed(4)} SOL`;
  if (solPriceUsd === null) return `${solPart} (USD price unavailable)`;
  const usd = sol * solPriceUsd;
  return `${solPart} (${usd >= 0 ? '+' : '-'}$${Math.abs(usd).toFixed(2)})`;
}

function heldPercent(position: Position): number {
  const initial = BigInt(position.initialTokenAmountRaw || position.tokenAmountRaw);
  if (initial === 0n) return 0;
  return Number((BigInt(position.tokenAmountRaw) * 100n) / initial);
}

function printGroup(label: string, positions: Position[], solPriceUsd: number | null): void {
  if (positions.length === 0) return;

  const open = positions.filter((p) => p.status === 'open');
  const closed = positions.filter((p) => p.status === 'closed');
  const stuck = positions.filter((p) => p.status === 'stuck');

  console.log(`\n── ${label} ──`);

  if (closed.length > 0) {
    let realized = 0;
    for (const p of closed) realized += p.receivedSol - p.spentSol;
    console.log(`  Realized P&L (${closed.length} closed): ${formatSol(realized, solPriceUsd)}`);
    for (const p of closed) {
      console.log(`    • ${shortAddress(p.mint)}: spent ${p.spentSol.toFixed(4)}, got back ${p.receivedSol.toFixed(4)} → ${formatSol(p.receivedSol - p.spentSol, solPriceUsd)}`);
    }
  }

  if (open.length > 0) {
    console.log(`  Open positions (${open.length}) — unrealized, current value not marked to market:`);
    for (const p of open) {
      const partial = p.receivedSol > 0 ? `, ${100 - heldPercent(p)}% already sold for ${p.receivedSol.toFixed(4)} SOL` : '';
      console.log(`    • ${shortAddress(p.mint)}: spent ${p.spentSol.toFixed(4)} SOL${partial} (copied from ${shortAddress(p.sourceWallet)})`);
    }
  }

  if (stuck.length > 0) {
    console.log(`  🔴 STUCK positions (${stuck.length}) — sells failed, tokens still in wallet, NOT in realized P&L:`);
    for (const p of stuck) {
      console.log(`    • ${shortAddress(p.mint)} (${heldPercent(p)}% of bag remaining) — last error: ${p.stuckReason ?? 'unknown'}`);
      console.log(`      full mint: ${p.mint}`);
    }
  }
}

export async function printSummary(store: PositionStore): Promise<void> {
  const solPriceUsd = await getSolPriceUsd();

  console.log('\n════════════════ P&L SUMMARY ════════════════');
  if (solPriceUsd !== null) console.log(`SOL price: $${solPriceUsd.toFixed(2)}`);

  const positions = [...store.all()];
  if (positions.length === 0) {
    console.log('No positions yet.');
  } else {
    printGroup('SIMULATED (dry-run — no real money moved)', positions.filter((p) => p.dryRun), solPriceUsd);
    printGroup('REAL (actual on-chain trades)', positions.filter((p) => !p.dryRun), solPriceUsd);
  }
  console.log('═════════════════════════════════════════════\n');
}
