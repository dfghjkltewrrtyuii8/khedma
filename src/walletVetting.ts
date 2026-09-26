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
//   - is it still alive (anything in the last few days)?
//   - does it buy often enough, in the hours it trades, to be worth a slot?
//   - are its buys big enough that the bot copies them (MIN_TRACKED_BUY_SOL)?
//   - does it hold long enough for a copy to catch the move?
//   - over the trades it finished, did it win more than it lost, and net a profit?
//   - is it a machine (transactions faster than a person trades)?
//
// A wallet that passes all of that but hasn't bought for a few hours is
// ASLEEP, not bad: people trade at their own hours. The first version turned
// those away for a week — 12 of 33 rejections in a live run, most of them
// checked overnight. Now they're kept on the bench and brought in when they
// trade again. From the same list of transactions the bot learns each
// wallet's usual hours, so when a slot opens it can pick the wallet most
// likely to be trading at that hour.
//
// Past results don't promise future ones — this only turns away the wallets
// that clearly can't work for a copy bot. What the bot's own copies earn still
// decides after that (proven winners ⭐, drops for losing streaks).

import { Connection, PublicKey } from '@solana/web3.js';
import { RateLimiter } from './rateLimiter';
import { analyzeSwap, MAX_TX_VERSION } from './watcher';

export const VET_RULES = {
  historySignatures: 1000, // one lookup: timestamps only — for its usual hours, and whether it's alive
  hoursWindowDays: 14, // usual hours are learned from this recent stretch
  signatures: 40, // the most recent of those are read in full (one lookup each) to judge its trading
  maxQuietDays: 3, // nothing at all for this long: gone, not asleep
  minBuys: 4, // fewer than this is too little to judge — it's mostly doing something other than trading
  minBuysPerActiveHour: 0.5, // a buy every two hours, counting only the hours it's active
  maxLastBuyAgeHours: 3, // good record but no buy for this long: asleep, kept for later
  maxTxPerHour: 60, // faster than a person trades — and every transaction costs an RPC lookup to watch
  minRoundTrips: 3, // coins it both bought and sold inside the sample
  minMedianHoldMinutes: 3, // quicker flips are over before a copy lands and gets priced
  minWinRate: 0.5,
};

const HOUR_MS = 3_600_000;

// A wallet's usual hours: for each hour of the day (UTC, index 0-23), the
// share of observed days it did something in that hour. null = that hour was
// never covered by its history.
export type HourProfile = (number | null)[];

// Pure: usual hours from transaction timestamps (the last `windowDays`).
export function hourProfile(times: number[], windowDays = VET_RULES.hoursWindowDays): HourProfile | null {
  if (times.length < 2) return null;
  const newest = Math.max(...times);
  const recent = times.filter((t) => t >= newest - windowDays * 24 * HOUR_MS);
  const slots = new Set(recent.map((t) => Math.floor(t / HOUR_MS)));
  const first = Math.floor(Math.min(...recent) / HOUR_MS);
  const last = Math.floor(newest / HOUR_MS);
  const observed = new Array<number>(24).fill(0);
  const active = new Array<number>(24).fill(0);
  for (let slot = first; slot <= last; slot++) {
    const hour = slot % 24; // epoch hours start at 00:00 UTC
    observed[hour] += 1;
    if (slots.has(slot)) active[hour] += 1;
  }
  return observed.map((o, h) => (o > 0 ? active[h] / o : null));
}

// Pure: how likely the wallet is trading at `now`, 0-1 (null: unknown) —
// this hour counts fully, the hours either side half.
export function likelyActive(profile: HourProfile | null | undefined, now: number): number | null {
  if (!profile) return null;
  const h = Math.floor(now / HOUR_MS) % 24;
  let sum = 0;
  let weight = 0;
  for (const [offset, w] of [[-1, 0.5], [0, 1], [1, 0.5]] as const) {
    const share = profile[(h + offset + 24) % 24];
    if (share === null || share === undefined) continue;
    sum += share * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : null;
}

// Pure: its usual hours in YOUR time, e.g. "9pm–2am" (null: not known).
// `offsetMinutes` is how far local time is ahead of UTC.
export function describeHours(profile: HourProfile | null | undefined, offsetMinutes: number): string | null {
  if (!profile || profile.every((s) => s === null)) return null;
  const busy = new Array<boolean>(24).fill(false);
  profile.forEach((share, utc) => {
    if (share !== null && share >= 0.5) busy[(((utc * 60 + offsetMinutes) / 60) % 24 + 24) % 24 | 0] = true;
  });
  if (busy.every(Boolean)) return 'around the clock';
  if (!busy.some(Boolean)) return 'no regular hours yet';
  const clock = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;
  const runs: string[] = [];
  const start = busy.findIndex((b, i) => !b && busy[(i + 1) % 24]) + 1; // begin just after a quiet hour
  for (let i = 0; i < 24; i++) {
    const h = (start + i) % 24;
    if (!busy[h] || busy[(h + 23) % 24]) continue; // not the start of a run
    let end = h;
    while (busy[(end + 1) % 24]) end = (end + 1) % 24;
    runs.push(`${clock(h)}–${clock((end + 1) % 24)}`);
  }
  return runs.join(', ');
}

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
  buysPerActiveHour: number; // buys per clock hour in which it did anything at all
  lastBuyAgeHours: number | null;
  medianBuySol: number | null;
  roundTrips: number;
  wins: number;
  netSol: number;
  medianHoldMinutes: number | null;
}

