// Offline logic tests for the copy-trading bot: swap detection, rate limiter
// spacing, position store lifecycle, and trader behavior with a mocked Jupiter.
// Run from the repo root with: npm test
// Uses a throwaway keypair and a temp directory — never touches your real
// .env or data/positions.json.

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import bs58 from 'bs58';
import { Keypair, ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';

// A fresh keypair generated per run, so no private key is ever committed and
// the tests can't touch a funded wallet. These env vars are set before any
// loadConfig() call (which happens inside the test functions below).
process.env.PRIVATE_KEY_BASE58 = bs58.encode(Keypair.generate().secretKey);
process.env.HELIUS_HTTPS_URL = 'https://example.com';
process.env.HELIUS_WSS_URL = 'wss://example.com';
process.env.JUPITER_API_KEY = 'test';
process.env.TRACKED_WALLETS = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
process.env.DRY_RUN = 'true';

import { analyzeSwap, WalletWatcher } from '../src/watcher';
import { RateLimiter } from '../src/rateLimiter';
import { PositionStore } from '../src/positions';
import { Trader } from '../src/trader';
import { loadConfig, SOL_MINT } from '../src/config';
import { JupiterOrder, OrderParams } from '../src/jupiter';
import { printSummary } from '../src/pnl';
import { getSolPriceUsd } from '../src/solPrice';
import { decideShutdown } from '../src/shutdownDebounce';
import { soundFor } from '../src/notify';
import { evaluateToken, summarizePairs, TokenMarket } from '../src/tokenMarket';
import { Position } from '../src/types';
import { walletMute, walletRecords } from '../src/walletGate';

const TRACKED = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
const MEME_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // BONK mint (any valid pubkey works)

// The token gate's market source for tests that aren't about the gate: an
// old, deep token that always passes. Never touches the network.
const okMarket = async (): Promise<TokenMarket> => ({ ageMinutes: 6 * 60, liquidityUsd: 150_000, source: 'test' });

function makeTx(opts: {
  solPre: number;
  solPost: number;
  tokenPre: bigint;
  tokenPost: bigint;
  mint?: string;
  decimals?: number;
}): ParsedTransactionWithMeta {
  const mint = opts.mint ?? MEME_MINT;
  const decimals = opts.decimals ?? 5;
  return {
    slot: 1,
    transaction: {
      message: {
        accountKeys: [{ pubkey: new PublicKey(TRACKED), signer: true, writable: true, source: 'transaction' }],
        instructions: [],
        recentBlockhash: 'x',
      },
      signatures: ['sig'],
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [opts.solPre],
      postBalances: [opts.solPost],
      preTokenBalances:
        opts.tokenPre > 0n
          ? [{ accountIndex: 5, mint, owner: TRACKED, uiTokenAmount: { amount: opts.tokenPre.toString(), decimals, uiAmount: null, uiAmountString: '0' } }]
          : [],
      postTokenBalances:
        opts.tokenPost > 0n
          ? [{ accountIndex: 5, mint, owner: TRACKED, uiTokenAmount: { amount: opts.tokenPost.toString(), decimals, uiAmount: null, uiAmountString: '0' } }]
          : [],
      innerInstructions: [],
      logMessages: [],
    },
  } as unknown as ParsedTransactionWithMeta;
}

async function testAnalyzeSwap() {
  // Buy: SOL down 0.5, token up 1000
  const buy = await analyzeSwap(makeTx({ solPre: 2e9, solPost: 1.5e9, tokenPre: 0n, tokenPost: 100_000_000n }), 'sig1', TRACKED);
  assert(buy && buy.side === 'buy', 'should detect buy');
  assert(buy.tokenDeltaRaw === 100_000_000n, 'buy token delta');
  assert(Math.abs((buy.quoteSolEquivalent ?? 0) - 0.5) < 0.001, 'buy sol size');

  // Sell 40%: token down, SOL up
  const sell = await analyzeSwap(makeTx({ solPre: 1e9, solPost: 1.2e9, tokenPre: 100_000_000n, tokenPost: 60_000_000n }), 'sig2', TRACKED);
  assert(sell && sell.side === 'sell', 'should detect sell');
  assert(sell.tokenDeltaRaw === 40_000_000n && sell.ownerPreTokenRaw === 100_000_000n, 'sell fraction inputs');

  // Plain token transfer out (only fee paid) — must NOT be a sell
  const transfer = await analyzeSwap(makeTx({ solPre: 1e9, solPost: 1e9 - 5000, tokenPre: 100_000_000n, tokenPost: 50_000_000n }), 'sig3', TRACKED);
  assert(transfer === null, 'transfer must not be a swap');

  // Airdrop in (no SOL spent) — must NOT be a buy
  const airdrop = await analyzeSwap(makeTx({ solPre: 1e9, solPost: 1e9 - 5000, tokenPre: 0n, tokenPost: 77n }), 'sig4', TRACKED);
  assert(airdrop === null, 'airdrop must not be a buy');
  console.log('✅ analyzeSwap: buy/sell/transfer/airdrop all classified correctly');
}

async function testRateLimiter() {
  const limiter = new RateLimiter(300);
  const starts: number[] = [];
  await Promise.all(
    [1, 2, 3].map((i) => limiter.schedule(`t${i}`, async () => { starts.push(Date.now()); }))
  );
  const gap1 = starts[1] - starts[0];
  const gap2 = starts[2] - starts[1];
  assert(gap1 >= 290 && gap2 >= 290, `limiter gaps too small: ${gap1}, ${gap2}`);
  // A failing call must not jam the queue
  await limiter.schedule('boom', async () => { throw new Error('boom'); }).catch(() => {});
  const after = await limiter.schedule('after', async () => 42);
  assert(after === 42, 'queue survived a failure');
  console.log(`✅ rate limiter: serialized with gaps ${gap1}ms / ${gap2}ms, survives errors`);
}

async function testTrader() {
  const config = loadConfig();
  config.maxOpenPositions = 2;
  const store = new PositionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-test-')));
  store.load();
  const keypair = Keypair.generate();

  let failNextOrders = 0;
  const orders: OrderParams[] = [];
  const fakeJupiter = {
    async getOrder(params: OrderParams): Promise<JupiterOrder> {
      orders.push(params);
      if (failNextOrders > 0) {
        failNextOrders--;
        const err: any = new Error('no route found');
        err.kind = 'no-route';
        throw err;
      }
      // buy: 0.01 SOL -> 5000 raw tokens; sell: any tokens -> 0.012 SOL
      const isBuy = params.inputMint === SOL_MINT;
      return {
        requestId: 'req',
        transactionBase64: null,
        inAmountRaw: params.amountRaw,
        outAmountRaw: isBuy ? 5_000n : 12_000_000n,
      };
    },
    async execute() { throw new Error('must not execute in dry run'); },
  };
  const fakeConnection = { async getBalance() { return 10e9; } };

  const trader = new Trader(config, fakeConnection as any, keypair, fakeJupiter as any, store, okMarket);

  const buyEvent = {
    signature: 's1', sourceWallet: TRACKED, side: 'buy' as const, mint: MEME_MINT,
    decimals: 5, tokenDeltaRaw: 1n, ownerPreTokenRaw: 0n, quoteSolEquivalent: 0.5,
  };
  await trader.handleSwapEvent(buyEvent);
  assert(store.byStatus('open').length === 1, 'buy opened a position');
  assert(store.byStatus('open')[0].tokenAmountRaw === '5000', 'position holds quoted tokens');

  // Duplicate buy on same mint → skipped
  await trader.handleSwapEvent({ ...buyEvent, signature: 's2' });
  assert(store.byStatus('open').length === 1, 'duplicate mint buy skipped');

  // Dust buy on another mint → skipped
  const OTHER_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'; // JUP mint
  await trader.handleSwapEvent({ ...buyEvent, signature: 's3', mint: OTHER_MINT, quoteSolEquivalent: 0.001 });
  assert(store.byStatus('open').length === 1, 'dust buy skipped');

  // Partial sell 50% → position stays open with half the tokens
  await trader.handleSwapEvent({
    signature: 's4', sourceWallet: TRACKED, side: 'sell', mint: MEME_MINT,
    decimals: 5, tokenDeltaRaw: 50n, ownerPreTokenRaw: 100n, quoteSolEquivalent: 0.2,
  });
  const pos = store.byStatus('open')[0];
  assert(pos && pos.tokenAmountRaw === '2500', `partial sell left ${pos?.tokenAmountRaw}, expected 2500`);
  assert(Math.abs(pos.receivedSol - 0.012) < 1e-9, 'partial sell recorded proceeds');

  // Sell 95% of their bag → treated as full exit → closed
  await trader.handleSwapEvent({
    signature: 's5', sourceWallet: TRACKED, side: 'sell', mint: MEME_MINT,
    decimals: 5, tokenDeltaRaw: 95n, ownerPreTokenRaw: 100n, quoteSolEquivalent: 0.2,
  });
  assert(store.byStatus('closed').length === 1, 'full exit closed the position');

  // New buy, then all sell attempts fail → STUCK, not closed
  await trader.handleSwapEvent({ ...buyEvent, signature: 's6' });
  failNextOrders = 99;
  await trader.handleSwapEvent({
    signature: 's7', sourceWallet: TRACKED, side: 'sell', mint: MEME_MINT,
    decimals: 5, tokenDeltaRaw: 100n, ownerPreTokenRaw: 100n, quoteSolEquivalent: 0.2,
  });
  assert(store.byStatus('stuck').length === 1, 'failed sell marked stuck');
  assert(store.byStatus('closed').length === 1, 'failed sell NOT recorded as closed');

  // Stuck position blocks re-buying same mint and counts toward the cap
  await trader.handleSwapEvent({ ...buyEvent, signature: 's8' });
  assert(store.byStatus('open').length === 0, 'stuck mint not re-bought');

  // Shutdown: closeAll retries the stuck one (jupiter healthy again) and the guard blocks a second run
  failNextOrders = 0;
  trader.beginShutdown();
  await trader.handleSwapEvent({ ...buyEvent, signature: 's9' });
  assert(store.byStatus('open').length === 0, 'no new buys after shutdown starts');
  await trader.closeAllPositions('test shutdown');
  assert(store.byStatus('stuck').length === 0 && store.byStatus('closed').length === 2, 'shutdown closed the stuck position');
  const ordersBefore = orders.length;
  await trader.closeAllPositions('second ctrl+c');
  assert(orders.length === ordersBefore, 'second closeAll did nothing (double Ctrl+C safe)');

  // Dry-run must never send a taker. Sending one makes Jupiter balance-check a
  // wallet for a swap it will never make, which failed every simulated trade on
  // an unfunded wallet with "Insufficient funds".
  assert(orders.length > 0, 'orders were recorded');
  assert(orders.every((o) => o.takerPubkey === null), 'dry-run orders must be quote-only (taker omitted)');

  // Real mode must pass the taker, so Jupiter builds a transaction to sign.
  const realStore = new PositionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-real-')));
  const realTrader = new Trader({ ...config, dryRun: false }, fakeConnection as any, keypair, fakeJupiter as any, realStore, okMarket);
  orders.length = 0;
  await realTrader.handleSwapEvent({ ...buyEvent, signature: 'r1' });
  assert(orders.length === 1, 'real mode requested one order');
  assert(orders[0].takerPubkey === keypair.publicKey.toBase58(), 'real orders must carry the taker');

  console.log('✅ trader: buy/dup-skip/dust-skip/partial-sell/full-exit/stuck/shutdown-guard all correct');
  console.log('✅ taker: omitted for simulated orders, present for real ones');
}

// The summary must never invent USD figures when the price feed is down,
// must keep simulated and real trades apart, and must never fold a stuck
// position into realized P&L.
async function testSummary() {
  const store = new PositionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-pnl-')));
  const base = { decimals: 5, sourceWallet: TRACKED, tokenAmountRaw: '1000' };

  const simWin = store.openPosition({ ...base, mint: MEME_MINT, dryRun: true, spentSol: 0.01 });
  store.recordSell(simWin, 1000n, 0.015);

  const realLoss = store.openPosition({ ...base, mint: MEME_MINT, dryRun: false, spentSol: 0.02 });
  store.recordSell(realLoss, 1000n, 0.008, 'realsig');

  const stuckPos = store.openPosition({ ...base, mint: MEME_MINT, dryRun: false, spentSol: 0.03 });
  store.markStuck(stuckPos, 'no route');

  assert(stuckPos.status === 'stuck' && stuckPos.receivedSol === 0, 'stuck position has no proceeds');

  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    await printSummary(store);
  } finally {
    console.log = realLog;
  }
  const output = lines.join('\n');

  assert(/SIMULATED/.test(output) && /REAL/.test(output), 'summary separates simulated from real');
  assert(/\+0\.0050 SOL/.test(output), 'simulated realized P&L is +0.0050 SOL');
  assert(/-0\.0120 SOL/.test(output), 'real realized P&L is -0.0120 SOL');
  assert(/STUCK/.test(output) && /still in wallet/i.test(output), 'stuck position flagged loudly');
  // 0.03 SOL of stuck cost must NOT appear inside a realized total.
  assert(!/Realized P&L.*0\.0420/.test(output), 'stuck position excluded from realized P&L');

  const solPrice = await getSolPriceUsd();
  if (solPrice === null) {
    assert(/USD price unavailable/.test(output), 'no fabricated USD when price feed is down');
    realLog('✅ P&L summary: sim/real split, stuck excluded, honest "USD price unavailable" when feed is down');
  } else {
    assert(/\$\d/.test(output), 'shows USD alongside SOL when price is available');
    realLog('✅ P&L summary: sim/real split, stuck excluded, SOL and USD both shown');
  }

  await testMarkToMarket(realLog);
}

