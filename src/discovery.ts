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
  trendingPages: 2, // 20 pools per page
  maxPoolsScanned: 15, // one API call each
  pauseMs: 2_500, // the free API allows ~30 calls/min; stay well under
  minTradeUsd: 25, // ignore dust and bot noise (also stretches the time window each page covers)
  minPoolReserveUsd: 20_000, // enough depth that a copy can get back out
  minPoolAgeMinutes: 60, // younger pools are still launch-rush trading
  maxTradesPerHour: 150, // busier than this and one page of trades covers too little time to see a 30-minute hold
  sniperWindowMinutes: 15, // a first buy this soon after the pool opened is launch sniping — uncopyable
  minHoldMinutes: 20, // quicker flips are over before a copy lands
  maxHoldHours: 6, // longer than a session can follow
  minPositionUsd: 50, // below this it's noise
  minReturnPct: 10, // a round trip that didn't clear this isn't evidence of skill
  strongSingleReturnPct: 30, // a wallet seen on only one token must have done at least this well
  maxTradesPerWalletPerPool: 12, // more in one window is a bot or market maker
  maxCandidates: 5,
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

export interface DiscoveryReport {
  poolsFetched: number;
  poolsUsable: number;
  poolsScanned: number;
  tradesParsed: number;
  candidates: Candidate[];
  problems: string[];
}

// ------------------------------------------------------------- parsing ---

const num = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
const stripNetwork = (id: unknown): string | null => (typeof id === 'string' && id ? id.replace(/^solana_/, '') : null);

