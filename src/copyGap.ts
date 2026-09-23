// Timing or wallet? The question every losing copy trade raises.
//
// A copy can lose for two different reasons, and they need opposite fixes:
//   1. The wallet's picks lose — nothing you do about speed will help; you
//      need a different wallet.
//   2. The wallet's picks win, but you arrive late and pay more (and exit
//      later) — that is timing, and only faster infrastructure or slower-
//      moving wallets fix it.
//
// The bot sees both sides of every trade it copies: what the tracked wallet
// paid and received (from its own transactions), and what we paid and
// received. Comparing them PER TOKEN separates the two cases with data
// instead of opinion.
//
// One honest bias: the tracked wallet's SOL figures include its own network
// fees (and, on a first buy, token-account rent). That makes their entry look
// slightly worse than it was, so the entry gap shown here is, if anything, an
// UNDER-estimate of how much later we get in.

import { Position } from './types';

export interface CopyComparison {
  ourReturnPct: number | null; // what we made per SOL spent, closed positions only
  theirReturnPct: number | null; // their exit price vs their entry price on the same token
  entryGapPct: number | null; // how much more per token we paid than they did
}

function priceOf(sol: number | undefined, raw: string | undefined): number | null {
  if (sol === undefined || raw === undefined || !(sol > 0)) return null;
  const units = Number(BigInt(raw));
  return units > 0 ? sol / units : null;
}

export function compareToSource(p: Position): CopyComparison {
  const theirEntry = priceOf(p.sourceBuySol, p.sourceBuyTokensRaw);
  const theirExit = priceOf(p.sourceSellSol, p.sourceSellTokensRaw);
  const ourEntry = priceOf(p.spentSol, p.initialTokenAmountRaw);
  return {
    ourReturnPct: p.status === 'closed' && p.spentSol > 0 ? ((p.receivedSol - p.spentSol) / p.spentSol) * 100 : null,
    theirReturnPct: theirEntry !== null && theirExit !== null ? (theirExit / theirEntry - 1) * 100 : null,
    entryGapPct: theirEntry !== null && ourEntry !== null ? (ourEntry / theirEntry - 1) * 100 : null,
  };
}

export interface WalletComparison {
  comparable: number; // closed positions where both returns are known
  ourAvgPct: number | null;
  theirAvgPct: number | null;
  entryGapAvgPct: number | null;
  verdict: string | null; // only once there is enough data to say anything
}

const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(0)}%`;

// "your entry price was 25% above theirs" / "…8% below theirs"
export function entryPhrase(gapPct: number): string {
  return `your entry price was ${Math.abs(gapPct).toFixed(0)}% ${gapPct >= 0 ? 'above' : 'below'} theirs`;
}

export function summarizeComparisons(positions: readonly Position[], minForVerdict = 5): WalletComparison {
  const ours: number[] = [];
  const theirs: number[] = [];
  const gaps: number[] = [];
  for (const p of positions) {
    const c = compareToSource(p);
    if (c.entryGapPct !== null) gaps.push(c.entryGapPct);
    if (c.ourReturnPct !== null && c.theirReturnPct !== null) {
      ours.push(c.ourReturnPct);
      theirs.push(c.theirReturnPct);
    }
  }
  const ourAvgPct = avg(ours);
  const theirAvgPct = avg(theirs);
  const entryGapAvgPct = avg(gaps);

  let verdict: string | null = null;
  if (ours.length >= minForVerdict && ourAvgPct !== null && theirAvgPct !== null) {
    if (theirAvgPct <= 0) {
      verdict = `they LOST on these same tokens too (${pct(theirAvgPct)}) — it's the wallet, and no speed upgrade fixes that`;
    } else if (ourAvgPct < theirAvgPct) {
      verdict =
        `their picks made ${pct(theirAvgPct)}, your copies ${pct(ourAvgPct)} — the picks are fine, you lose it in execution` +
        (entryGapAvgPct !== null && entryGapAvgPct > 0 ? ` — on average ${entryPhrase(entryGapAvgPct)}, and that part is timing` : '');
    } else {
      verdict = `your copies are keeping up with them (${pct(ourAvgPct)} vs ${pct(theirAvgPct)})`;
    }
  }
  return { comparable: ours.length, ourAvgPct, theirAvgPct, entryGapAvgPct, verdict };
}
