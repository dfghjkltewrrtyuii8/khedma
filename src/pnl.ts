// P&L reporting. Always separates SIMULATED (dry-run) from REAL positions,
// and never counts stuck positions as realized profit or loss.
//
// Open positions can optionally be marked to market: pass a JupiterClient and
// each one is priced with a quote-only sell order (no taker, so nothing is
// balance-checked and no transaction is built). Without it, open positions are
// reported at cost, as before.

import { SOL_MINT } from './config';
import { JupiterClient, JupiterError } from './jupiter';
import { inRun, PositionStore } from './positions';
import { getSolPriceUsd } from './solPrice';
import { Position } from './types';
import { compareToSource, entryPhrase, summarizeComparisons } from './copyGap';
import { WalletGateConfig, WalletMute, walletMute, walletRecords } from './walletGate';
import { shortAddress } from './watcher';

interface Mark {
  valueSol: number | null; // null = could not be priced
  reason?: string;
}

function formatSol(sol: number, solPriceUsd: number | null): string {
  const sign = sol >= 0 ? '+' : '';
  const solPart = `${sign}${sol.toFixed(4)} SOL`;
  if (solPriceUsd === null) return `${solPart} (USD price unavailable)`;
  const usd = sol * solPriceUsd;
  return `${solPart} (${usd >= 0 ? '+' : '-'}$${Math.abs(usd).toFixed(2)})`;
}

// Rent a new token account locks up on Solana (rent-exempt minimum for a
// 165-byte SPL token account). Refundable only if the empty account is later
// closed, which this bot does not do.
export const TOKEN_ACCOUNT_RENT_SOL = 0.00203928;

function signedPct(x: number): string {
  return `${x >= 0 ? '+' : ''}${x.toFixed(0)}%`;
}

function heldPercent(position: Position): number {
  const initial = BigInt(position.initialTokenAmountRaw || position.tokenAmountRaw);
  if (initial === 0n) return 0;
  return Number((BigInt(position.tokenAmountRaw) * 100n) / initial);
}

// Price each position's remaining tokens in SOL. One Jupiter call per position,
// serialized by the shared rate limiter, so this takes ~1.1s each.
async function markToMarket(
  positions: Position[],
  jupiter: JupiterClient,
  slippageBps: number
): Promise<Map<string, Mark>> {
  const marks = new Map<string, Mark>();
  if (positions.length === 0) return marks;

  console.log(`Pricing ${positions.length} open position(s) — about ${Math.ceil(positions.length * 1.1)}s…`);
  for (const position of positions) {
    const remaining = BigInt(position.tokenAmountRaw);
    if (remaining <= 0n) continue;
    try {
      const order = await jupiter.getOrder({
        inputMint: position.mint,
        outputMint: SOL_MINT,
        amountRaw: remaining,
        takerPubkey: null, // quote only — never balance-checks the wallet
        slippageBps,
      });
      marks.set(position.id, { valueSol: Number(order.outAmountRaw) / 1e9 });
    } catch (error) {
      const kind = (error as JupiterError).kind;
      marks.set(position.id, {
        valueSol: null,
        reason:
          kind === 'no-route'
            ? 'NO ROUTE — nothing will buy this right now'
            : (error as Error).message.slice(0, 90),
      });
    }
  }
  return marks;
}

// "· them +40%" after a closed trade: what the tracked wallet's own trade in
// the same token returned, once we've seen them sell.
function theirSide(p: Position): string {
  const c = compareToSource(p);
  return c.theirReturnPct === null ? '' : ` · them ${signedPct(c.theirReturnPct)}`;
}

