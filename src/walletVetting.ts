// Vetting: before a wallet the scanner found gets a copy slot, read its OWN
// recent trades and check it's worth copying at all.
//
// Discovery nominates wallets from one or two profitable round trips on
// trending tokens over a few hours — a noisy signal. Live runs showed what it
// misses: most picks hardly bought anything (4 of 6 copied wallets made no buy
// in an hour, so their slots sat idle), and some flipped coins in and out
// within a couple of minutes — faster than a copy can follow (their +3%, our
// copy -15%). A wallet's own history answers both, so each one's last few dozen
// transactions are read and judged on:
//
//   - does it buy often enough to be worth a slot, and still now?
//   - are its buys big enough that the bot copies them (MIN_TRACKED_BUY_SOL)?
//   - does it hold long enough for a copy to catch the move?
//   - over the trades it finished, did it win more than it lost, and net a profit?
//   - is it a machine (transactions faster than a person trades)?
//
// Past results don't promise future ones — this only turns away the wallets
// that clearly can't work for a copy bot. What the bot's own copies earn still
// decides after that (proven winners ⭐, drops for losing streaks).

import { Connection, PublicKey } from '@solana/web3.js';
import { RateLimiter } from './rateLimiter';
import { analyzeSwap, MAX_TX_VERSION } from './watcher';

export const VET_RULES = {
  signatures: 40, // recent transactions read per wallet: one lookup for the list, one per transaction
  minBuys: 4, // fewer than this is too little to judge
  minBuysPerHour: 1, // over the stretch those transactions cover — a quiet wallet leaves its slot idle
  maxLastBuyAgeHours: 3, // and it must still be at it
  maxTxPerHour: 60, // faster than a person trades — and every transaction costs an RPC lookup to watch
  minRoundTrips: 3, // coins it both bought and sold inside the sample
  minMedianHoldMinutes: 3, // quicker flips are over before a copy lands and gets priced
  minWinRate: 0.5,
};

export interface HistoryTrade {
  side: 'buy' | 'sell';
  mint: string;
  sol: number | null; // what it paid or received, in SOL (null: couldn't be estimated)
  tokenRaw: bigint;
  at: number; // epoch ms
}

export interface VetStats {
  transactions: number;
  spanHours: number; // how much time those transactions cover
  buys: number;
  buysPerHour: number;
  lastBuyAgeHours: number | null;
  medianBuySol: number | null;
  roundTrips: number;
  wins: number;
  netSol: number;
  medianHoldMinutes: number | null;
}

