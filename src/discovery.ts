// Automatic wallet discovery: find new wallets to try, from the trades
// themselves rather than from a leaderboard.
//
// Leaderboards are dominated by launch snipers — wallets whose whole edge is
// being first, which is exactly what can't be copied ten seconds late. (That's
// how this bot ended up copying 71XJ, which lost on 5 of 6 copies.) So instead
// of "who is ranked highest", this asks: on tokens that are moving right now,
// who bought AFTER the launch rush, held for a while, and sold at a profit —
// and did it on more than one token? That filter is built from what failed.
//
// Source: GeckoTerminal's free public API — trending Solana pools, and each
// pool's recent trades with the trading wallet's address. It doesn't use the
// Helius budget. It is a NOISY signal: the free feed only covers each pool's
// most recent trades, so "profitable" means "profitable over the last few
// hours". That's why a discovered wallet is only ever tested on paper first:
// discovery nominates, the paper record decides.
//
// Everything below that isn't a network call is a pure function over plain
// data, so the analysis is tested offline with fixtures. The parsers are
// deliberately tolerant, and the report says where things broke (no pools
// parsed, no trades parsed) rather than quietly finding nothing.

import { PublicKey } from '@solana/web3.js';
import { QUOTE_MINTS } from './config';
import { sleep } from './rateLimiter';

const BASE_URL = 'https://api.geckoterminal.com/api/v2';

// Tuning. Chosen from this bot's own failures, not from theory — see the
// comment on each.
export const DISCOVERY_RULES = {
  trendingPages: 2, // 20 pools per page — what's moving right now
  topPoolPages: 1, // plus the day's biggest pools by volume — older, where multi-hour holds show up
  maxPoolsScanned: 20, // one API call each
  // The free API rate-limits at about 10 calls a minute in practice: a live run
  // paced at 2.5s was cut off after ~9 calls and lost 14 of 20 pools to 429s.
  pauseMs: 6_500,
  rateLimitRetries: 2, // after a 429, wait and retry the same request this many times…
  rateLimitBackoffMs: 45_000, // …this long apart; if it still refuses, stop the scan rather than hammer it
  // Only trades this big are read. The free feed returns a pool's last ~300
  // trades; on a busy pool, small trades fill that in minutes and hide every
  // multi-hour hold. Reading only larger trades makes one page span hours —
  // and serious traders trade that size anyway. History: $25 plus a busy-pool
  // filter kept 3 of 40 pools and found no one; $150 kept 37 pools but each
  // page covered a median 1.8h, and 347 of ~450 wallets couldn't be judged
  // because their buy or sell fell outside it. $250 stretches that further.
  minTradeUsd: 250,
  minPoolReserveUsd: 10_000, // enough depth that a copy can get back out (a copy is a few dollars; $10k absorbs that)
  minPoolAgeMinutes: 25, // the rules below need a buy 15+ min in and a 5+ min hold, so younger pools can't qualify
  sniperWindowMinutes: 15, // a first buy this soon after the pool opened is launch sniping — uncopyable
  // Quicker flips are over before a copy lands (a copy takes seconds). Was 20:
  // in live runs it was the biggest rule that actually judged anyone, turning
  // away 146–233 wallets a scan — too strict for what paper probation and
  // rotation already check with real results.
  minHoldMinutes: 5,
  maxHoldHours: 6, // longer than a session can follow
  minPositionUsd: 50, // below this it's noise
  minReturnPct: 5, // a round trip that didn't clear this isn't evidence of skill (was 10)
  strongSingleReturnPct: 20, // a wallet seen on only one token must have done at least this well (was 30)
  maxTradesPerWalletPerPool: 20, // more in one window is a bot or market maker (was 12 — caught people scaling in and out)
  maxCandidates: 8, // per run; the bench keeps at most 40 discovered wallets
};

export interface PoolInfo {
  address: string;
  baseMint: string;
  name: string;
  createdAt: number; // epoch ms
  reserveUsd: number;
  tradesPerHour: number | null;
}

export interface PoolTrade {
  wallet: string;
  side: 'buy' | 'sell';
  tokenAmount: number;
  usd: number;
  at: number; // epoch ms
}

export interface Candidate {
  wallet: string;
  pools: number; // tokens it round-tripped profitably, after the launch rush
  medianReturnPct: number;
  evidence: string[]; // one line per token, e.g. "WIF: +34%, held 1.8h, bought 2.1h after launch"
}