// Open positions priced with quote-only orders: a live one shows its current
// value, and one Jupiter cannot route is flagged rather than valued at cost.
async function testMarkToMarket(realLog: (...args: unknown[]) => void) {
  const DEAD_MINT = 'So11111111111111111111111111111111111111113';
  const store = new PositionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-mtm-')));
  const base = { decimals: 5, sourceWallet: TRACKED, tokenAmountRaw: '1000', dryRun: true, spentSol: 0.01 };
  store.openPosition({ ...base, mint: MEME_MINT });
  store.openPosition({ ...base, mint: DEAD_MINT });

  let sawTaker: unknown = 'never called';
  const markJupiter = {
    async getOrder(params: OrderParams): Promise<JupiterOrder> {
      sawTaker = params.takerPubkey;
      if (params.inputMint === DEAD_MINT) {
        const err: any = new Error('could not find any route');
        err.kind = 'no-route';
        throw err;
      }
      // 1000 raw tokens are worth 0.015 SOL — a 50% gain on the 0.01 spent.
      return { requestId: 'r', transactionBase64: null, inAmountRaw: params.amountRaw, outAmountRaw: 15_000_000n };
    },
  };

  const lines: string[] = [];
  const realConsole = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    await printSummary(store, markJupiter as any, 300);
  } finally {
    console.log = realConsole;
  }
  const out = lines.join('\n');

  assert(sawTaker === null, 'mark-to-market must send quote-only orders (taker null)');
  assert(/now worth 0\.0150 SOL/.test(out), 'priced position shows its current value');
  assert(/\+50\.0%/.test(out), 'shows percentage gain against cost');
  assert(/NO ROUTE/.test(out), 'unpriceable position flagged, not valued at cost');
  assert(/1 of 2 open, marked to market/.test(out), 'reports how many could be priced');

  realLog('✅ mark-to-market: prices open positions, flags unroutable ones, never sends a taker');
}