export interface VetVerdict {
  ok: boolean;
  reason: string; // why not — or, when ok, a one-line summary
  stats: VetStats;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

function minutesText(minutes: number): string {
  return minutes < 60 ? `${Math.max(1, Math.round(minutes))} min` : `${(minutes / 60).toFixed(1)}h`;
}

// Pure: judge a wallet from its recent transactions. `txTimes` covers every
// transaction read (swaps or not); `trades` is the swaps among them.
export function judgeHistory(
  txTimes: number[],
  trades: HistoryTrade[],
  now: number,
  minBuySol: number,
  rules = VET_RULES
): VetVerdict {
  const oldest = txTimes.length ? Math.min(...txTimes) : now;
  const newest = txTimes.length ? Math.max(...txTimes) : now;
  const spanHours = (newest - oldest) / 3_600_000;
  // Rates over at least half an hour, so a short burst doesn't read as a huge rate.
  const rateHours = Math.max(spanHours, 0.5);
  const ordered = [...trades].sort((a, b) => a.at - b.at);
  const buys = ordered.filter((t) => t.side === 'buy');
  const lastBuy = buys.length ? buys[buys.length - 1].at : null;

  // Round trips per coin: from the first buy until at least 90% of what it
  // bought is sold again. Trips with a trade of unknown size are left out.
  const trips: { ret: number; pnl: number; holdMs: number }[] = [];
  const open = new Map<string, { tokens: bigint; peak: bigint; solIn: number; solOut: number; firstBuy: number; firstSell: number | null; known: boolean }>();
  for (const t of ordered) {
    let trip = open.get(t.mint);
    if (t.side === 'buy') {
      if (!trip) {
        trip = { tokens: 0n, peak: 0n, solIn: 0, solOut: 0, firstBuy: t.at, firstSell: null, known: true };
        open.set(t.mint, trip);
      }
      trip.tokens += t.tokenRaw;
      if (trip.tokens > trip.peak) trip.peak = trip.tokens;
      if (t.sol === null) trip.known = false;
      else trip.solIn += t.sol;
      continue;
    }
    if (!trip) continue; // bought before the sample began
    trip.tokens = trip.tokens > t.tokenRaw ? trip.tokens - t.tokenRaw : 0n;
    if (t.sol === null) trip.known = false;
    else trip.solOut += t.sol;
    trip.firstSell ??= t.at;
    if (trip.tokens * 10n <= trip.peak) {
      if (trip.known && trip.solIn > 0) {
        trips.push({ ret: trip.solOut / trip.solIn - 1, pnl: trip.solOut - trip.solIn, holdMs: trip.firstSell - trip.firstBuy });
      }
      open.delete(t.mint);
    }
  }

  const stats: VetStats = {
    transactions: txTimes.length,
    spanHours,
    buys: buys.length,
    buysPerHour: buys.length / rateHours,
    lastBuyAgeHours: lastBuy === null ? null : (now - lastBuy) / 3_600_000,
    medianBuySol: median(buys.filter((b) => b.sol !== null).map((b) => b.sol!)),
    roundTrips: trips.length,
    wins: trips.filter((t) => t.ret > 0).length,
    netSol: trips.reduce((a, t) => a + t.pnl, 0),
    medianHoldMinutes: median(trips.map((t) => t.holdMs / 60_000)),
  };
  const no = (reason: string): VetVerdict => ({ ok: false, reason, stats });

  const txPerHour = txTimes.length / rateHours;
  if (txTimes.length >= 10 && txPerHour > rules.maxTxPerHour) {
    return no(`machine speed: ~${Math.round(txPerHour)} transactions an hour`);
  }
  if (stats.buys < rules.minBuys) return no(`only ${stats.buys} buy(s) in its last ${txTimes.length} transactions`);
  if (stats.lastBuyAgeHours !== null && stats.lastBuyAgeHours > rules.maxLastBuyAgeHours) {
    return no(`hasn't bought for ${stats.lastBuyAgeHours.toFixed(1)}h`);
  }
  if (stats.buysPerHour < rules.minBuysPerHour) return no(`too quiet: ~${stats.buysPerHour.toFixed(1)} buys an hour`);
  if (stats.medianBuySol !== null && stats.medianBuySol < minBuySol) {
    return no(`buys are ~${stats.medianBuySol.toFixed(3)} SOL — under MIN_TRACKED_BUY_SOL (${minBuySol}), so they'd all be skipped`);
  }
  if (stats.roundTrips < rules.minRoundTrips) return no(`only ${stats.roundTrips} finished trade(s) to judge`);
  if (stats.medianHoldMinutes !== null && stats.medianHoldMinutes < rules.minMedianHoldMinutes) {
    return no(`flips coins in ~${minutesText(stats.medianHoldMinutes)} — over before a copy lands`);
  }
  if (stats.wins / stats.roundTrips < rules.minWinRate) return no(`won only ${stats.wins} of ${stats.roundTrips} finished trades`);
  if (!(stats.netSol > 0)) return no(`lost ${Math.abs(stats.netSol).toFixed(3)} SOL over ${stats.roundTrips} finished trades`);

  return {
    ok: true,
    reason:
      `${stats.buys} buys in ${stats.spanHours.toFixed(1)}h · ${stats.roundTrips} trades ${stats.wins}W/${stats.roundTrips - stats.wins}L · ` +
      `net +${stats.netSol.toFixed(3)} SOL · holds ~${minutesText(stats.medianHoldMinutes ?? 0)}`,
    stats,
  };
}

// What vetting needs from the RPC — an interface, so it's tested offline.
export type VetConnection = Pick<Connection, 'getSignaturesForAddress' | 'getParsedTransaction'>;

// Read a wallet's recent transactions and judge them. About `rules.signatures`
// + 1 RPC lookups, paced by the same limiter the watcher uses.
export async function vetWallet(
  connection: VetConnection,
  limiter: RateLimiter,
  wallet: string,
  minBuySol: number,
  now: number = Date.now(),
  rules = VET_RULES
): Promise<VetVerdict> {
  const signatures = await limiter.schedule('getSignaturesForAddress', () =>
    connection.getSignaturesForAddress(new PublicKey(wallet), { limit: rules.signatures }, 'confirmed')
  );
  const txTimes: number[] = [];
  const trades: HistoryTrade[] = [];
  for (const s of signatures) {
    if (!s.blockTime) continue;
    const at = s.blockTime * 1000;
    txTimes.push(at);
    if (s.err !== null) continue; // failed: changed nothing
    const tx = await limiter.schedule('getParsedTransaction', () =>
      connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: 'confirmed' })
    );
    if (!tx?.meta) continue;
    const event = await analyzeSwap(tx, s.signature, wallet, true);
    if (event) trades.push({ side: event.side, mint: event.mint, sol: event.quoteSolEquivalent, tokenRaw: event.tokenDeltaRaw, at });
  }
  return judgeHistory(txTimes, trades, now, minBuySol, rules);
}