// Why things were left out, counted — so a run that finds nobody says which
// rule did it, instead of leaving it to guesswork.
export type Tally = Record<string, number>;
const bump = (tally: Tally | undefined, reason: string) => {
  if (tally) tally[reason] = (tally[reason] ?? 0) + 1;
};

// When nobody qualifies, the few that came closest — so the rules can be
// judged against what's actually out there, not loosened blind.
const NEAR_MISSES_SHOWN = 3;

export interface DiscoveryReport {
  poolsFetched: number;
  poolsReadable: number;
  poolsUsable: number;
  poolsScanned: number;
  tradesParsed: number;
  windowHours: number[]; // how much time each scanned pool's trades actually covered
  poolRejects: Tally;
  walletRejects: Tally;
  nearMisses: Candidate[];
  candidates: Candidate[];
  problems: string[];
}

// ------------------------------------------------------------- parsing ---

const num = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
const stripNetwork = (id: unknown): string | null => (typeof id === 'string' && id ? id.replace(/^solana_/, '') : null);

export function parseTrendingPools(body: unknown, rejects?: Tally): PoolInfo[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const pools: PoolInfo[] = [];
  for (const item of data as any[]) {
    const a = item?.attributes ?? {};
    const address = typeof a.address === 'string' ? a.address : stripNetwork(item?.id);
    const baseMint = stripNetwork(item?.relationships?.base_token?.data?.id);
    const quoteMint = stripNetwork(item?.relationships?.quote_token?.data?.id);
    const createdAt = Date.parse(a.pool_created_at ?? '');
    const reserveUsd = num(a.reserve_in_usd);
    if (!address || !baseMint || !Number.isFinite(createdAt) || reserveUsd === null) {
      bump(rejects, 'unreadable');
      continue;
    }
    if (QUOTE_MINTS.has(baseMint)) {
      bump(rejects, 'SOL/USDC on the token side'); // not a memecoin pool
      continue;
    }
    if (quoteMint && !QUOTE_MINTS.has(quoteMint)) {
      bump(rejects, 'priced in another token'); // the bot only copies swaps against SOL/USDC/USDT
      continue;
    }
    const tx = a.transactions ?? {};
    const count = (w: any) => (w ? (num(w.buys) ?? 0) + (num(w.sells) ?? 0) : null);
    const h1 = count(tx.h1);
    const h24 = count(tx.h24);
    pools.push({
      address,
      baseMint,
      name: typeof a.name === 'string' ? a.name : baseMint.slice(0, 6),
      createdAt,
      reserveUsd,
      tradesPerHour: h1 ?? (h24 !== null ? h24 / 24 : null),
    });
  }
  return pools;
}

export function parsePoolTrades(body: unknown, baseMint: string): PoolTrade[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const trades: PoolTrade[] = [];
  for (const item of data as any[]) {
    const a = item?.attributes ?? {};
    const wallet = typeof a.tx_from_address === 'string' ? a.tx_from_address : null;
    const at = Date.parse(a.block_timestamp ?? '');
    const usd = num(a.volume_in_usd);
    let side: 'buy' | 'sell' | null = null;
    let tokenAmount: number | null = null;
    // Decide by which side of the swap the memecoin was on; fall back to `kind`.
    if (a.to_token_address === baseMint) {
      side = 'buy';
      tokenAmount = num(a.to_token_amount);
    } else if (a.from_token_address === baseMint) {
      side = 'sell';
      tokenAmount = num(a.from_token_amount);
    } else if (a.kind === 'buy') {
      side = 'buy';
      tokenAmount = num(a.to_token_amount);
    } else if (a.kind === 'sell') {
      side = 'sell';
      tokenAmount = num(a.from_token_amount);
    }
    if (!wallet || !side || !Number.isFinite(at) || usd === null || !(usd > 0) || tokenAmount === null || !(tokenAmount > 0)) continue;
    trades.push({ wallet, side, tokenAmount, usd, at });
  }
  return trades;
}

// ------------------------------------------------------------ analysis ---