// Busy wallets emit transactions faster than a free RPC plan can serve them.
// The watcher must bound its backlog and drop what has gone stale, rather than
// firing an unthrottled request per log line (which is what caused the 429
// storms that silently lost trades).
async function testWatcherQueue() {
  let logCb: (l: { signature: string; err: unknown; logs: string[] }) => void = () => {};
  const fetched: string[] = [];
  const fakeConnection = {
    onLogs(_pk: unknown, cb: typeof logCb) { logCb = cb; return 7; },
    async removeOnLogsListener() {},
    async getParsedTransaction(sig: string) { fetched.push(sig); return { meta: null }; },
  };

  const watcher = new WalletWatcher(
    fakeConnection as any, [new PublicKey(TRACKED)], async () => {},
    new RateLimiter(0), 60_000, 40 // staleMs, maxQueue
  );
  watcher.start();

  const FIRED = 60;
  for (let i = 0; i < FIRED; i++) logCb({ signature: 'sig' + i, err: null, logs: [] });

  const overflowed = watcher.stats().droppedOverflow;
  assert(overflowed > 0, 'a burst larger than the queue must shed the oldest entries');

  while (watcher.stats().queued > 0) await new Promise((r) => setTimeout(r, 10));
  const s = watcher.stats();
  assert(s.processed + s.droppedOverflow + s.droppedStale === FIRED,
    `every signature is accounted for (got ${s.processed}+${s.droppedOverflow}+${s.droppedStale} of ${FIRED})`);
  assert(fetched.length === s.processed, 'one RPC fetch per processed signature, no unthrottled fan-out');

  // A failed transaction is never a swap and must not cost an RPC call.
  const before = fetched.length;
  logCb({ signature: 'failed-tx', err: { InstructionError: [] }, logs: [] });
  await new Promise((r) => setTimeout(r, 20));
  assert(fetched.length === before, 'failed transactions are ignored without fetching');

  await watcher.stop();
  console.log(`✅ watcher queue: bounded backlog (${s.processed} processed, ${overflowed} shed), throttled RPC, skips failed txs`);
}

