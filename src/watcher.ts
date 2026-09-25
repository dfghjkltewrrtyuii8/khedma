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

// The live feed (a WebSocket) can fail silently: the bot then looks exactly
// like it does when the wallets are simply quiet — "0 transactions examined".
// So every ACTIVITY_CHECK_MS each watched wallet's latest transactions are
// also read directly (one cheap RPC call per wallet), which tells the two
// cases apart: it gives each wallet's real last activity, and any successful
// transaction the feed should have delivered but didn't means the feed broke
// — that wallet is re-subscribed on the spot.
const ACTIVITY_CHECK_MS = 5 * 60_000;
const FEED_GRACE_MS = 60_000; // the feed delivers in seconds; a minute late means it missed it
const ACTIVITY_SPACING_MS = 2_000; // between one wallet's check and the next
const SUBSCRIBE_MARGIN_MS = 15_000; // ignore transactions from the moment of subscribing

// How fast a wallet is transacting, for spotting robots: every notification
// is timestamped (failed transactions too — robots spam those). Only the most
// recent TX_HISTORY_CAP are kept per wallet, which is plenty to tell a robot
// (thousands per window) from a person (a handful).
export const ROBOT_WINDOW_MS = 10 * 60_000;
const TX_HISTORY_CAP = 1_000;

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
  // Transactions the live feed never delivered, found by the activity check.
  missedByFeed: number;
}

// What the activity check needs from the RPC: a wallet's latest signatures.
export interface SignatureInfo {
  signature: string;
  blockTime?: number | null; // epoch seconds
  err: unknown;
}