export function parseTrendingPools(body: unknown): PoolInfo[] {
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
    if (!address || !baseMint || !Number.isFinite(createdAt) || reserveUsd === null) continue;
    if (QUOTE_MINTS.has(baseMint)) continue; // the "token" side is SOL/USDC — not a memecoin pool
    if (quoteMint && !QUOTE_MINTS.has(quoteMint)) continue; // the bot only copies swaps against SOL/USDC/USDT
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

// Pools worth reading: deep enough, past the launch rush, and quiet enough that
// one page of trades spans hours rather than minutes.
export function selectPools(pools: PoolInfo[], now: number, rules = DISCOVERY_RULES): PoolInfo[] {
  return pools.filter(
    (p) =>
      p.reserveUsd >= rules.minPoolReserveUsd &&
      now - p.createdAt >= rules.minPoolAgeMinutes * 60_000 &&
      (p.tradesPerHour === null || p.tradesPerHour <= rules.maxTradesPerHour)
  );
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
  rules = DISCOVERY_RULES
): Candidate[] {
  const hits = new Map<string, { returns: number[]; evidence: string[] }>();

  for (const pool of pools) {
    const byWallet = new Map<string, PoolTrade[]>();
    for (const t of tradesByPool.get(pool.address) ?? []) {
      if (!byWallet.has(t.wallet)) byWallet.set(t.wallet, []);
      byWallet.get(t.wallet)!.push(t);
    }
    for (const [wallet, trades] of byWallet) {
      if (exclude.has(wallet)) continue;
      if (trades.length > rules.maxTradesPerWalletPerPool) continue; // bot / market maker
      const buys = trades.filter((t) => t.side === 'buy');
      if (buys.length === 0) continue;
      const firstBuy = Math.min(...buys.map((t) => t.at));
      const sells = trades.filter((t) => t.side === 'sell' && t.at > firstBuy);
      if (sells.length === 0) continue; // no completed round trip in the window
      if (firstBuy - pool.createdAt < rules.sniperWindowMinutes * 60_000) continue; // launch sniping
      const holdMs = Math.min(...sells.map((t) => t.at)) - firstBuy;
      if (holdMs < rules.minHoldMinutes * 60_000 || holdMs > rules.maxHoldHours * 3_600_000) continue;
      const buyUsd = buys.reduce((a, t) => a + t.usd, 0);
      if (buyUsd < rules.minPositionUsd) continue;
      const avgBuy = buyUsd / buys.reduce((a, t) => a + t.tokenAmount, 0);
      const avgSell = sells.reduce((a, t) => a + t.usd, 0) / sells.reduce((a, t) => a + t.tokenAmount, 0);
      const returnPct = (avgSell / avgBuy - 1) * 100;
      if (!(returnPct >= rules.minReturnPct)) continue;
      if (!hits.has(wallet)) hits.set(wallet, { returns: [], evidence: [] });
      const h = hits.get(wallet)!;
      h.returns.push(returnPct);
      h.evidence.push(
        `${pool.name}: ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(0)}%, held ${(holdMs / 3_600_000).toFixed(1)}h, ` +
          `bought ${((firstBuy - pool.createdAt) / 3_600_000).toFixed(1)}h after launch`
      );
    }
  }

  const all = [...hits.entries()]
    .filter(([wallet]) => isPersonalWallet(wallet))
    .map(([wallet, h]) => ({ wallet, pools: h.returns.length, medianReturnPct: median(h.returns), evidence: h.evidence }));
  const proven = all
    .filter((c) => c.pools >= 2)
    .sort((a, b) => b.pools - a.pools || b.medianReturnPct - a.medianReturnPct);
  // Few wallets complete profitable round trips on two trending tokens inside
  // a few hours. So a single-token wallet may fill the remaining places, but
  // only with a clearly strong result — and it still has to prove itself on paper.
  const single = all
    .filter((c) => c.pools === 1 && c.medianReturnPct >= rules.strongSingleReturnPct)
    .sort((a, b) => b.medianReturnPct - a.medianReturnPct);
  return [...proven, ...single].slice(0, rules.maxCandidates);
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

// One discovery run: ~17 API calls, about 45 seconds. Never throws — problems
// are returned in the report so the caller can say exactly what went wrong.
export async function discoverWallets(
  exclude: Set<string>,
  now: number = Date.now(),
  fetchJson: FetchJson = fetchGeckoTerminal,
  pause: (ms: number) => Promise<void> = sleep,
  rules = DISCOVERY_RULES
): Promise<DiscoveryReport> {
  const report: DiscoveryReport = { poolsFetched: 0, poolsUsable: 0, poolsScanned: 0, tradesParsed: 0, candidates: [], problems: [] };
  const pools: PoolInfo[] = [];
  let pagesRead = 0;
  for (let page = 1; page <= rules.trendingPages; page++) {
    try {
      const body = await fetchJson(`${BASE_URL}/networks/solana/trending_pools?page=${page}`);
      pagesRead += 1;
      const parsed = parseTrendingPools(body);
      const raw = Array.isArray((body as any)?.data) ? (body as any).data.length : 0;
      report.poolsFetched += raw;
      pools.push(...parsed.filter((p) => !pools.some((q) => q.address === p.address)));
    } catch (error) {
      report.problems.push(`trending pools page ${page}: ${(error as Error).message}`);
    }
    await pause(rules.pauseMs);
  }
  if (pagesRead > 0 && report.poolsFetched > 0 && pools.length === 0) {
    report.problems.push('trending pools came back but none could be read — GeckoTerminal may have changed its response format');
  }

  const usable = selectPools(pools, now, rules);
  report.poolsUsable = usable.length;
  const tradesByPool = new Map<string, PoolTrade[]>();
  let tradePagesWithData = 0;
  for (const pool of usable.slice(0, rules.maxPoolsScanned)) {
    try {
      const body = await fetchJson(
        `${BASE_URL}/networks/solana/pools/${pool.address}/trades?trade_volume_in_usd_greater_than=${rules.minTradeUsd}`
      );
      const trades = parsePoolTrades(body, pool.baseMint);
      if (Array.isArray((body as any)?.data) && (body as any).data.length > 0) tradePagesWithData += 1;
      tradesByPool.set(pool.address, trades);
      report.tradesParsed += trades.length;
      report.poolsScanned += 1;
    } catch (error) {
      report.problems.push(`trades for ${pool.name}: ${(error as Error).message}`);
    }
    await pause(rules.pauseMs);
  }
  if (tradePagesWithData > 0 && report.tradesParsed === 0) {
    report.problems.push('trades came back but none could be read — GeckoTerminal may have changed its trade format');
  }

  report.candidates = findCandidates(usable, tradesByPool, exclude, rules);
  return report;
}

export function printDiscoveryReport(report: DiscoveryReport, log: (line: string) => void = console.log): void {
  log(
    `🔎 Discovery: ${report.poolsFetched} trending pools, ${report.poolsUsable} usable, ${report.poolsScanned} scanned, ` +
      `${report.tradesParsed} trades read → ${report.candidates.length} candidate(s)`
  );
  for (const c of report.candidates) {
    log(`   • ${c.wallet} — ${c.pools} token(s), median ${c.medianReturnPct >= 0 ? '+' : ''}${c.medianReturnPct.toFixed(0)}%`);
    for (const e of c.evidence) log(`       ${e}`);
  }
  for (const p of report.problems) log(`   ⚠️ ${p}`);
}