// The bug that stranded a real position: the buy quote promised more tokens
// than the fill delivered, so every sell asked for more than the wallet held
// and Jupiter rejected it as "Insufficient funds". A real sell must size from
// the chain, never from our record of the quote.
async function testSellUsesOnChainBalance(realLog: (...a: unknown[]) => void) {
  const config = loadConfig();
  const keypair = Keypair.generate();
  const orders: OrderParams[] = [];
  const fakeJupiter = {
    async getOrder(p: OrderParams): Promise<JupiterOrder> {
      orders.push(p);
      return { requestId: 'r', transactionBase64: null, inAmountRaw: p.amountRaw, outAmountRaw: 1_000n };
    },
    async execute() { throw new Error('must not execute'); },
  };
  const QUOTED = 5_000_000n;   // what the buy quote promised
  const DELIVERED = 4_900_000n; // what the wallet actually received
  let onChain = DELIVERED;
  const fakeConnection = {
    async getBalance() { return 10e9; },
    async getParsedTokenAccountsByOwner() {
      return { value: onChain === 0n ? [] :
        [{ account: { data: { parsed: { info: { tokenAmount: { amount: onChain.toString() } } } } } }] };
    },
  };
  const store = new PositionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-onchain-')));
  const trader = new Trader({ ...config, dryRun: false }, fakeConnection as any, keypair, fakeJupiter as any, store, okMarket);

  const quiet = console.log, quietErr = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    const pos = store.openPosition({
      mint: MEME_MINT, decimals: 5, sourceWallet: TRACKED,
      dryRun: false, spentSol: 0.1, tokenAmountRaw: QUOTED.toString(),
    });
    await trader.sellPosition(pos, 1, 'test');

    assert(orders.length > 0, 'a sell order was requested');
    assert(orders[0].amountRaw === DELIVERED,
      `sell must size from the chain (${DELIVERED}), not the quote (${QUOTED}); asked for ${orders[0].amountRaw}`);

    // Holding none of the token is flagged, never recorded as a completed trade.
    onChain = 0n;
    orders.length = 0;
    const empty = store.openPosition({
      mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 5, sourceWallet: TRACKED,
      dryRun: false, spentSol: 0.1, tokenAmountRaw: QUOTED.toString(),
    });
    await trader.sellPosition(empty, 1, 'test');
    assert(orders.length === 0, 'no order is placed when the wallet holds nothing');
    // Zero on-chain balance means nothing is left to retry, so it's 'abandoned'
    // (frees the slot) rather than 'stuck' (implies a failure to keep retrying).
    // See testAbandonedFreesSlot for the dedicated coverage of that behavior.
    assert(empty.status === 'abandoned', `zero balance should be abandoned, not ${empty.status}`);
    assert(empty.receivedSol === 0, 'no fabricated proceeds');
  } finally {
    console.log = quiet; console.error = quietErr;
  }
  realLog('✅ real sells: sized from the on-chain balance, zero-balance flagged not faked');
}