export class WalletWatcher {
  private subscriptions = new Map<string, number>(); // wallet -> onLogs subscription id
  private seenSignatures = new Set<string>();
  private stopped = false;
  private queue: QueuedTx[] = [];
  private draining = false;
  private processed = 0;
  private droppedStale = 0;
  private droppedOverflow = 0;
  private unreadableFormat = 0;
  private missedByFeed = 0;
  private lastActivity = new Map<string, number>(); // wallet -> epoch ms of its newest transaction we know of
  private txTimes = new Map<string, number[]>(); // wallet -> when its recent notifications arrived, oldest first
  private subscribedAt = new Map<string, number>();
  private activityTimer: NodeJS.Timeout | null = null;

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
    for (const wallet of this.trackedWallets) this.subscribe(wallet);
  }

  // When each watched wallet last did anything on-chain (epoch ms), if known.
  lastActivityOf(address: string): number | undefined {
    return this.lastActivity.get(address);
  }

  watchedWallets(): string[] {
    return [...this.subscriptions.keys()];
  }

  // How many transactions the wallet made in the last `windowMs`, as seen by
  // the live feed (counts above TX_HISTORY_CAP read as the cap).
  recentTxCount(address: string, now: number = Date.now(), windowMs: number = ROBOT_WINDOW_MS): number {
    const times = this.txTimes.get(address);
    if (!times) return 0;
    const cutoff = now - windowMs;
    let expired = 0;
    while (expired < times.length && times[expired] < cutoff) expired++;
    if (expired > 0) times.splice(0, expired);
    return times.length;
  }

  private noteTx(address: string, at: number): void {
    let times = this.txTimes.get(address);
    if (!times) this.txTimes.set(address, (times = []));
    times.push(at);
    if (times.length > TX_HISTORY_CAP) times.splice(0, times.length - TX_HISTORY_CAP);
  }

  // Check every watched wallet now, then every ACTIVITY_CHECK_MS — a couple
  // of seconds apart, so the checks never queue up behind each other on the
  // RPC (which used to print a burst of "rate limiter … queued" lines).
  startActivityChecks(intervalMs: number = ACTIVITY_CHECK_MS, spacingMs: number = ACTIVITY_SPACING_MS): void {
    const checkAll = () => {
      this.watchedWallets().forEach((wallet, i) => {
        setTimeout(() => void this.checkActivity(wallet).catch(() => {}), i * spacingMs);
      });
    };
    checkAll();
    this.activityTimer = setInterval(checkAll, intervalMs);
  }

  // Reads the wallet's latest transactions straight from the RPC: records its
  // real last activity, and re-subscribes it if the live feed missed any.
  // Returns how many the feed missed.
  async checkActivity(address: string, now: number = Date.now()): Promise<number> {
    if (this.stopped || !this.subscriptions.has(address)) return 0;
    const signatures = (await this.rpcLimiter.schedule('getSignaturesForAddress', () =>
      this.connection.getSignaturesForAddress(new PublicKey(address), { limit: 10 }, 'confirmed')
    )) as SignatureInfo[];
    const since = (this.subscribedAt.get(address) ?? now) + SUBSCRIBE_MARGIN_MS;
    let missed = 0;
    for (const s of signatures) {
      if (!s.blockTime) continue;
      const at = s.blockTime * 1000;
      this.noteActivity(address, at);
      if (s.err === null && at >= since && now - at >= FEED_GRACE_MS && !this.seenSignatures.has(s.signature)) {
        missed += 1;
        this.rememberSignature(s.signature); // counted once, never again
      }
    }
    if (missed > 0 && !this.stopped && this.subscriptions.has(address)) {
      this.missedByFeed += missed;
      console.log(
        `\n📡 The live feed missed ${missed} transaction(s) from ${shortAddress(address)} — reconnecting it. ` +
          '(If this keeps happening, check HELIUS_WSS_URL or your internet connection.)'
      );
      await this.resubscribe(address);
    }
    return missed;
  }

  // When a wallet — watched or not — last did anything on-chain: one cheap
  // lookup. Rotation uses it to notice a benched winner trading again.
  async probeActivity(address: string): Promise<number | undefined> {
    if (this.stopped) return undefined;
    const signatures = (await this.rpcLimiter.schedule('getSignaturesForAddress', () =>
      this.connection.getSignaturesForAddress(new PublicKey(address), { limit: 1 }, 'confirmed')
    )) as SignatureInfo[];
    const blockTime = signatures[0]?.blockTime;
    if (!blockTime) return undefined;
    this.noteActivity(address, blockTime * 1000);
    return blockTime * 1000;
  }

  private noteActivity(address: string, at: number): void {
    if (at > (this.lastActivity.get(address) ?? 0)) this.lastActivity.set(address, at);
  }

  private async resubscribe(address: string): Promise<void> {
    const id = this.subscriptions.get(address);
    if (id === undefined) return;
    this.subscriptions.delete(address);
    try {
      await this.connection.removeOnLogsListener(id);
    } catch {
      // Already gone — that may be why it went quiet.
    }
    if (!this.stopped) this.subscribe(new PublicKey(address), false);
  }

  isWatching(address: string): boolean {
    return this.subscriptions.has(address);
  }

  // Start watching a wallet while running (rotation promotes a bench wallet).
  addWallet(address: string): void {
    if (this.stopped) return;
    this.subscribe(new PublicKey(address));
    // Learn its last activity right away (rotation benches wallets gone quiet).
    if (this.activityTimer) void this.checkActivity(address).catch(() => {});
  }

  // Stop watching a wallet while running. Trades of its already in the queue
  // still get processed — its sells still matter.
  async removeWallet(address: string): Promise<void> {
    const id = this.subscriptions.get(address);
    if (id === undefined) return;
    this.subscriptions.delete(address);
    this.subscribedAt.delete(address);
    this.txTimes.delete(address);
    try {
      await this.connection.removeOnLogsListener(id);
    } catch {
      // The socket may already be closing; that's fine.
    }
    console.log(`👋 Stopped watching ${shortAddress(address)}`);
  }

  private subscribe(wallet: PublicKey, announce = true): void {
    const walletAddress = wallet.toBase58();
    if (this.subscriptions.has(walletAddress)) return;
    this.subscribedAt.set(walletAddress, Date.now());
    const subscriptionId = this.connection.onLogs(
      wallet,
      (logs) => {
        if (this.stopped) return;
        this.noteActivity(walletAddress, Date.now());
        this.noteTx(walletAddress, Date.now());
        if (logs.err) return; // failed transaction — nothing actually happened
        if (this.seenSignatures.has(logs.signature)) return;
        this.rememberSignature(logs.signature);
        this.enqueue(logs.signature, walletAddress);
      },
      'confirmed'
    );
    this.subscriptions.set(walletAddress, subscriptionId);
    if (announce) console.log(`👀 Watching wallet ${walletAddress}`);
  }

  // Stop reacting to new activity immediately (used at shutdown).
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.queue = [];
    for (const id of this.subscriptions.values()) {
      try {
        await this.connection.removeOnLogsListener(id);
      } catch {
        // The socket may already be closing; that's fine.
      }
    }
    this.subscriptions.clear();
  }

  stats(): WatcherStats {
    return {
      processed: this.processed,
      droppedStale: this.droppedStale,
      droppedOverflow: this.droppedOverflow,
      queued: this.queue.length,
      unreadableFormat: this.unreadableFormat,
      missedByFeed: this.missedByFeed,
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
  walletAddress: string,
  quiet = false // reading history (vetting): no per-transaction notes
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
    if (!quiet) console.log(`   (skipping tx ${signature}: multiple tokens changed at once — too complex to mirror)`);
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
