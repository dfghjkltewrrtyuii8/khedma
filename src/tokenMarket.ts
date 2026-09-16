// Token quality gate: before copying a buy, ask "is this token old enough and
// liquid enough to get back OUT of?"
//
// Every real loss in this bot's history was a token minutes old with thin
// liquidity: by the time the copy landed (5–15s after the tracked wallet), the
// entry was already the top, and the exit found no depth. This gate refuses
// those up front. It costs one Dexscreener lookup per candidate (free, no key,
// and separate from the Jupiter budget) and is deliberately FAIL-CLOSED: a
// token with no market data yet is treated as too new, and a lookup that
// errors is treated as unknown — the bot skips rather than guesses.
//
// Both thresholds set to 0 disable the gate entirely (no lookup is made).

import { Config } from './config';

export interface TokenMarket {
  ageMinutes: number | null; // null = not listed on any DEX yet
  liquidityUsd: number | null; // null = unknown
  source: string; // where the numbers came from, for the log line
}

// Resolves to null when the lookup itself failed (network, timeout, bad response).
export type MarketSource = (mint: string) => Promise<TokenMarket | null>;

export type TokenGateConfig = Pick<Config, 'minTokenAgeMinutes' | 'minLiquidityUsd'>;

export type TokenVerdict = { ok: true; note: string } | { ok: false; reason: string };

export function tokenGateEnabled(config: TokenGateConfig): boolean {
  return config.minTokenAgeMinutes > 0 || config.minLiquidityUsd > 0;
}

function describeAge(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 24 * 60) return `${(minutes / 60).toFixed(1)} h`;
  return `${(minutes / (24 * 60)).toFixed(1)} days`;
}

function usd(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

// Pure: the verdict for one token against the configured thresholds.
export function evaluateToken(market: TokenMarket | null, config: TokenGateConfig): TokenVerdict {
  if (!tokenGateEnabled(config)) return { ok: true, note: 'token filters off' };
  if (market === null) return { ok: false, reason: 'market data unavailable right now — not buying blind' };
  if (market.ageMinutes === null) {
    return {
      ok: false,
      reason:
        market.liquidityUsd === null
          ? `not listed on any DEX yet (${market.source}) — too new`
          : 'listing age unknown — not buying blind',
    };
  }
  if (config.minTokenAgeMinutes > 0 && market.ageMinutes < config.minTokenAgeMinutes) {
    return {
      ok: false,
      reason: `token is ${describeAge(market.ageMinutes)} old, need ${describeAge(config.minTokenAgeMinutes)} (MIN_TOKEN_AGE_MINUTES)`,
    };
  }
  if (config.minLiquidityUsd > 0) {
    if (market.liquidityUsd === null) return { ok: false, reason: 'liquidity unknown — not buying blind' };
    if (market.liquidityUsd < config.minLiquidityUsd) {
      return {
        ok: false,
        reason: `liquidity ${usd(market.liquidityUsd)} is below ${usd(config.minLiquidityUsd)} (MIN_LIQUIDITY_USD)`,
      };
    }
  }
  const liquidity = market.liquidityUsd === null ? 'liquidity unknown' : `${usd(market.liquidityUsd)} liquidity`;
  return { ok: true, note: `${describeAge(market.ageMinutes)} old, ${liquidity}` };
}

// ---------------------------------------------------------- Dexscreener ---

const DEXSCREENER_URL = 'https://api.dexscreener.com/latest/dex/tokens/';
const CACHE_MS = 60_000; // several wallets buying the same token within a minute share one lookup

interface DexPair {
  chainId?: string;
  pairCreatedAt?: number; // epoch ms
  liquidity?: { usd?: number };
  baseToken?: { address?: string };
}

const cache = new Map<string, { market: TokenMarket; at: number }>();

// Pure, exported for tests: the OLDEST Solana pair's age (a relaunch on a new
// pool doesn't make a token "new" again) and the DEEPEST pool's liquidity
// (that's the one Jupiter will route through). Other chains are ignored.
export function summarizePairs(pairs: DexPair[], mint: string, now: number): TokenMarket {
  const solana = pairs.filter(
    (p) => p.chainId === 'solana' && (!p.baseToken?.address || p.baseToken.address === mint)
  );
  if (solana.length === 0) return { ageMinutes: null, liquidityUsd: null, source: 'dexscreener' };
  const created = solana
    .map((p) => p.pairCreatedAt)
    .filter((t): t is number => typeof t === 'number' && t > 0);
  const liquidity = solana
    .map((p) => p.liquidity?.usd)
    .filter((v): v is number => typeof v === 'number' && v >= 0);
  return {
    ageMinutes: created.length > 0 ? Math.max(0, (now - Math.min(...created)) / 60_000) : null,
    liquidityUsd: liquidity.length > 0 ? Math.max(...liquidity) : null,
    source: `dexscreener, ${solana.length} pool${solana.length === 1 ? '' : 's'}`,
  };
}

export async function fetchDexscreenerMarket(mint: string): Promise<TokenMarket | null> {
  const now = Date.now();
  const hit = cache.get(mint);
  if (hit && now - hit.at < CACHE_MS) return hit.market;

  let market: TokenMarket;
  try {
    const response = await fetch(DEXSCREENER_URL + mint, { signal: AbortSignal.timeout(6_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { pairs?: DexPair[] | null };
    market = summarizePairs(body?.pairs ?? [], mint, now);
  } catch (error) {
    console.log(`   (token lookup failed: ${(error as Error).message})`);
    return null; // failures are not cached — the next candidate gets a fresh try
  }
  cache.set(mint, { market, at: now });
  return market;
}