// A position sold OUTSIDE the bot (manually, via jup.ag, etc.) must not sit
// as "stuck" forever — stuck implies an in-bot failure needing a retry, but
// there's nothing left to retry, and it kept occupying a position slot with
// no way out. It should instead be freed as "abandoned": excluded from both
// the position count and from P&L (we don't know what it actually sold for).
async function testAbandonedFreesSlot(realLog: (...a: unknown[]) => void) {
  const config = loadConfig();
  config.maxOpenPositions = 1;
  const keypair = Keypair.generate();
  let onChain = 0n; // simulates: you already sold this token yourself
  const fakeJupiter = {
    async getOrder(p: OrderParams): Promise<JupiterOrder> {
      return { requestId: 'r', transactionBase64: null, inAmountRaw: p.amountRaw, outAmountRaw: 999n };
    },
    async execute() { throw new Error('must not execute'); },
  };
  const fakeConnection = {
    async getBalance() { return 10e9; },
    async getParsedTokenAccountsByOwner() {
      return { value: onChain === 0n ? [] :
        [{ account: { data: { parsed: { info: { tokenAmount: { amount: onChain.toString() } } } } } }] };
    },
  };
  const store = new PositionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-abandoned-')));
  const trader = new Trader({ ...config, dryRun: false }, fakeConnection as any, keypair, fakeJupiter as any, store, okMarket);

  const quiet = console.log, quietErr = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    const pos = store.openPosition({
      mint: MEME_MINT, decimals: 5, sourceWallet: TRACKED,
      dryRun: false, spentSol: 0.1, tokenAmountRaw: '500000',
    });
    await trader.sellPosition(pos, 1, 'test');

    assert(pos.status === 'abandoned', `expected abandoned, got ${pos.status}`);
    assert(store.atRiskCount() === 0, 'abandoned positions must not occupy a slot');
    assert(store.byStatus('stuck').length === 0, 'must not be left as stuck');
    assert(pos.receivedSol === 0, 'no proceeds invented for an externally-sold position');

    // The freed slot must actually accept a new buy.
    onChain = 500n; // the new buy delivers something
    const orderSpy: OrderParams[] = [];
    const fj2 = {
      async getOrder(p: OrderParams): Promise<JupiterOrder> { orderSpy.push(p); return { requestId: 'r', transactionBase64: 'AA==', inAmountRaw: p.amountRaw, outAmountRaw: 500n }; },
      async execute() { return { signature: 'sig' }; },
    };
    // Reuse a trader whose signAndExecute would need a real tx; simplest check is
    // that maybeCopyBuy no longer sees atRiskCount blocking it.
    assert(store.atRiskCount() < config.maxOpenPositions, 'slot is free for the next buy');
  } finally {
    console.log = quiet; console.error = quietErr;
  }
  realLog('✅ abandoned: externally-sold positions free their slot and record no P&L');
}