function printGroup(
  label: string,
  positions: Position[],
  solPriceUsd: number | null,
  marks: Map<string, Mark>,
  muteOf: (wallet: string) => WalletMute,
  detailed = false
): void {
  if (positions.length === 0) return;

  const open = positions.filter((p) => p.status === 'open');
  const closed = positions.filter((p) => p.status === 'closed');
  const stuck = positions.filter((p) => p.status === 'stuck');
  const abandoned = positions.filter((p) => p.status === 'abandoned');

  console.log(`\n── ${label} ──`);

  if (closed.length > 0) {
    let realized = 0;
    for (const p of closed) realized += p.receivedSol - p.spentSol;
    console.log(`  Realized P&L (${closed.length} closed): ${formatSol(realized, solPriceUsd)}`);
    for (const p of closed) {
      console.log(
        `    • ${shortAddress(p.mint)}: spent ${p.spentSol.toFixed(4)}, got back ${p.receivedSol.toFixed(4)} → ${formatSol(p.receivedSol - p.spentSol, solPriceUsd)}` +
          (p.exitRule ? ` [${p.exitRule}]` : '') +
          theirSide(p)
      );
    }

    // Which wallets are actually worth copying — best to worst by net result.
    const records = [...walletRecords(positions).values()].sort((a, b) => b.netSol - a.netSol);
    console.log('  By wallet (closed positions only):');
    for (const r of records) {
      const streak = r.consecutiveLosses >= 2 ? `, ${r.consecutiveLosses} losses in a row` : '';
      const muted = muteOf(r.wallet).muted ? ' — 🔇 MUTED' : '';
      console.log(`    • ${shortAddress(r.wallet)}: ${r.closed} closed, ${r.wins}W/${r.losses}L, net ${formatSol(r.netSol, solPriceUsd)}${streak}${muted}`);
      const cmp = summarizeComparisons(positions.filter((p) => p.sourceWallet === r.wallet));
      if (cmp.comparable > 0 && cmp.ourAvgPct !== null && cmp.theirAvgPct !== null) {
        console.log(
          `        same tokens, ${cmp.comparable} compared: you ${signedPct(cmp.ourAvgPct)} avg vs them ${signedPct(cmp.theirAvgPct)}` +
            (cmp.entryGapAvgPct !== null ? ` · ${entryPhrase(cmp.entryGapAvgPct)}` : '')
        );
      } else if (cmp.entryGapAvgPct !== null) {
        console.log(`        ${entryPhrase(cmp.entryGapAvgPct)} (their exits not seen yet)`);
      }
      if (cmp.verdict) console.log(`        → ${cmp.verdict}`);
    }

    // Paper trades are priced from quotes and pay no costs. Real ones do, and
    // at small sizes the fixed part dominates — say so next to the numbers.
    if (positions.some((p) => p.dryRun)) {
      const avgSpent = closed.reduce((a, p) => a + p.spentSol, 0) / closed.length;
      if (avgSpent > 0) {
        console.log(
          `  Not in these paper numbers: a real trade also locks ~${TOKEN_ACCOUNT_RENT_SOL.toFixed(4)} SOL of token-account rent ` +
            `per new token, plus network fees — about ${((TOKEN_ACCOUNT_RENT_SOL / avgSpent) * 100).toFixed(0)}% of a ` +
            `${avgSpent.toFixed(4)} SOL position before the price moves at all.`
        );
      }
    }

    // Look at what actually happened. Only on demand (npm run summary /
    // shutdown), so the 30-second print stays short.
    if (detailed) {
      const recent = [...closed].sort((a, b) => Date.parse(b.closedAt ?? '') - Date.parse(a.closedAt ?? '')).slice(0, 8);
      console.log('  Charts (most recent first):');
      for (const p of recent) console.log(`    • ${shortAddress(p.mint)}  https://dexscreener.com/solana/${p.mint}`);
    }
  }

  if (open.length > 0) {
    const priced = open.filter((p) => marks.get(p.id)?.valueSol != null);
    if (priced.length > 0) {
      let unrealized = 0;
      for (const p of priced) unrealized += marks.get(p.id)!.valueSol! + p.receivedSol - p.spentSol;
      console.log(`  Unrealized P&L (${priced.length} of ${open.length} open, marked to market): ${formatSol(unrealized, solPriceUsd)}`);
    } else {
      console.log(`  Open positions (${open.length}) — not marked to market:`);
    }

    for (const p of open) {
      const mark = marks.get(p.id);
      const partial = p.receivedSol > 0 ? `, ${100 - heldPercent(p)}% already sold for ${p.receivedSol.toFixed(4)} SOL` : '';
      const head = `    • ${shortAddress(p.mint)}: spent ${p.spentSol.toFixed(4)} SOL${partial} (from ${shortAddress(p.sourceWallet)})`;
      if (!mark) {
        console.log(head);
      } else if (mark.valueSol === null) {
        console.log(`${head}\n        ⚠️  ${mark.reason}`);
      } else {
        const pnl = mark.valueSol + p.receivedSol - p.spentSol;
        const pct = (pnl / p.spentSol) * 100;
        console.log(`${head}\n        now worth ${mark.valueSol.toFixed(4)} SOL → ${formatSol(pnl, solPriceUsd)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`);
      }
    }
  }

  if (stuck.length > 0) {
    console.log(`  🔴 STUCK positions (${stuck.length}) — sells failed, tokens still in wallet, NOT in realized P&L:`);
    for (const p of stuck) {
      console.log(`    • ${shortAddress(p.mint)} (${heldPercent(p)}% of bag remaining) — last error: ${p.stuckReason ?? 'unknown'}`);
      console.log(`      full mint: ${p.mint}`);
    }
  }

  if (abandoned.length > 0) {
    console.log(`  ⚪ ABANDONED (${abandoned.length}) — wallet held none of the token, likely sold outside the bot. Spent is shown but NOT counted as a loss, since we don't know what it actually sold for:`);
    for (const p of abandoned) {
      console.log(`    • ${shortAddress(p.mint)}: spent ${p.spentSol.toFixed(4)} SOL — ${p.abandonedReason ?? 'unknown'}`);
    }
  }
}

