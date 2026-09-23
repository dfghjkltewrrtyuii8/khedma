// Watches tracked wallets over the Helius WebSocket and turns their confirmed
// transactions into SwapEvents (buy/sell of some token against SOL/USDC/USDT).
//
// How detection works: for each transaction that mentions a tracked wallet,
// we fetch the parsed transaction and compare the wallet's balances before vs
// after. If exactly one "real" token changed hands while SOL (or a stablecoin)
// moved the other way, that's a swap we can mirror.
//
// Incoming signatures are QUEUED and drained one at a time through an RPC rate
// limiter. Busy wallets can emit several transactions per second, and firing an
// unthrottled getParsedTransaction at each one exhausts a free-tier RPC plan in
// seconds — every 429 is a trade silently lost. Anything that waits in the
// queue longer than STALE_MS is dropped on purpose: a trade we notice a minute
// late is far too old to copy, and fetching it only delays fresher ones.

import { Connection, ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import { QUOTE_MINTS, SOL_MINT, USDC_MINT, USDT_MINT } from './config';
import { RateLimiter, sleep } from './rateLimiter';
import { getSolPriceUsd } from './solPrice';
import { SwapEvent } from './types';

const DUST_LAMPORTS = 1_000_000n; // 0.001 SOL — ignore fee-only SOL movement
const DUST_USD = 0.01;
const TX_FETCH_RETRIES = 2;
const TX_FETCH_RETRY_DELAY_MS = 1_500;
const STALE_MS = 45_000; // older than this and the trade is not worth copying
const MAX_QUEUE = 40;

// The newest transaction format we can read. Solana added version 1 in 2026;
// asking for less makes the RPC refuse every trade sent in the newer format,
// which is exactly how this bot once sat watching two busy wallets and saw
// nothing. Raise this together with the @solana/web3.js version that can
// parse the new format — asking for a version the library can't validate
// just moves the failure from the RPC to the client.
export const MAX_TX_VERSION = 1;
const UNSUPPORTED_VERSION = /Transaction version \((\d+)\) is not supported/;

// Asking for version 1 only helps if the installed library can parse it:
// @solana/web3.js before 1.99.0 rejects a version-1 response client-side,
// with an error that looks like any other glitch. Updating the code without
// running `npm install` leaves exactly that library in place, so the bot
// checks what is actually installed rather than what package.json asks for.
export const MIN_WEB3_VERSION = '1.99.0';

// Pure: is dotted version `a` at least `b`? (numeric parts only)
export function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export function installedWeb3Version(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (require('@solana/web3.js/package.json') as { version: string }).version;
}

type SwapHandler = (event: SwapEvent) => Promise<void>;

interface QueuedTx {
  signature: string;
  wallet: string;
  receivedAt: number;
}

export interface WatcherStats {
  processed: number;
  droppedStale: number;
  droppedOverflow: number;
  queued: number;
  // Trades the network sent in a format too new for this build to read.
  // Anything above zero means the bot is blind to some of what it watches.
  unreadableFormat: number;
}

export class WalletWatcher {
  private subscriptionIds: number[] = [];
  private seenSignatures = new Set<string>();
  private stopped = false;
  private queue: QueuedTx[] = [];
  private draining = false;
  private processed = 0;
  private droppedStale = 0;
  private droppedOverflow = 0;
  private unreadableFormat = 0;

  constructor(
    private readonly connection: Connection,
    private readonly trackedWallets: PublicKey[],
    private readonly onSwap: SwapHandler,
    // Serializes getParsedTransaction so we stay inside the RPC plan's limits.
    private readonly rpcLimiter: RateLimiter,
    // Overridable so tests can exercise the drop paths without waiting.
    private readonly staleMs: number = STALE_MS,
    private readonly maxQueue: number = MAX_QUEUE
  ) {}

  start(): void {
    for (const wallet of this.trackedWallets) {
      const walletAddress = wallet.toBase58();
      const subscriptionId = this.connection.onLogs(
        wallet,
        (logs) => {
          if (this.stopped) return;
          if (logs.err) return; // failed transaction — nothing actually happened
          if (this.seenSignatures.has(logs.signature)) return;
          this.rememberSignature(logs.signature);
          this.enqueue(logs.signature, walletAddress);
        },
        'confirmed'
      );
      this.subscriptionIds.push(subscriptionId);
      console.log(`👀 Watching wallet ${walletAddress}`);
    }
  }

  // Stop reacting to new activity immediately (used at shutdown).
  async stop(): Promise<void> {
    this.stopped = true;
    this.queue = [];
    for (const id of this.subscriptionIds) {
      try {
        await this.connection.removeOnLogsListener(id);
      } catch {
        // The socket may already be closing; that's fine.
      }
    }
    this.subscriptionIds = [];
  }

  stats(): WatcherStats {
    return {
      processed: this.processed,
      droppedStale: this.droppedStale,
      droppedOverflow: this.droppedOverflow,
      queued: this.queue.length,
      unreadableFormat: this.unreadableFormat,
    };
  }

  private rememberSignature(signature: string): void {
    this.seenSignatures.add(signature);
    if (this.seenSignatures.size > 5_000) {
      // Drop the oldest half so the set doesn't grow forever.
      const keep = [...this.seenSignatures].slice(-2_500);
      this.seenSignatures = new Set(keep);
    }
  }

  private enqueue(signature: string, wallet: string): void {
    this.queue.push({ signature, wallet, receivedAt: Date.now() });
    if (this.queue.length > this.maxQueue) {
      this.queue.shift(); // oldest is the least useful
      this.droppedOverflow += 1;
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const item = this.queue.shift()!;
        const ageMs = Date.now() - item.receivedAt;
        if (ageMs > this.staleMs) {
          this.droppedStale += 1;
          continue;
        }
        try {
          await this.handleSignature(item.signature, item.wallet);
          this.processed += 1;
        } catch (error) {
          const message = (error as Error).message;
          const tooNew = UNSUPPORTED_VERSION.exec(message);
          if (tooNew) {
            // Loud once, counted after: this is not a one-off glitch, it means
            // every trade in that format is invisible until the bot is updated.
            this.unreadableFormat += 1;
            if (this.unreadableFormat === 1) {
              console.error(
                `\n   🚨 A tracked wallet traded using transaction format version ${tooNew[1]}, which this\n` +
                  `      build can't read (it reads up to version ${MAX_TX_VERSION}). Those trades are INVISIBLE to\n` +
                  '      the bot — it will look idle while missing them. Update the bot. The count\n' +
                  '      appears in every 📊 Watcher line until you do.\n'
              );
            }
          } else {
            console.error(`   ⚠️ Could not process tx ${item.signature.slice(0, 12)}…: ${message}`);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async handleSignature(signature: string, walletAddress: string): Promise<void> {
    // The transaction may not be queryable the instant the log arrives — retry
    // a couple of times, but not for long: a stale trade is not worth copying.
    let tx: ParsedTransactionWithMeta | null = null;
    for (let attempt = 1; attempt <= TX_FETCH_RETRIES; attempt++) {
      tx = await this.rpcLimiter.schedule('getParsedTransaction', () =>
        this.connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: MAX_TX_VERSION,
          commitment: 'confirmed',
        })
      );
      if (tx) break;
      if (this.stopped) return;
      if (attempt < TX_FETCH_RETRIES) await sleep(TX_FETCH_RETRY_DELAY_MS);
    }
    if (!tx || !tx.meta) return;
    if (this.stopped) return;

    const event = await analyzeSwap(tx, signature, walletAddress);
    if (!event) return;

    const uiAmount = Number(event.tokenDeltaRaw) / 10 ** event.decimals;
    console.log(
      `\n🔔 ${shortAddress(walletAddress)} ${event.side === 'buy' ? 'BOUGHT' : 'SOLD'} ` +
        `${uiAmount.toLocaleString()} of ${shortAddress(event.mint)}` +
        (event.quoteSolEquivalent !== null ? ` (~${event.quoteSolEquivalent.toFixed(4)} SOL)` : '') +
        `\n   tx: ${signature}`
    );
    await this.onSwap(event);
  }
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

// Exported for testing.
export async function analyzeSwap(
  tx: ParsedTransactionWithMeta,
  signature: string,
  walletAddress: string
): Promise<SwapEvent | null> {
  const meta = tx.meta!;

  // --- Token balance changes for accounts OWNED by the tracked wallet ---
  const byMint = new Map<string, { pre: bigint; post: bigint; decimals: number }>();
  for (const balance of meta.preTokenBalances ?? []) {
    if (balance.owner !== walletAddress) continue;
    const entry = byMint.get(balance.mint) ?? { pre: 0n, post: 0n, decimals: balance.uiTokenAmount.decimals };
    entry.pre += BigInt(balance.uiTokenAmount.amount);
    byMint.set(balance.mint, entry);
  }
  for (const balance of meta.postTokenBalances ?? []) {
    if (balance.owner !== walletAddress) continue;
    const entry = byMint.get(balance.mint) ?? { pre: 0n, post: 0n, decimals: balance.uiTokenAmount.decimals };
    entry.post += BigInt(balance.uiTokenAmount.amount);
    entry.decimals = balance.uiTokenAmount.decimals;
    byMint.set(balance.mint, entry);
  }

  // --- Native SOL change for the wallet itself ---
  let solLamportsDelta = 0n;
  const accountKeys = tx.transaction.message.accountKeys;
  for (let i = 0; i < accountKeys.length; i++) {
    if (accountKeys[i].pubkey.toBase58() === walletAddress) {
      solLamportsDelta = BigInt(meta.postBalances[i]) - BigInt(meta.preBalances[i]);
      break;
    }
  }
  // Wrapped SOL counts as SOL too (also 9 decimals, so raw units = lamports).
  const wsol = byMint.get(SOL_MINT);
  if (wsol) solLamportsDelta += wsol.post - wsol.pre;

  // --- Stablecoin change (USDC/USDT, both 6 decimals) ---
  let usdDelta = 0;
  for (const stableMint of [USDC_MINT, USDT_MINT]) {
    const entry = byMint.get(stableMint);
    if (entry) usdDelta += Number(entry.post - entry.pre) / 1e6;
  }

  // --- The traded token: exactly one non-quote mint that changed ---
  const changedTokens: { mint: string; delta: bigint; pre: bigint; decimals: number }[] = [];
  for (const [mint, entry] of byMint) {
    if (QUOTE_MINTS.has(mint)) continue;
    const delta = entry.post - entry.pre;
    if (delta !== 0n) changedTokens.push({ mint, delta, pre: entry.pre, decimals: entry.decimals });
  }
  if (changedTokens.length === 0) return null;
  if (changedTokens.length > 1) {
    console.log(`   (skipping tx ${signature}: multiple tokens changed at once — too complex to mirror)`);
    return null;
  }

  const token = changedTokens[0];
  const solMovedDown = solLamportsDelta < -DUST_LAMPORTS;
  const solMovedUp = solLamportsDelta > DUST_LAMPORTS;
  const usdMovedDown = usdDelta < -DUST_USD;
  const usdMovedUp = usdDelta > DUST_USD;

  let side: 'buy' | 'sell';
  if (token.delta > 0n && (solMovedDown || usdMovedDown)) {
    side = 'buy'; // gained token, paid SOL or stablecoin
  } else if (token.delta < 0n && (solMovedUp || usdMovedUp)) {
    side = 'sell'; // gave up token, received SOL or stablecoin
  } else {
    return null; // plain transfer, airdrop, LP action, etc. — not a swap we mirror
  }

  // Estimate the trade size in SOL for filtering/logging.
  let quoteSolEquivalent: number | null = null;
  if (solMovedDown || solMovedUp) {
    quoteSolEquivalent = Math.abs(Number(solLamportsDelta)) / 1e9;
  } else {
    const solPrice = await getSolPriceUsd();
    if (solPrice !== null) quoteSolEquivalent = Math.abs(usdDelta) / solPrice;
  }

  return {
    signature,
    sourceWallet: walletAddress,
    side,
    mint: token.mint,
    decimals: token.decimals,
    tokenDeltaRaw: token.delta < 0n ? -token.delta : token.delta,
    ownerPreTokenRaw: token.pre,
    quoteSolEquivalent,
  };
}