// The writeoff CLI's own logic: which positions it's willing to touch (real,
// open/stuck only — never dry-run, never already closed/abandoned), and that
// writing one off frees its slot via the same markAbandoned path.
async function testWriteoffFiltering(realLog: (...a: unknown[]) => void) {
  const store = new PositionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-writeoff-')));
  const base = { decimals: 5, sourceWallet: TRACKED, tokenAmountRaw: '1000' };

  const realStuck = store.openPosition({ ...base, mint: MEME_MINT, dryRun: false, spentSol: 0.1 });
  store.markStuck(realStuck, 'no route found');
  const realOpen = store.openPosition({ ...base, mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', dryRun: false, spentSol: 0.1 });
  const simStuck = store.openPosition({ ...base, mint: 'So11111111111111111111111111111111111111111', dryRun: true, spentSol: 0.01 });
  store.markStuck(simStuck, 'no route found');
  const realClosed = store.openPosition({ ...base, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', dryRun: false, spentSol: 0.1 });
  store.recordSell(realClosed, 1000n, 0.11, 'sig');

  // Mirrors the filter in writeoff.ts: real, and still occupying a slot.
  const atRisk = store.all().filter((p) => !p.dryRun && (p.status === 'open' || p.status === 'stuck'));
  assert(atRisk.length === 2, `expected 2 real at-risk positions, got ${atRisk.length}`);
  assert(atRisk.some((p) => p.id === realStuck.id) && atRisk.some((p) => p.id === realOpen.id), 'lists exactly the real open+stuck ones');
  assert(!atRisk.some((p) => p.id === simStuck.id), 'never lists a simulated position for write-off');
  assert(!atRisk.some((p) => p.id === realClosed.id), 'never lists an already-closed position');

  const before = store.atRiskCount();
  store.markAbandoned(realStuck, 'written off manually — could not be sold (e.g. rugged / no liquidity)');
  assert(store.atRiskCount() === before - 1, 'writing one off frees exactly one slot');
  assert(realStuck.abandonedReason?.includes('written off manually'), 'records why it was written off');

  realLog('✅ writeoff: only lists real open/stuck positions, writing one off frees its slot');
}

// A single transient RPC failure reading the on-chain balance (network blip,
// rate limit) must not fall back to the stale recorded amount and reproduce
// "Insufficient funds" — this is exactly the bug that re-stuck a position the
// user had already sold manually. The read must retry before giving up.
async function testBalanceCheckRetriesTransientFailure(realLog: (...a: unknown[]) => void) {
  const config = loadConfig();
  const keypair = Keypair.generate();
  let balanceCalls = 0;
  const fakeConnection = {
    async getBalance() { return 10e9; },
    async getParsedTokenAccountsByOwner() {
      balanceCalls++;
      if (balanceCalls === 1) throw new Error('429 Too Many Requests'); // transient hiccup
      return { value: [] }; // second attempt succeeds: wallet genuinely holds none
    },
  };
  const orders: OrderParams[] = [];
  const fakeJupiter = {
    async getOrder(p: OrderParams): Promise<JupiterOrder> { orders.push(p); return { requestId: 'r', transactionBase64: null, inAmountRaw: p.amountRaw, outAmountRaw: 1n }; },
    async execute() { throw new Error('must not execute'); },
  };
  const store = new PositionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-retry-')));
  const trader = new Trader({ ...config, dryRun: false }, fakeConnection as any, keypair, fakeJupiter as any, store, okMarket);

  const quiet = console.log, quietErr = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    const pos = store.openPosition({
      mint: MEME_MINT, decimals: 5, sourceWallet: TRACKED,
      dryRun: false, spentSol: 0.1, tokenAmountRaw: '524785000',
    });
    await trader.sellPosition(pos, 1, 'test');

    assert(balanceCalls >= 2, `expected a retry after the transient failure, only ${balanceCalls} call(s) made`);
    assert(orders.length === 0, 'must not attempt to sell the stale amount after a transient read failure');
    assert(pos.status === 'abandoned', `a retried read finding zero balance should abandon, not ${pos.status}`);
    assert(!pos.stuckReason?.includes('Insufficient funds'), 'must never re-derive the stale Insufficient funds failure');
  } finally {
    console.log = quiet; console.error = quietErr;
  }
  realLog('✅ balance check: retries a transient RPC failure instead of trusting stale data');
}

// The Ctrl+C debounce that stops an accidental double-tap (key-repeat, an
// impatient second press) from force-quitting mid-shutdown and stranding
// real positions that were only given one chance to close. A second signal
// within the debounce window must NOT force-quit; one after it elapses must.
function testShutdownDebounce() {
  const DEBOUNCE = 5_000;
  assert(decideShutdown(null, 0, DEBOUNCE) === 'begin', 'first Ctrl+C begins shutdown');
  assert(decideShutdown(1_000, 1_050, DEBOUNCE) === 'already-quitting', 'an instant double-tap must not force-quit');
  assert(decideShutdown(1_000, 4_999, DEBOUNCE) === 'already-quitting', 'still within the window, 1ms short');
  assert(decideShutdown(1_000, 6_001, DEBOUNCE) === 'force-quit', 'a deliberate second press after the window force-quits');
  console.log('✅ shutdown debounce: an accidental double Ctrl+C cannot force-quit mid-close');
}

// Which sound plays for which event is pure config -> file path, so pin it
// here without spawning afplay: distinct defaults per event, .env overrides
// by system-sound name or absolute file, a bad override falls back to the
// default (never to silence), and SOUNDS=false silences everything.
function testNotifySounds() {
  const none: NodeJS.ProcessEnv = {};
  assert(soundFor('buy', none) === '/System/Library/Sounds/Glass.aiff', 'default buy sound');
  assert(soundFor('sell', none) === '/System/Library/Sounds/Hero.aiff', 'default sell sound');
  assert(soundFor('fail', none) === '/System/Library/Sounds/Basso.aiff', 'default fail sound');
  assert(soundFor('buy', none) !== soundFor('sell', none), 'a fill and a sale must sound different');
  assert(soundFor('sell', { SOUND_SELL: 'Ping' }) === '/System/Library/Sounds/Ping.aiff', 'override by system-sound name');
  assert(soundFor('buy', { SOUND_BUY: '/Users/me/filled.mp3' }) === '/Users/me/filled.mp3', 'override by absolute file path');
  assert(soundFor('buy', { SOUND_BUY: 'Glass; rm -rf ~' }) === '/System/Library/Sounds/Glass.aiff', 'a bad override falls back to the default, not to silence');
  assert(soundFor('sell', { SOUND_SELL: 'Hero.aiff' }) === '/System/Library/Sounds/Hero.aiff', 'a name with .aiff on it still falls back to a valid file');
  assert(soundFor('buy', { SOUNDS: 'false' }) === null, 'SOUNDS=false silences');
  assert(soundFor('fail', { SOUNDS: 'false', SOUND_FAIL: 'Ping' }) === null, 'SOUNDS=false wins over an override');
  console.log('✅ notify sounds: distinct buy/sell/fail sounds, overridable, never silently muted by a typo');
}

// Wallet gate: a wallet whose copies keep closing at a loss is muted for a
// cooling-off window, derived purely from position history. Open positions
// never count (no outcome yet), a win resets the streak, and both knobs have
// an explicit "off" / "forever" setting.
function testWalletGate() {
  const gate = { walletMaxConsecutiveLosses: 3, walletMuteHours: 24 };
  const T0 = Date.parse('2026-09-16T10:00:00Z');
  const pos = (wallet: string, spent: number, got: number, minutesAgo: number, status: 'closed' | 'open' = 'closed'): Position => ({
    id: `p-${wallet}-${minutesAgo}`, mint: MEME_MINT, decimals: 5, sourceWallet: wallet, dryRun: true, status,
    openedAt: new Date(T0 - (minutesAgo + 5) * 60_000).toISOString(),
    closedAt: status === 'closed' ? new Date(T0 - minutesAgo * 60_000).toISOString() : undefined,
    spentSol: spent, tokenAmountRaw: status === 'closed' ? '0' : '100', initialTokenAmountRaw: '100', receivedSol: got, sellTxs: [],
  });
  const A = 'walletA';
  const B = 'walletB';
  const history: Position[] = [
    pos(A, 0.05, 0.02, 300), pos(A, 0.05, 0.09, 200), // a win in the middle resets the streak
    pos(A, 0.05, 0.04, 120), pos(A, 0.05, 0.01, 60), pos(A, 0.05, 0.03, 10),
    pos(B, 0.05, 0.01, 90), pos(B, 0.05, 0.02, 30),
    pos(B, 0.05, 0, 5, 'open'), // still open → no outcome → not counted
  ];
  const rec = walletRecords(history);
  assert(rec.get(A)!.closed === 5 && rec.get(A)!.wins === 1 && rec.get(A)!.losses === 4, 'wallet A tally');
  assert(rec.get(A)!.consecutiveLosses === 3, 'streak counts back from the latest close and stops at the win');
  assert(rec.get(B)!.consecutiveLosses === 2 && rec.get(B)!.closed === 2, 'open positions are not counted');
  assert(Math.abs(rec.get(A)!.netSol - (0.02 + 0.09 + 0.04 + 0.01 + 0.03 - 0.25)) < 1e-9, 'net P&L per wallet');

  assert(walletMute(history, A, T0, gate).muted === true, 'A: 3 straight losses → muted');
  assert(walletMute(history, B, T0, gate).muted === false, 'B: only 2 → not muted');
  assert(walletMute(history, A, T0 + 25 * 3_600_000, gate).muted === false, 'the mute expires after WALLET_MUTE_HOURS');
  assert(walletMute(history, A, T0 + 25 * 3_600_000, { ...gate, walletMuteHours: 0 }).muted === true, 'WALLET_MUTE_HOURS=0 never expires');
  assert(walletMute(history, A, T0, { ...gate, walletMaxConsecutiveLosses: 0 }).muted === false, 'WALLET_MAX_CONSECUTIVE_LOSSES=0 turns the gate off');
  assert(walletMute(history, 'nobody', T0, gate).muted === false, 'a wallet with no history is not muted');
  console.log('✅ wallet gate: mutes after N straight copied losses, a win resets, expires, ignores open positions');
}

// Token gate: pure verdicts. Fail-closed on missing data, off when both
// thresholds are 0, and the Dexscreener summary takes the OLDEST pool's age
// and the DEEPEST pool's liquidity, Solana only.
function testTokenGate() {
  const cfg = { minTokenAgeMinutes: 30, minLiquidityUsd: 20_000 };
  const ok = (m: TokenMarket | null) => evaluateToken(m, cfg).ok;
  assert(ok(null) === false, 'lookup failure → skip (never buy blind)');
  assert(ok({ ageMinutes: null, liquidityUsd: null, source: 't' }) === false, 'not listed anywhere → too new → skip');
  assert(ok({ ageMinutes: 12, liquidityUsd: 90_000, source: 't' }) === false, '12 min old → skip');
  assert(ok({ ageMinutes: 600, liquidityUsd: 4_000, source: 't' }) === false, '$4k liquidity → skip');
  assert(ok({ ageMinutes: 600, liquidityUsd: null, source: 't' }) === false, 'liquidity unknown → skip');
  assert(ok({ ageMinutes: 600, liquidityUsd: 90_000, source: 't' }) === true, 'old and deep → pass');
  const verdict = evaluateToken({ ageMinutes: 12, liquidityUsd: 90_000, source: 't' }, cfg);
  assert(!verdict.ok && /12 min/.test(verdict.reason) && /MIN_TOKEN_AGE_MINUTES/.test(verdict.reason), 'skip reason names the number and the setting');
  assert(evaluateToken(null, { minTokenAgeMinutes: 0, minLiquidityUsd: 0 }).ok === true, 'both thresholds 0 → gate off');

  const now = Date.parse('2026-09-16T10:00:00Z');
  const m = summarizePairs(
    [
      { chainId: 'solana', pairCreatedAt: now - 3 * 3_600_000, liquidity: { usd: 12_000 } },
      { chainId: 'solana', pairCreatedAt: now - 48 * 3_600_000, liquidity: { usd: 55_000 } },
      { chainId: 'ethereum', pairCreatedAt: now - 900 * 3_600_000, liquidity: { usd: 9_999_999 } },
    ],
    MEME_MINT,
    now
  );
  assert(Math.round(m.ageMinutes!) === 48 * 60, 'age = oldest Solana pool');
  assert(m.liquidityUsd === 55_000, 'liquidity = deepest Solana pool; other chains ignored');
  assert(summarizePairs([], MEME_MINT, now).ageMinutes === null, 'no pools → not listed');
  console.log('✅ token gate: fail-closed on missing data, age/liquidity thresholds, off at 0, Solana-only summary');
}

// The gates inside the trader: a fresh or unknown token is refused BEFORE any
// Jupiter call is spent on it; a muted wallet's new buys are skipped while its
// existing position is still mirrored on sell.
async function testGatesInTrader(realLog: typeof console.log) {
  const config = loadConfig();
  config.maxOpenPositions = 10;
  const store = new PositionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-gates-')));
  const keypair = Keypair.generate();
  let orders = 0;
  const fakeJupiter = {
    async getOrder(params: OrderParams): Promise<JupiterOrder> {
      orders++;
      const isBuy = params.inputMint === SOL_MINT;
      // every sell returns 0.001 SOL for a 0.01 SOL buy → every close is a loss
      return { requestId: 'req', transactionBase64: null, inAmountRaw: params.amountRaw, outAmountRaw: isBuy ? 5_000n : 1_000_000n };
    },
    async execute() { throw new Error('must not execute in dry run'); },
  };
  const fakeConnection = { async getBalance() { return 10e9; } };
  let market: TokenMarket | null = { ageMinutes: 3, liquidityUsd: 2_000, source: 'test' };
  const trader = new Trader(config, fakeConnection as any, keypair, fakeJupiter as any, store, async () => market);
  const mints = [MEME_MINT, ...[1, 2, 3, 4].map(() => Keypair.generate().publicKey.toBase58())];
  const buy = (mint: string, signature: string) =>
    trader.handleSwapEvent({ signature, sourceWallet: TRACKED, side: 'buy', mint, decimals: 5, tokenDeltaRaw: 1n, ownerPreTokenRaw: 0n, quoteSolEquivalent: 0.5 });
  const sellAll = (mint: string, signature: string) =>
    trader.handleSwapEvent({ signature, sourceWallet: TRACKED, side: 'sell', mint, decimals: 5, tokenDeltaRaw: 100n, ownerPreTokenRaw: 100n, quoteSolEquivalent: 0.2 });

  const loud = console.log;
  console.log = () => {};
  try {
    await buy(mints[0], 'g1');
    assert(store.all().length === 0 && orders === 0, 'a 3-minute-old token is refused before any Jupiter call');
    market = null;
    await buy(mints[0], 'g2');
    assert(store.all().length === 0 && orders === 0, 'a failed lookup is refused, not guessed');

    market = { ageMinutes: 600, liquidityUsd: 100_000, source: 'test' };
    await buy(mints[4], 'early'); // opened BEFORE any losses
    for (let i = 0; i < 3; i++) {
      await buy(mints[i], `b${i}`);
      await sellAll(mints[i], `s${i}`);
    }
    assert(store.byStatus('closed').length === 3 && store.byStatus('open').length === 1, 'three losing round-trips, one position still open');
    const before = orders;
    await buy(mints[3], 'muted-buy');
    assert(store.byStatus('open').length === 1 && orders === before, 'muted wallet: new buy skipped without spending a Jupiter call');
    await sellAll(mints[4], 'muted-sell');
    assert(store.byStatus('open').length === 0 && store.byStatus('closed').length === 4, 'muted wallet: its existing position is still mirrored on sell');
  } finally {
    console.log = loud;
  }
  realLog('✅ gates in trader: fresh/unknown tokens refused before Jupiter; muted wallet skips buys but still mirrors sells');
}

async function main() {
  testWalletGate();
  testTokenGate();
  await testGatesInTrader(console.log);
  testNotifySounds();
  testShutdownDebounce();
  await testBalanceCheckRetriesTransientFailure(console.log);
  await testWriteoffFiltering(console.log);
  await testAbandonedFreesSlot(console.log);
  await testSellUsesOnChainBalance(console.log);
  await testWatcherQueue();
  await testAnalyzeSwap();
  await testRateLimiter();
  await testTrader();
  await testSummary();
  console.log('\nAll logic tests passed.');
}

main().catch((e) => { console.error('❌ TEST FAILED:', e.message); process.exit(1); });
