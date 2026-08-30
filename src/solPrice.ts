// Live SOL/USD price for P&L display and USD-quoted trade filtering.
//
// Deliberately NOT fetched from Jupiter: the Jupiter free tier is only
// 1 request/second shared across everything, and we reserve all of that
// budget for actual trading. CoinGecko's public endpoint is free and
// doesn't need an API key.

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';
const CACHE_MS = 60_000; // refresh at most once per minute

let cachedPrice: number | null = null;
let cachedAt = 0;

// Returns the SOL price in USD, or null if it can't be fetched right now.
// Callers must handle null (print "USD unavailable" instead of fake numbers).
export async function getSolPriceUsd(): Promise<number | null> {
  const now = Date.now();
  if (cachedPrice !== null && now - cachedAt < CACHE_MS) return cachedPrice;

  try {
    const response = await fetch(COINGECKO_URL, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { solana?: { usd?: number } };
    const price = body?.solana?.usd;
    if (typeof price !== 'number' || !(price > 0)) throw new Error('unexpected response shape');
    cachedPrice = price;
    cachedAt = now;
    return price;
  } catch (error) {
    // Keep serving a stale price for up to 15 minutes rather than nothing.
    if (cachedPrice !== null && now - cachedAt < 15 * 60_000) return cachedPrice;
    console.log(`   (could not fetch SOL/USD price: ${(error as Error).message})`);
    return null;
  }
}