// One line with the totals over every run — shown under a single run's sheet
// so the bigger picture is never lost. Empty when there's nothing beyond it.
export function allRunsLine(all: readonly Position[], shown: readonly Position[], solPriceUsd: number | null): string {
  const closed = all.filter((p) => p.status === 'closed');
  if (closed.length <= shown.filter((p) => p.status === 'closed').length) return '';
  const part = (label: string, group: Position[]) =>
    group.length === 0 ? null : `${label} ${group.length} closed, ${formatSol(group.reduce((a, p) => a + p.receivedSol - p.spentSol, 0), solPriceUsd)}`;
  const parts = [part('paper', closed.filter((p) => p.dryRun)), part('real', closed.filter((p) => !p.dryRun))].filter(Boolean);
  return `All runs together: ${parts.join(' · ')}`;
}

// Pass `jupiter` to price open positions. Omit it to report them at cost —
// used for the periodic in-run summary, so reporting never competes with
// trading for the shared 1 request/second Jupiter budget. Pass `run` to show
// one run's sheet (everything since it started) instead of the whole history.
export async function printSummary(
  store: PositionStore,
  jupiter?: JupiterClient,
  slippageBps = 300,
  walletGate?: WalletGateConfig,
  detailed = false,
  run?: { since: number; label: string }
): Promise<void> {
  const everything = [...store.all()];
  const positions = run ? everything.filter((p) => inRun(p, run.since)) : everything;
  // Mute status is judged over ALL positions (simulated + real) and every
  // run, exactly as the trader judges it, so the summary never disagrees.
  const muteOf = (wallet: string): WalletMute =>
    walletGate ? walletMute(everything, wallet, Date.now(), walletGate) : { muted: false };

  let marks = new Map<string, Mark>();
  if (jupiter) {
    marks = await markToMarket(positions.filter((p) => p.status === 'open'), jupiter, slippageBps);
  }

  const solPriceUsd = await getSolPriceUsd();

  console.log('\n════════════════ P&L SUMMARY ════════════════');
  if (run) console.log(`This sheet: ${run.label}`);
  if (solPriceUsd !== null) console.log(`SOL price: $${solPriceUsd.toFixed(2)}`);

  if (positions.length === 0) {
    console.log(run ? 'No trades yet this run.' : 'No positions yet.');
  } else {
    printGroup('SIMULATED (dry-run — no real money moved)', positions.filter((p) => p.dryRun), solPriceUsd, marks, muteOf, detailed);
    printGroup('REAL (actual on-chain trades)', positions.filter((p) => !p.dryRun), solPriceUsd, marks, muteOf, detailed);
  }
  if (run) {
    const line = allRunsLine(everything, positions, solPriceUsd);
    if (line) console.log(`\n${line}  (every run: npm run summary -- all)`);
  }
  console.log('═════════════════════════════════════════════\n');
}