// Pools worth reading: deep enough to exit, and old enough to be past the
// launch rush. Busy pools are kept — minTradeUsd is what stretches their window.
// "12 min" under an hour, "1.8h" above — a 5-minute hold shouldn't read as "0.1h".
function holdText(ms: number): string {
  return ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)}h`;
}

export function selectPools(pools: PoolInfo[], now: number, rules = DISCOVERY_RULES, rejects?: Tally): PoolInfo[] {
  return pools.filter((p) => {
    if (p.reserveUsd < rules.minPoolReserveUsd) {
      bump(rejects, `under $${rules.minPoolReserveUsd.toLocaleString('en-US')} liquidity`);
      return false;
    }
    if (now - p.createdAt < rules.minPoolAgeMinutes * 60_000) {
      bump(rejects, `under ${rules.minPoolAgeMinutes} min old`);
      return false;
    }
    return true;
  });
}

function isPersonalWallet(address: string): boolean {
  try {
    return PublicKey.isOnCurve(new PublicKey(address).toBytes());
  } catch {
    return false;
  }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export function findCandidates(
  pools: PoolInfo[],
  tradesByPool: Map<string, PoolTrade[]>,
  exclude: Set<string>,
  rules = DISCOVERY_RULES,
  rejects?: Tally,
  nearMisses?: Candidate[]
): Candidate[] {
  const hits = new Map<string, { returns: number[]; evidence: string[]; pools: string[] }>();

  for (const pool of pools) {
    const byWallet = new Map<string, PoolTrade[]>();
    for (const t of tradesByPool.get(pool.address) ?? []) {
      if (!byWallet.has(t.wallet)) byWallet.set(t.wallet, []);
      byWallet.get(t.wallet)!.push(t);
    }
    for (const [wallet, trades] of byWallet) {
      const reject = (reason: string) => bump(rejects, reason);
      if (exclude.has(wallet)) { reject('already known to the bot'); continue; }
      if (trades.length > rules.maxTradesPerWalletPerPool) { reject('bot (too many trades)'); continue; }
      const buys = trades.filter((t) => t.side === 'buy');
      if (buys.length === 0) { reject('only sold (bought before the window)'); continue; }
      const firstBuy = Math.min(...buys.map((t) => t.at));
      const sells = trades.filter((t) => t.side === 'sell' && t.at > firstBuy);
      if (sells.length === 0) { reject('bought, not sold yet'); continue; }
      if (firstBuy - pool.createdAt < rules.sniperWindowMinutes * 60_000) { reject('launch sniper'); continue; }
      const holdMs = Math.min(...sells.map((t) => t.at)) - firstBuy;
      if (holdMs < rules.minHoldMinutes * 60_000) { reject(`held under ${rules.minHoldMinutes} min`); continue; }
      if (holdMs > rules.maxHoldHours * 3_600_000) { reject(`held over ${rules.maxHoldHours} h`); continue; }
      const buyUsd = buys.reduce((a, t) => a + t.usd, 0);
      if (buyUsd < rules.minPositionUsd) { reject(`position under $${rules.minPositionUsd}`); continue; }
      const avgBuy = buyUsd / buys.reduce((a, t) => a + t.tokenAmount, 0);
      const avgSell = sells.reduce((a, t) => a + t.usd, 0) / sells.reduce((a, t) => a + t.tokenAmount, 0);
      const returnPct = (avgSell / avgBuy - 1) * 100;
      if (!(returnPct >= 0)) { reject('lost money'); continue; }
      if (!(returnPct >= rules.minReturnPct)) { reject(`gained under +${rules.minReturnPct}%`); continue; }
      if (!hits.has(wallet)) hits.set(wallet, { returns: [], evidence: [], pools: [] });
      const h = hits.get(wallet)!;
      h.returns.push(returnPct);
      h.pools.push(pool.address);
      h.evidence.push(
        `${pool.name}: ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(0)}%, held ${holdText(holdMs)}, ` +
          `bought ${((firstBuy - pool.createdAt) / 3_600_000).toFixed(1)}h after launch`
      );
    }
  }

  const all = [...hits.entries()]
    .filter(([wallet]) => isPersonalWallet(wallet) || (bump(rejects, 'not a personal wallet'), false))
    .map(([wallet, h]) => ({ wallet, pools: h.returns.length, medianReturnPct: median(h.returns), evidence: h.evidence, hitPools: h.pools }));
  const proven = all
    .filter((c) => c.pools >= 2)
    .sort((a, b) => b.pools - a.pools || b.medianReturnPct - a.medianReturnPct);
  // Few wallets complete profitable round trips on two trending tokens inside
  // a few hours. So a single-token wallet may fill the remaining places, but
  // only with a clearly strong result — and it still has to prove itself on paper.
  //
  // And at most ONE per token. When a token pumps, everyone who held it looks
  // skilled: a live run returned five wallets, all from the same token, all of
  // whom sold within the same half hour — one pump, not five traders. So only
  // the best wallet from each token gets a place.
  const takenTokens = new Set<string>();
  const single = all
    .filter((c) => c.pools === 1 && c.medianReturnPct >= rules.strongSingleReturnPct)
    .sort((a, b) => b.medianReturnPct - a.medianReturnPct)
    .filter((c) => {
      const token = c.hitPools[0];
      if (takenTokens.has(token)) {
        bump(rejects, 'same token as a better pick (one pump, not skill)');
        return false;
      }
      takenTokens.add(token);
      return true;
    });
  const weakSingles = all
    .filter((c) => c.pools === 1 && c.medianReturnPct < rules.strongSingleReturnPct)
    .sort((a, b) => b.medianReturnPct - a.medianReturnPct);
  for (let i = 0; i < weakSingles.length; i++) bump(rejects, `one token only, under +${rules.strongSingleReturnPct}%`);
  if (nearMisses) {
    nearMisses.push(
      ...weakSingles.slice(0, NEAR_MISSES_SHOWN).map(({ wallet, pools, medianReturnPct, evidence }) => ({ wallet, pools, medianReturnPct, evidence }))
    );
  }
  return [...proven, ...single]
    .slice(0, rules.maxCandidates)
    .map(({ wallet, pools, medianReturnPct, evidence }) => ({ wallet, pools, medianReturnPct, evidence }));
}

// ------------------------------------------------------------- network ---

export type FetchJson = (url: string) => Promise<unknown>;

export const fetchGeckoTerminal: FetchJson = async (url) => {
  const response = await fetch(url, {
    headers: { accept: 'application/json;version=20230302' },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 429) throw new Error('GeckoTerminal rate limit (429) — too many requests; try again in a minute');
  if (!response.ok) throw new Error(`GeckoTerminal HTTP ${response.status}`);
  return response.json();
};

class RateLimited extends Error {}

// A request that waits and retries on 429. If it's still refused after the
// retries, throws RateLimited so the caller stops the scan instead of burning
// through the rest of the list getting refused.
async function fetchPolitely(
  fetchJson: FetchJson,
  url: string,
  pause: (ms: number) => Promise<void>,
  rules: typeof DISCOVERY_RULES
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchJson(url);
    } catch (error) {
      const limited = /\b429\b|rate limit/i.test((error as Error).message);
      if (!limited) throw error;
      if (attempt >= rules.rateLimitRetries) throw new RateLimited((error as Error).message);
      await pause(rules.rateLimitBackoffMs);
    }
  }
}

// One discovery run: ~23 API calls paced for the free tier, a few minutes.
// Never throws — problems are returned in the report so the caller can say
// exactly what went wrong.
export async function discoverWallets(
  exclude: Set<string>,
  now: number = Date.now(),
  fetchJson: FetchJson = fetchGeckoTerminal,
  pause: (ms: number) => Promise<void> = sleep,
  rules = DISCOVERY_RULES
): Promise<DiscoveryReport> {
  const report: DiscoveryReport = {
    poolsFetched: 0, poolsReadable: 0, poolsUsable: 0, poolsScanned: 0, tradesParsed: 0,
    windowHours: [], poolRejects: {}, walletRejects: {}, nearMisses: [], candidates: [], problems: [],
  };
  const pools: PoolInfo[] = [];
  let pagesRead = 0;
  const listings = [
    ...Array.from({ length: rules.trendingPages }, (_, i) => ({ label: `trending pools page ${i + 1}`, url: `${BASE_URL}/networks/solana/trending_pools?page=${i + 1}` })),
    ...Array.from({ length: rules.topPoolPages }, (_, i) => ({ label: `top pools page ${i + 1}`, url: `${BASE_URL}/networks/solana/pools?page=${i + 1}&sort=h24_volume_usd_desc` })),
  ];
  let stopped = false;
  for (const listing of listings) {
    try {
      const body = await fetchPolitely(fetchJson, listing.url, pause, rules);
      pagesRead += 1;
      const raw = Array.isArray((body as any)?.data) ? (body as any).data.length : 0;
      report.poolsFetched += raw;
      for (const p of parseTrendingPools(body, report.poolRejects)) {
        if (pools.some((q) => q.address === p.address)) continue; // on both lists
        pools.push(p);
      }
    } catch (error) {
      report.problems.push(`${listing.label}: ${(error as Error).message}`);
      if (error instanceof RateLimited) {
        stopped = true;
        break;
      }
    }
    await pause(rules.pauseMs);
  }
  report.poolsReadable = pools.length;
  if (pagesRead > 0 && report.poolsFetched > 0 && pools.length === 0) {
    report.problems.push('trending pools came back but none could be read — GeckoTerminal may have changed its response format');
  }

  const usable = selectPools(pools, now, rules, report.poolRejects);
  report.poolsUsable = usable.length;
  const tradesByPool = new Map<string, PoolTrade[]>();
  let tradePagesWithData = 0;
  for (const pool of stopped ? [] : usable.slice(0, rules.maxPoolsScanned)) {
    try {
      const body = await fetchPolitely(
        fetchJson,
        `${BASE_URL}/networks/solana/pools/${pool.address}/trades?trade_volume_in_usd_greater_than=${rules.minTradeUsd}`,
        pause,
        rules
      );
      const trades = parsePoolTrades(body, pool.baseMint);
      if (Array.isArray((body as any)?.data) && (body as any).data.length > 0) tradePagesWithData += 1;
      tradesByPool.set(pool.address, trades);
      report.tradesParsed += trades.length;
      if (trades.length > 1) {
        const times = trades.map((t) => t.at);
        report.windowHours.push((Math.max(...times) - Math.min(...times)) / 3_600_000);
      }
      report.poolsScanned += 1;
    } catch (error) {
      report.problems.push(`trades for ${pool.name}: ${(error as Error).message}`);
      if (error instanceof RateLimited) {
        stopped = true;
        break;
      }
    }
    await pause(rules.pauseMs);
  }
  if (stopped) {
    report.problems.push(
      `GeckoTerminal kept refusing (rate limit), so the scan stopped after ${report.poolsScanned} pool(s) — ` +
        'what was read is still used. Try again in a few minutes.'
    );
  }
  if (tradePagesWithData > 0 && report.tradesParsed === 0) {
    report.problems.push('trades came back but none could be read — GeckoTerminal may have changed its trade format');
  }

  report.candidates = findCandidates(usable, tradesByPool, exclude, rules, report.walletRejects, report.nearMisses);
  return report;
}

export function printDiscoveryReport(report: DiscoveryReport, log: (line: string) => void = console.log): void {
  const tally = (t: Tally) =>
    Object.entries(t)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${n} ${reason}`)
      .join(', ');
  log(
    `🔎 Discovery: ${report.poolsFetched} pools listed, ${report.poolsReadable} readable, ${report.poolsUsable} usable, ` +
      `${report.poolsScanned} scanned, ${report.tradesParsed} trades read → ${report.candidates.length} candidate(s)`
  );
  if (Object.keys(report.poolRejects).length) log(`   pools left out: ${tally(report.poolRejects)}`);
  if (report.windowHours.length) {
    const w = [...report.windowHours].sort((a, b) => a - b);
    log(`   each pool's trades covered ${w[0].toFixed(1)}h to ${w[w.length - 1].toFixed(1)}h (median ${w[Math.floor(w.length / 2)].toFixed(1)}h)`);
  }
  if (Object.keys(report.walletRejects).length) log(`   wallets left out: ${tally(report.walletRejects)}`);
  for (const c of report.candidates) {
    log(`   • ${c.wallet} — ${c.pools} token(s), median ${c.medianReturnPct >= 0 ? '+' : ''}${c.medianReturnPct.toFixed(0)}%`);
    for (const e of c.evidence) log(`       ${e}`);
  }
  if (report.candidates.length === 0 && report.nearMisses.length) {
    log('   closest this time (not enough to pick):');
    for (const m of report.nearMisses) log(`     ${m.wallet.slice(0, 4)}…${m.wallet.slice(-4)} — ${m.evidence[0]}`);
  }
  for (const p of report.problems) log(`   ⚠️ ${p}`);
}