// pass: copy it. asleep: a good record, but not trading right now — kept on
// the bench until it trades again. fail: turned away.
export type VetStatus = 'pass' | 'asleep' | 'fail';

export interface VetVerdict {
  status: VetStatus;
  reason: string; // why not — or a one-line summary of its record
  stats: VetStats;
  hours: HourProfile | null; // its usual hours (vetWallet fills this in)
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
  const spanHours = (newest - oldest) / HOUR_MS;
  // Rates over at least half an hour, so a short burst doesn't read as a huge rate.
  const rateHours = Math.max(spanHours, 0.5);
  const activeHours = Math.max(1, new Set(txTimes.map((t) => Math.floor(t / HOUR_MS))).size);
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
    buysPerActiveHour: buys.length / activeHours,
    lastBuyAgeHours: lastBuy === null ? null : (now - lastBuy) / 3_600_000,
    medianBuySol: median(buys.filter((b) => b.sol !== null).map((b) => b.sol!)),
    roundTrips: trips.length,
    wins: trips.filter((t) => t.ret > 0).length,
    netSol: trips.reduce((a, t) => a + t.pnl, 0),
    medianHoldMinutes: median(trips.map((t) => t.holdMs / 60_000)),
  };
  const no = (reason: string): VetVerdict => ({ status: 'fail', reason, stats, hours: null });

  const quietDays = (now - newest) / (24 * HOUR_MS);
  if (txTimes.length === 0 || quietDays > rules.maxQuietDays) {
    return no(txTimes.length === 0 ? 'no transactions at all' : `no activity for ${Math.floor(quietDays)} days — gone, not asleep`);
  }
  const txPerHour = txTimes.length / rateHours;
  if (txTimes.length >= 10 && txPerHour > rules.maxTxPerHour) {
    return no(`machine speed: ~${Math.round(txPerHour)} transactions an hour`);
  }
  if (stats.buys < rules.minBuys) return no(`only ${stats.buys} buy(s) in its last ${txTimes.length} transactions — mostly not trading`);
  if (stats.medianBuySol !== null && stats.medianBuySol < minBuySol) {
    return no(`buys are ~${stats.medianBuySol.toFixed(3)} SOL — under MIN_TRACKED_BUY_SOL (${minBuySol}), so they'd all be skipped`);
  }
  if (stats.buysPerActiveHour < rules.minBuysPerActiveHour) {
    return no(`rarely buys: ~${stats.buysPerActiveHour.toFixed(1)} per hour it's active`);
  }
  if (stats.roundTrips < rules.minRoundTrips) return no(`only ${stats.roundTrips} finished trade(s) to judge`);
  if (stats.medianHoldMinutes !== null && stats.medianHoldMinutes < rules.minMedianHoldMinutes) {
    return no(`flips coins in ~${minutesText(stats.medianHoldMinutes)} — over before a copy lands`);
  }
  if (stats.wins / stats.roundTrips < rules.minWinRate) return no(`won only ${stats.wins} of ${stats.roundTrips} finished trades`);
  if (!(stats.netSol > 0)) return no(`lost ${Math.abs(stats.netSol).toFixed(3)} SOL over ${stats.roundTrips} finished trades`);

  const record =
    `${stats.buys} buys in ${stats.spanHours.toFixed(1)}h · ${stats.roundTrips} trades ${stats.wins}W/${stats.roundTrips - stats.wins}L · ` +
    `net +${stats.netSol.toFixed(3)} SOL · holds ~${minutesText(stats.medianHoldMinutes ?? 0)}`;
  if (stats.lastBuyAgeHours !== null && stats.lastBuyAgeHours > rules.maxLastBuyAgeHours) {
    return { status: 'asleep', reason: `asleep — last bought ${stats.lastBuyAgeHours.toFixed(1)}h ago; record: ${record}`, stats, hours: null };
  }
  return { status: 'pass', reason: record, stats, hours: null };
}

// What vetting needs from the RPC — an interface, so it's tested offline.
export type VetConnection = Pick<Connection, 'getSignaturesForAddress' | 'getParsedTransaction'>;

// Read a wallet's recent transactions and judge them. One lookup for up to
// `rules.historySignatures` timestamps (usual hours, alive or not), then one
// per transaction for the most recent `rules.signatures` — paced by the same
// limiter the watcher uses.
export async function vetWallet(
  connection: VetConnection,
  limiter: RateLimiter,
  wallet: string,
  minBuySol: number,
  now: number = Date.now(),
  rules = VET_RULES
): Promise<VetVerdict> {
  const signatures = await limiter.schedule('getSignaturesForAddress', () =>
    connection.getSignaturesForAddress(new PublicKey(wallet), { limit: rules.historySignatures }, 'confirmed')
  );
  const hours = hourProfile(signatures.filter((s) => s.blockTime).map((s) => s.blockTime! * 1000), rules.hoursWindowDays);
  const txTimes: number[] = [];
  const trades: HistoryTrade[] = [];
  for (const s of signatures.slice(0, rules.signatures)) { // newest first
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
  return { ...judgeHistory(txTimes, trades, now, minBuySol, rules), hours };
}
