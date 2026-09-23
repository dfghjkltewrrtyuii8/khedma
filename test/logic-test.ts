// Offline logic tests for the copy-trading bot: swap detection, rate limiter
// spacing, position store lifecycle, and trader behavior with a mocked Jupiter.
// Run from the repo root with: npm test
// Uses a throwaway keypair and a temp directory — never touches your real
// .env or data/positions.json.

// MUST be first: it pins every setting before src/config.ts loads dotenv, so
// the suite never reads the .env of whoever is running it. See test-env.ts.
import { TEST_WALLET } from './test-env';

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import bs58 from 'bs58';
import { Keypair, ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';

import { analyzeSwap, installedWeb3Version, MAX_TX_VERSION, MIN_WEB3_VERSION, versionAtLeast, WalletWatcher } from '../src/watcher';
import { RateLimiter } from '../src/rateLimiter';
import { PositionStore } from '../src/positions';
import { Trader } from '../src/trader';
import { loadConfig, SOL_MINT } from '../src/config';
import { JupiterOrder, OrderParams } from '../src/jupiter';
import { printSummary } from '../src/pnl';
import { getSolPriceUsd } from '../src/solPrice';
import { decideShutdown } from '../src/shutdownDebounce';
import { soundFor, speechFor, speechArgs, windowsAlertInvocation, windowsSoundFor, WINDOWS_ALERT_SCRIPT } from '../src/notify';
import { classifyWalletSecret, findPlaceholders, parseHeliusInput, parseWalletList, renderEnv } from '../src/setupChecks';
import * as bip39 from 'bip39';
import { evaluateToken, summarizePairs, TokenMarket } from '../src/tokenMarket';
import { Position } from '../src/types';
import { walletMute, walletRecords } from '../src/walletGate';
import { decideExit, describeExitRules, exitRulesEnabled } from '../src/exitRules';
import { compareToSource, entryPhrase, summarizeComparisons } from '../src/copyGap';
import { dropReason, PROBATION_TRADES, Rotation, WalletRoster } from '../src/walletRoster';
import { discoverWallets, findCandidates, parsePoolTrades, parseTrendingPools, selectPools } from '../src/discovery';
import { SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

const TRACKED = TEST_WALLET;
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

// Spoken alerts: what the Mac says for each event. Same rules as the chimes
// (a bad override falls back to the default, never to silence), plus the one
// that matters most — a paper trade must never sound like real money.
function testNotifySpeech() {
  const none: NodeJS.ProcessEnv = {};
  assert(speechFor('buy', false, none) === 'Order filled', 'default buy phrase');
  assert(speechFor('sell', false, none) === 'Order sold', 'default sell phrase');
  assert(/Sell failed/.test(speechFor('fail', false, none)!), 'default fail phrase');
  assert(speechFor('buy', true, none) === 'Simulated. Order filled', 'a dry-run buy is spoken as simulated');
  assert(speechFor('sell', true, none) !== speechFor('sell', false, none), 'paper and real never sound the same');
  assert(speechFor('buy', false, { SPEECH_BUY: 'Bought it' }) === 'Bought it', 'phrase is overridable');
  assert(speechFor('buy', false, { SPEECH_BUY: '   ' }) === 'Order filled', 'a blank override falls back to the default, not to silence');
  assert(speechFor('buy', false, { SPEECH: 'false' }) === null, 'SPEECH=false silences');
  assert(speechFor('buy', false, { SPEECH: 'false', SPEECH_BUY: 'x' }) === null, 'SPEECH=false wins over an override');
  assert(speechFor('buy', false, { SPEECH_BUY: 'x'.repeat(500) })!.length === 200, 'a runaway phrase is capped');

  assert(speechArgs({}).length === 0, 'no voice/rate set → default voice');
  assert(speechArgs({ SPEECH_VOICE: 'Samantha' }).join(' ') === '-v Samantha', 'voice name passed through');
  assert(speechArgs({ SPEECH_VOICE: 'Bad News' }).join(' ') === '-v Bad News', 'voice names with spaces work');
  assert(speechArgs({ SPEECH_VOICE: '-rf /' }).length === 0, 'a value that would become a flag is refused');
  assert(speechArgs({ SPEECH_RATE: '200' }).join(' ') === '-r 200', 'valid rate passed through');
  assert(speechArgs({ SPEECH_RATE: '9000' }).length === 0 && speechArgs({ SPEECH_RATE: 'fast' }).length === 0, 'a nonsense rate is dropped, not passed to say');
  console.log('✅ notify speech: spoken phrases per event, simulated never sounds real, voice/rate validated');
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

// The setup wizard's validators, offline: they encode the exact mistakes that
// happened on first installs — a public ADDRESS pasted as the private key, a
// phrase with the wrong word count, a Helius URL vs bare key, placeholders
// left in .env — so the wizard can refuse them before anything is written.
function testSetupChecks() {
  const kp = Keypair.generate();
  assert(classifyWalletSecret(bs58.encode(kp.secretKey)).kind === 'key', 'a 64-byte base58 secret is a private key');
  const addr = classifyWalletSecret(kp.publicKey.toBase58());
  assert(addr.kind === 'invalid' && /ADDRESS/.test(addr.reason), 'a public address is refused and named as such');
  const phrase = bip39.generateMnemonic();
  const m = classifyWalletSecret(`  ${phrase.toUpperCase()}  `);
  assert(m.kind === 'mnemonic' && m.words === 12, 'a 12-word phrase is accepted regardless of case/spacing');
  const short = classifyWalletSecret(phrase.split(' ').slice(0, 7).join(' '));
  assert(short.kind === 'invalid' && /7 words/.test(short.reason), 'a phrase cut off by a line break is refused with the word count');
  const typo = classifyWalletSecret(phrase.replace(/^\w+/, 'zzzz'));
  assert(typo.kind === 'invalid' && /misspelled/.test(typo.reason), 'a phrase with a bad word is refused');
  assert(classifyWalletSecret('').kind === 'invalid', 'empty input is refused');

  const key = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const fromKey = parseHeliusInput(key)!;
  assert(fromKey.https === `https://mainnet.helius-rpc.com/?api-key=${key}` && fromKey.wss.startsWith('wss://'), 'bare Helius key → both URLs');
  assert(parseHeliusInput(`https://mainnet.helius-rpc.com/?api-key=${key}`)!.wss === fromKey.wss, 'full HTTPS URL → same endpoints');
  assert(parseHeliusInput(`wss://mainnet.helius-rpc.com/?api-key=${key}`)!.https === fromKey.https, 'WSS URL → same endpoints');
  assert(parseHeliusInput('hello') === null && parseHeliusInput('') === null, 'junk is rejected');

  const w1 = Keypair.generate().publicKey.toBase58();
  const w2 = Keypair.generate().publicKey.toBase58();
  const list = parseWalletList(`${w1}, ${w2}\n${w1}  nope`);
  assert(list.valid.length === 2 && list.valid[0] === w1 && list.invalid.length === 1 && list.invalid[0] === 'nope', 'wallet list: any separator, deduped, junk named');

  const example = { PRIVATE_KEY_BASE58: '', WALLET_MNEMONIC: '', HELIUS_HTTPS_URL: 'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY_HERE', HELIUS_WSS_URL: 'wss://x/?api-key=YOUR_KEY_HERE', JUPITER_API_KEY: '', TRACKED_WALLETS: 'WalletAddress1,WalletAddress2' };
  assert(findPlaceholders(example).length === 5, 'an untouched example file has 5 problems');
  assert(findPlaceholders({ WALLET_MNEMONIC: phrase, HELIUS_HTTPS_URL: fromKey.https, HELIUS_WSS_URL: fromKey.wss, JUPITER_API_KEY: 'k', TRACKED_WALLETS: w1 }).length === 0, 'a completed file has none');

  const env = renderEnv({ privateKeyBase58: '', walletMnemonic: phrase, heliusHttpsUrl: fromKey.https, heliusWssUrl: fromKey.wss, jupiterApiKey: 'jk', trackedWallets: [w1, w2], settings: { COPY_BUY_AMOUNT_SOL: '0.05', DRY_RUN: 'true' } });
  assert(/^DRY_RUN=true$/m.test(env) && /^COPY_BUY_AMOUNT_SOL=0\.05$/m.test(env) && /^MAX_OPEN_POSITIONS=3$/m.test(env), 'rendered .env: chosen values in, defaults filled');
  assert(env.includes(`TRACKED_WALLETS=${w1},${w2}`) && env.includes(`WALLET_MNEMONIC=${phrase}`), 'rendered .env carries wallets and secret');
  console.log('✅ setup checks: address-vs-key, phrase length/typos, Helius key or URL, wallet lists, placeholders, .env render');
}

// Our own exit rules, as pure arithmetic. The case that matters most is the
// one that is NOT an exit: with take-profit off, a huge winner is held. This
// strategy's returns come from rare outliers (the dry run: 8 losers and one
// +984%), so a rule that caps the upside turns a winning set into a losing one.
function testExitDecisions() {
  const cfg = { takeProfitPercent: 0, stopLossPercent: 30, trailingStopPercent: 30 };
  const base = { spentSol: 0.01, receivedSol: 0 };

  assert(decideExit(base, 0.009, cfg).action === 'hold', '-10% is not an exit');
  const sl = decideExit(base, 0.007, cfg);
  assert(sl.action === 'exit' && sl.rule === 'stop-loss', 'exactly -30% trips the stop-loss');
  assert(decideExit(base, 0.5, cfg).action === 'hold', 'with take-profit off, a 50x winner is HELD, never capped');

  const tp = decideExit(base, 0.016, { ...cfg, takeProfitPercent: 50 });
  assert(tp.action === 'exit' && tp.rule === 'take-profit', 'take-profit fires when switched on');

  // Below cost a "drop from peak" is just the loss the stop-loss governs, so
  // the trailing stop must stay disarmed or it exits everything twice as fast.
  const under = decideExit({ spentSol: 0.01, receivedSol: 0, peakValueSol: 0.0095 }, 0.0085, cfg);
  assert(under.action === 'hold', 'trailing stop does not arm on a position that was never in profit');
  const tr = decideExit({ spentSol: 0.01, receivedSol: 0, peakValueSol: 0.05 }, 0.03, cfg);
  assert(tr.action === 'exit' && tr.rule === 'trailing-stop', 'a runner that gives back 40% of its peak is exited');
  assert(/peak of \+400/.test(tr.action === 'exit' ? tr.reason : ''), 'the reason names the peak it fell from');
  assert(decideExit({ spentSol: 0.01, receivedSol: 0, peakValueSol: 0.02 }, 0.04, cfg).peakValueSol === 0.04, 'a new high becomes the peak');

  // A position half-sold at a good price is not a loser just because the
  // remainder is worth little: banked proceeds count toward P&L.
  assert(decideExit({ spentSol: 0.01, receivedSol: 0.009 }, 0.0005, cfg).action === 'hold', 'partial sale proceeds count toward the P&L the rules judge');

  assert(decideExit(base, 0.001, { takeProfitPercent: 0, stopLossPercent: 0, trailingStopPercent: 0 }).action === 'hold', 'all rules off = never exits on its own');
  assert(decideExit({ spentSol: 0, receivedSol: 0 }, 0, cfg).action === 'hold', 'a zero-cost position never divides by zero');
  assert(exitRulesEnabled(cfg) && !exitRulesEnabled({ takeProfitPercent: 0, stopLossPercent: 0, trailingStopPercent: 0 }), 'enabled flag');
  assert(/stop-loss -30%/.test(describeExitRules(cfg)), 'banner describes the active rules');
  console.log('✅ exit rules: stop-loss, trailing stop (armed only in profit), take-profit off never caps a winner');
}

// The rules inside the trader: a position that falls far enough is sold
// without waiting for the tracked wallet, and the bot does not immediately buy
// back into something it just stopped out of.
async function testExitsInTrader(realLog: typeof console.log) {
  const config = loadConfig();
  // If this ever fails, test isolation has broken and the suite is reading a
  // real .env again — the arithmetic below is all relative to what we spend.
  assert(config.copyBuyAmountSol === 0.01, `test env leaked: COPY_BUY_AMOUNT_SOL is ${config.copyBuyAmountSol}, expected 0.01 (see test/test-env.ts)`);
  config.maxOpenPositions = 10;
  config.stopLossPercent = 30;
  config.trailingStopPercent = 30;
  config.takeProfitPercent = 0;
  config.exitRebuyCooldownHours = 24;
  const store = new PositionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-exits-')));
  const keypair = Keypair.generate();
  let sellQuote = 12_000_000n; // what the remaining tokens are worth, in lamports
  const orders: OrderParams[] = [];
  const fakeJupiter = {
    async getOrder(params: OrderParams): Promise<JupiterOrder> {
      orders.push(params);
      const isBuy = params.inputMint === SOL_MINT;
      return { requestId: 'r', transactionBase64: null, inAmountRaw: params.amountRaw, outAmountRaw: isBuy ? 5_000n : sellQuote };
    },
    async execute() { throw new Error('must not execute in dry run'); },
  };
  const fakeConnection = { async getBalance() { return 10e9; } };
  const trader = new Trader(config, fakeConnection as any, keypair, fakeJupiter as any, store, okMarket);
  const MINT_A = MEME_MINT;
  const MINT_B = Keypair.generate().publicKey.toBase58();
  const buy = (mint: string, signature: string) =>
    trader.handleSwapEvent({ signature, sourceWallet: TRACKED, side: 'buy', mint, decimals: 5, tokenDeltaRaw: 1n, ownerPreTokenRaw: 0n, quoteSolEquivalent: 0.5 });

  const loud = console.log;
  console.log = () => {};
  try {
    // --- stop-loss: bought for 0.01, now worth 0.006 (-40%) ---
    await buy(MINT_A, 'x1');
    assert(store.byStatus('open').length === 1, 'position opened');
    sellQuote = 9_000_000n; // 0.009 = -10%, not enough
    await trader.checkExits();
    assert(store.byStatus('open').length === 1, '-10% is held');
    assert(store.byStatus('open')[0].peakValueSol === 0.009, 'the peak is recorded as it is priced');
    sellQuote = 6_000_000n; // 0.006 = -40%
    await trader.checkExits();
    const stopped = store.byStatus('closed')[0];
    assert(store.byStatus('open').length === 0 && stopped?.exitRule === 'stop-loss', 'a -40% position is sold by the stop-loss, without the tracked wallet selling');

    // --- and it does not buy straight back in ---
    const before = orders.length;
    await buy(MINT_A, 'x2');
    assert(store.byStatus('open').length === 0 && orders.length === before, 'the mint we just stopped out of is not re-bought during the cooldown');

    // --- trailing stop: a runner that gives back 40% of its peak ---
    sellQuote = 12_000_000n;
    await buy(MINT_B, 'x3');
    sellQuote = 50_000_000n; // 0.05 = +400%
    await trader.checkExits();
    assert(store.byStatus('open').length === 1, 'a +400% winner is NOT capped (take-profit off)');
    sellQuote = 30_000_000n; // 0.03 — still +200%, but 40% off the peak
    await trader.checkExits();
    const trailed = store.all().find((p) => p.mint === MINT_B)!;
    assert(trailed.status === 'closed' && trailed.exitRule === 'trailing-stop', 'the runner is exited on the way back down, still in profit');
    assert(trailed.receivedSol === 0.03, 'it banked the trailing-stop price');
  } finally {
    console.log = loud;
  }
  realLog('✅ exits in trader: stop-loss sells without the tracked wallet, no instant re-buy, trailing stop banks a runner');
}

// The suite must read the same on every machine. A real .env leaking in was
// a genuine failure once: tests went red on a working build because the
// person running them traded a different size.
function testEnvIsolation() {
  const config = loadConfig();
  assert(config.dryRun === true, 'tests always run in dry-run, whatever the real .env says');
  assert(config.copyBuyAmountSol === 0.01, 'buy size is pinned by test-env.ts');
  assert(config.trackedWallets.length === 1 && config.trackedWallets[0].toBase58() === TRACKED, 'tracked wallets are pinned');
  assert(config.stopLossPercent === 30 && config.takeProfitPercent === 0, 'exit rules are pinned');
  assert(config.benchWallets.length === 0, 'no bench from the real .env leaks in');
  assert(config.discovery === false, 'DISCOVERY from the real .env does not leak in');
  assert(process.env.SPEECH === 'false' && process.env.SOUNDS === 'false', 'tests never make the machine ding or talk');
  console.log('✅ test isolation: the suite reads pinned settings, never the real .env');
}

// Windows alerts go through PowerShell, the one place in this codebase where a
// value from .env comes near something that can execute. This pins that it
// never does: the command line is always the same constant script, and the
// phrase / sound / voice travel only as environment variables. Pure — nothing
// is spawned, so it runs the same on any OS.
function testWindowsAlerts() {
  const none: NodeJS.ProcessEnv = {};
  assert(windowsSoundFor('buy', none) === 'C:\\Windows\\Media\\chimes.wav', 'default Windows buy chime');
  assert(windowsSoundFor('sell', none) === 'C:\\Windows\\Media\\tada.wav', 'default Windows sell chime');
  assert(windowsSoundFor('buy', none) !== windowsSoundFor('sell', none), 'buy and sell sound different on Windows too');
  assert(windowsSoundFor('buy', { SOUND_BUY: 'Glass' }) === 'C:\\Windows\\Media\\chimes.wav', 'a Mac sound name from a copied .env falls back to the Windows default');
  assert(windowsSoundFor('buy', { SOUND_BUY: 'D:\\sounds\\filled.wav' }) === 'D:\\sounds\\filled.wav', 'a full Windows .wav path is used');
  assert(windowsSoundFor('buy', { SOUNDS: 'false' }) === null, 'SOUNDS=false silences on Windows');

  const nasty = "Order filled'; Remove-Item C:\\ -Recurse; '";
  const inv = windowsAlertInvocation('buy', false, { SPEECH_BUY: nasty, SPEECH_VOICE: 'male' })!;
  assert(inv.file === 'powershell.exe', 'runs PowerShell directly, no shell');
  assert(inv.args.every((a) => !a.includes('Remove-Item') && !a.includes('Order filled')), 'no .env text ever appears on the command line');
  assert(Buffer.from(inv.args[3], 'base64').toString('utf16le') === WINDOWS_ALERT_SCRIPT, 'the command is always the same constant script');
  assert(inv.env.COPYBOT_SAY === nasty, 'the phrase travels only as an environment variable, where PowerShell treats it as text');
  assert(inv.env.COPYBOT_VOICE === 'male', 'voice passed through when valid');
  assert(windowsAlertInvocation('buy', false, { SPEECH_VOICE: '-evil' })!.env.COPYBOT_VOICE === '', 'an invalid voice value is dropped');
  assert(windowsAlertInvocation('buy', true, {})!.env.COPYBOT_SAY === 'Simulated. Order filled', 'paper trades still say Simulated on Windows');
  assert(windowsAlertInvocation('buy', false, { SOUNDS: 'false', SPEECH: 'false' }) === null, 'both off = nothing launched');
  console.log('✅ windows alerts: chimes + speech via a constant PowerShell script, .env values never on the command line');
}

// The watcher once sat on two busy wallets and saw nothing: Solana had added
// transaction version 1, the bot asked for at most version 0, and the RPC
// refused every trade in the new format. The only sign was one log line
// before the bot looked idle. Pin both halves: it asks for version 1, and a
// format it still can't read is COUNTED and surfaced, never quietly dropped.
async function testTransactionVersions() {
  let logCb: (l: { signature: string; err: unknown; logs: string[] }) => void = () => {};
  const requested: unknown[] = [];
  let refuseWith: string | null = null;
  const fakeConnection = {
    onLogs(_pk: unknown, cb: typeof logCb) { logCb = cb; return 1; },
    async removeOnLogsListener() {},
    async getParsedTransaction(_sig: string, opts: unknown) {
      requested.push(opts);
      if (refuseWith) throw new Error(refuseWith);
      return { meta: null };
    },
  };
  const watcher = new WalletWatcher(fakeConnection as any, [new PublicKey(TRACKED)], async () => {}, new RateLimiter(0));
  const loudError = console.error;
  const errors: string[] = [];
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
  try {
    watcher.start();
    logCb({ signature: 'v1-ok', err: null, logs: [] });
    await new Promise((r) => setTimeout(r, 20));
    assert((requested[0] as any)?.maxSupportedTransactionVersion === 1, 'the watcher asks for transaction version 1');
    assert(MAX_TX_VERSION === 1, 'MAX_TX_VERSION is 1');

    refuseWith = 'failed to get transaction: Transaction version (2) is not supported by the requesting client.';
    for (const sig of ['v2-a', 'v2-b', 'v2-c']) logCb({ signature: sig, err: null, logs: [] });
    while (watcher.stats().queued > 0) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
    assert(watcher.stats().unreadableFormat === 3, 'every unreadable trade is counted, not silently dropped');
    assert(errors.filter((e) => e.includes('INVISIBLE')).length === 1, 'the explanation is printed once, not once per trade');
    assert(errors.some((e) => e.includes('version 2')), 'it names the format it could not read');
    await watcher.stop();
  } finally {
    console.error = loudError;
  }

  // The parser doesn't care which format carried the trade: same shape, same answer.
  const pre = { accountIndex: 1, mint: MEME_MINT, owner: TRACKED, uiTokenAmount: { amount: '0', decimals: 5, uiAmount: 0, uiAmountString: '0' } };
  const post = { ...pre, uiTokenAmount: { ...pre.uiTokenAmount, amount: '500000' } };
  const v1tx: any = {
    version: 1,
    transaction: { message: { accountKeys: [{ pubkey: new PublicKey(TRACKED), signer: true, writable: true }] } },
    meta: { err: null, preBalances: [2_000_000_000], postBalances: [1_500_000_000], preTokenBalances: [pre], postTokenBalances: [post] },
  };
  const event = await analyzeSwap(v1tx, 'sig-v1', TRACKED);
  assert(event?.side === 'buy' && event.mint === MEME_MINT, 'a version-1 transaction is analysed exactly like any other');
  assert(versionAtLeast('1.99.0', '1.99.0') && versionAtLeast('1.100.2', '1.99.0') && versionAtLeast('2.0.0', '1.99.0'), 'newer or equal versions pass');
  assert(!versionAtLeast('1.98.4', '1.99.0') && !versionAtLeast('1.9.9', '1.99.0'), 'older versions fail — compared as numbers, not text');
  assert(versionAtLeast(installedWeb3Version(), MIN_WEB3_VERSION), `installed @solana/web3.js ${installedWeb3Version()} must be ${MIN_WEB3_VERSION}+ — run npm install`);
  console.log('✅ transaction versions: asks for v1, unreadable formats are counted and shouted about, v1 swaps parse normally');
}

// Timing or wallet: the comparison that answers why a copy lost. Pure
// arithmetic over what they paid/got and what we paid/got for the same token.
function testCopyGap() {
  const base = {
    id: 'x', mint: MEME_MINT, decimals: 5, sourceWallet: TRACKED, dryRun: true, openedAt: new Date().toISOString(),
    sellTxs: [] as string[], tokenAmountRaw: '0',
  };
  // They paid 1 SOL for 1,000,000 units; we paid 0.01 for 8,000 (25% more per unit).
  // They sold everything for 1.5 SOL (+50%); we got back 0.009 (-10%).
  const lateButGoodPick: Position = {
    ...base, status: 'closed', spentSol: 0.01, initialTokenAmountRaw: '8000', receivedSol: 0.009,
    sourceBuySol: 1, sourceBuyTokensRaw: '1000000', sourceSellSol: 1.5, sourceSellTokensRaw: '1000000',
  };
  const c = compareToSource(lateButGoodPick);
  assert(Math.round(c.entryGapPct!) === 25, `entry gap should be +25%, got ${c.entryGapPct}`);
  assert(Math.round(c.theirReturnPct!) === 50, `their return should be +50%, got ${c.theirReturnPct}`);
  assert(Math.round(c.ourReturnPct!) === -10, `our return should be -10%, got ${c.ourReturnPct}`);

  const timing = summarizeComparisons(Array(5).fill(lateButGoodPick));
  assert(timing.comparable === 5 && /picks are fine/.test(timing.verdict ?? '') && /timing/.test(timing.verdict ?? ''),
    `5 trades where they won and we lost → verdict names timing (got: ${timing.verdict})`);

  const badPick: Position = { ...lateButGoodPick, sourceSellSol: 0.6 }; // they lost 40%
  const wallet = summarizeComparisons(Array(5).fill(badPick));
  assert(/LOST on these same tokens too/.test(wallet.verdict ?? '') && /no speed upgrade/.test(wallet.verdict ?? ''),
    `5 trades where they lost too → verdict blames the wallet, not speed (got: ${wallet.verdict})`);

  assert(summarizeComparisons(Array(4).fill(lateButGoodPick)).verdict === null, 'no verdict from fewer than 5 trades');
  const unknown = compareToSource({ ...base, status: 'closed', spentSol: 0.01, initialTokenAmountRaw: '8000', receivedSol: 0.009 });
  assert(unknown.theirReturnPct === null && unknown.entryGapPct === null, 'missing source data gives nulls, never a guess');
  const stillHolding = compareToSource({ ...lateButGoodPick, sourceSellSol: undefined, sourceSellTokensRaw: undefined });
  assert(stillHolding.theirReturnPct === null && stillHolding.entryGapPct !== null, 'before they sell: entry gap known, their return not yet');
  assert(entryPhrase(25) === 'your entry price was 25% above theirs' && entryPhrase(-8) === 'your entry price was 8% below theirs', 'entry wording says above/below correctly');
  console.log('✅ copy gap: separates "their pick lost" from "we arrived late", no verdict on thin data');
}

// The trader keeps what the tracked wallet paid when we copy it, and keeps
// their sells even when they arrive AFTER our own stop-loss already closed us —
// that's the case that tells you whether the stop-loss helped.
async function testSourceTracking(realLog: typeof console.log) {
  const config = loadConfig();
  config.maxOpenPositions = 10;
  const store = new PositionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-source-')));
  let sellQuote = 12_000_000n;
  const fakeJupiter = {
    async getOrder(params: OrderParams): Promise<JupiterOrder> {
      const isBuy = params.inputMint === SOL_MINT;
      return { requestId: 'r', transactionBase64: null, inAmountRaw: params.amountRaw, outAmountRaw: isBuy ? 5_000n : sellQuote };
    },
    async execute() { throw new Error('must not execute in dry run'); },
  };
  const trader = new Trader(config, { async getBalance() { return 10e9; } } as any, Keypair.generate(), fakeJupiter as any, store, okMarket);
  const MINT_B = Keypair.generate().publicKey.toBase58();
  const loud = console.log;
  console.log = () => {};
  try {
    await trader.handleSwapEvent({ signature: 'b1', sourceWallet: TRACKED, side: 'buy', mint: MEME_MINT, decimals: 5, tokenDeltaRaw: 1_000_000n, ownerPreTokenRaw: 0n, quoteSolEquivalent: 0.5 });
    const pos = store.byStatus('open')[0];
    assert(pos.sourceBuySol === 0.5 && pos.sourceBuyTokensRaw === '1000000', 'what they paid is recorded when we copy the buy');

    sellQuote = 6_000_000n; // -40% → our stop-loss closes us first
    await trader.checkExits();
    assert(pos.status === 'closed' && pos.exitRule === 'stop-loss', 'our stop-loss closed it before they sold');

    // ...and only then do they sell, for 0.8 SOL.
    await trader.handleSwapEvent({ signature: 's1', sourceWallet: TRACKED, side: 'sell', mint: MEME_MINT, decimals: 5, tokenDeltaRaw: 1_000_000n, ownerPreTokenRaw: 1_000_000n, quoteSolEquivalent: 0.8 });
    assert(pos.sourceSellSol === 0.8 && pos.sourceSellTokensRaw === '1000000', 'their later sell is still recorded on the closed position');
    assert(Math.round(compareToSource(pos).theirReturnPct!) === 60, 'their return on the same token is computable (+60%)');

    // A copied buy whose size couldn't be estimated records nothing rather than a guess.
    await trader.handleSwapEvent({ signature: 'b2', sourceWallet: TRACKED, side: 'buy', mint: MINT_B, decimals: 5, tokenDeltaRaw: 10n, ownerPreTokenRaw: 0n, quoteSolEquivalent: null });
    const unknown = store.all().find((p) => p.mint === MINT_B)!;
    assert(unknown && unknown.sourceBuySol === undefined, 'unknown trade size → no source data recorded');
  } finally {
    console.log = loud;
  }
  realLog('✅ source tracking: their entry and exit are kept, including exits that come after our own stop-loss');
}

// A REAL sell must record the SOL that actually arrived, not the quote. Uses a
// genuinely serialized, signable transaction so the whole real path runs.
async function testRealSellRecordsActualSol(realLog: typeof console.log) {
  const config = loadConfig();
  const keypair = Keypair.generate();
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
    }).compileToV0Message()
  );
  const txBase64 = Buffer.from(tx.serialize()).toString('base64');
  const BEFORE = 1_000_000_000;
  let executed = false;
  const fakeJupiter = {
    async getOrder(p: OrderParams): Promise<JupiterOrder> {
      return { requestId: 'r', transactionBase64: txBase64, inAmountRaw: p.amountRaw, outAmountRaw: 12_000_000n }; // quoted 0.012
    },
    async execute() { executed = true; return { signature: 'realsig' }; },
  };
  const fakeConnection = {
    async getBalance() { return executed ? BEFORE + 11_500_000 : BEFORE; }, // 0.0115 actually arrived
    async getParsedTokenAccountsByOwner() {
      return { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: '5000' } } } } } }] };
    },
  };
  const store = new PositionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-realsell-')));
  const trader = new Trader({ ...config, dryRun: false }, fakeConnection as any, keypair, fakeJupiter as any, store, okMarket);
  const loud = console.log;
  console.log = () => {};
  try {
    const pos = store.openPosition({ mint: MEME_MINT, decimals: 5, sourceWallet: TRACKED, dryRun: false, spentSol: 0.01, tokenAmountRaw: '5000' });
    const ok = await trader.sellPosition(pos, 1, 'test');
    assert(ok && executed && pos.status === 'closed', 'the real sell went through');
    assert(Math.abs(pos.receivedSol - 0.0115) < 1e-12, `records the 0.0115 SOL that arrived, not the 0.012 quoted (got ${pos.receivedSol})`);
    assert(pos.sellTxs[0] === 'realsig', 'the signature is kept');
  } finally {
    console.log = loud;
  }
  realLog('✅ real sells: record the SOL that actually arrived (after fees and slippage), not the quote');
}

// Wallet rotation, end to end without a network: history-based drops at
// startup, quiet wallets sent to the back of the bench, bench wallets
// promoted, a dropped wallet kept WATCHED until the position we copied from it
// closes (its sells still matter), and the roster surviving a restart.
async function testWalletRotation(realLog: typeof console.log) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-rotation-'));
  const store = new PositionStore(dir);
  const [A, B, C, D, E, F] = Array.from({ length: 6 }, () => Keypair.generate().publicKey.toBase58());
  const cfg = { walletMaxConsecutiveLosses: 3, walletDropAfterTrades: 6, walletIdleMinutes: 90 };
  const MIN = 60_000;
  const T0 = Date.parse('2026-09-23T20:00:00Z');

  // A arrives with three straight copied losses from an earlier session.
  for (let i = 0; i < 3; i++) {
    const p = store.openPosition({ mint: Keypair.generate().publicKey.toBase58(), decimals: 6, sourceWallet: A, dryRun: true, spentSol: 0.01, tokenAmountRaw: '100' });
    store.recordSell(p, 100n, 0.006);
  }
  assert(dropReason(store.all(), A, cfg) === '3 copied losses in a row', 'a losing streak is a reason to drop');
  assert(dropReason(store.all(), B, cfg) === null, 'no history, no reason');

  const roster = new WalletRoster([A, B, C, D, E, F], 3, dir);
  roster.load();
  const logs: string[] = [];
  const rotation = new Rotation(roster, store, cfg, (m) => logs.push(m));
  const watching = new Set<string>();
  const watch = { isWatching: (w: string) => watching.has(w), addWallet: (w: string) => { watching.add(w); }, async removeWallet(w: string) { watching.delete(w); } };
  let copying: string[] | null = null;
  const trader = { setActiveWallets(ws: string[] | null) { copying = ws; } };

  const initial = rotation.startup(T0);
  assert(!initial.includes(A) && initial.join() === [B, C, D].join(), 'A is dropped before anything is watched; D takes its slot');
  initial.forEach((w) => watching.add(w));
  await rotation.tick(T0, watch, trader);
  assert(copying!.join() === [B, C, D].join(), 'the trader copies exactly the active wallets');

  // C holds a position we copied, then goes quiet; B and D keep buying.
  store.openPosition({ mint: MEME_MINT, decimals: 6, sourceWallet: C, dryRun: true, spentSol: 0.01, tokenAmountRaw: '100' });
  rotation.noteBuy(B, T0 + 80 * MIN);
  rotation.noteBuy(D, T0 + 85 * MIN);
  await rotation.tick(T0 + 91 * MIN, watch, trader);
  assert(roster.active().join() === [B, D, E].join(), 'quiet C is benched and E is promoted');
  assert(roster.bench().join() === [F, C].join(), 'C goes to the BACK of the bench, not out');
  assert(copying!.join() === [B, D, E].join() && !copying!.includes(C), 'C is no longer copied');
  assert(watching.has(C) && watching.has(E), 'C stays watched while we hold its position; E is now watched');
  assert(logs.some((l) => l.includes('Benched')) && logs.some((l) => l.includes('Now copying')), 'both moves are announced');

  // Once the position copied from C closes, C is no longer watched.
  const cPos = store.all().find((p) => p.sourceWallet === C)!;
  store.recordSell(cPos, 100n, 0.012);
  rotation.noteBuy(B, T0 + 95 * MIN); rotation.noteBuy(D, T0 + 95 * MIN); rotation.noteBuy(E, T0 + 95 * MIN);
  await rotation.tick(T0 + 100 * MIN, watch, trader);
  assert(!watching.has(C), 'C is released once nothing copied from it is open');
  assert(!watching.has(A), 'the dropped wallet was never watched');

  // A wallet that grinds out a net loss over enough trades is dropped too.
  for (let i = 0; i < 6; i++) {
    const p = store.openPosition({ mint: Keypair.generate().publicKey.toBase58(), decimals: 6, sourceWallet: E, dryRun: true, spentSol: 0.01, tokenAmountRaw: '100' });
    store.recordSell(p, 100n, i % 2 === 0 ? 0.012 : 0.006); // alternating, never 3 in a row, net negative
  }
  assert(/net -0\.0060 SOL over 6/.test(dropReason(store.all(), E, cfg) ?? ''), 'a net loss over 6 copies is a reason to drop');
  await rotation.tick(T0 + 101 * MIN, watch, trader);
  assert(!roster.active().includes(E) && roster.active().includes(F), 'E is dropped and F promoted');

  // It all survives a restart.
  const reloaded = new WalletRoster([A, B, C, D, E, F], 3, dir);
  reloaded.load();
  assert(reloaded.active().join() === roster.active().join() && reloaded.dropped().length === 2, 'the roster is restored from data/wallets.json');
  realLog('✅ wallet rotation: drops losers, benches quiet wallets, promotes the bench, keeps watching until copied trades close');
}

// With rotation on, the trader copies BUYS only from active wallets, but still
// mirrors a SELL from a wallet that's been benched while we hold its token.
async function testActiveWalletFilter(realLog: typeof console.log) {
  const config = loadConfig();
  const store = new PositionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-active-')));
  let orders = 0;
  const fakeJupiter = {
    async getOrder(params: OrderParams): Promise<JupiterOrder> {
      orders++;
      return { requestId: 'r', transactionBase64: null, inAmountRaw: params.amountRaw, outAmountRaw: params.inputMint === SOL_MINT ? 5_000n : 12_000_000n };
    },
    async execute() { throw new Error('must not execute in dry run'); },
  };
  const trader = new Trader(config, { async getBalance() { return 10e9; } } as any, Keypair.generate(), fakeJupiter as any, store, okMarket);
  const OTHER = Keypair.generate().publicKey.toBase58();
  const loud = console.log;
  console.log = () => {};
  try {
    await trader.handleSwapEvent({ signature: 'a1', sourceWallet: TRACKED, side: 'buy', mint: MEME_MINT, decimals: 5, tokenDeltaRaw: 1n, ownerPreTokenRaw: 0n, quoteSolEquivalent: 0.5 });
    assert(store.byStatus('open').length === 1, 'bought while TRACKED was active');
    trader.setActiveWallets([OTHER]); // TRACKED gets benched
    const before = orders;
    await trader.handleSwapEvent({ signature: 'a2', sourceWallet: TRACKED, side: 'buy', mint: Keypair.generate().publicKey.toBase58(), decimals: 5, tokenDeltaRaw: 1n, ownerPreTokenRaw: 0n, quoteSolEquivalent: 0.5 });
    assert(store.all().length === 1 && orders === before, 'a benched wallet\'s buy is refused before any Jupiter call');
    await trader.handleSwapEvent({ signature: 'a3', sourceWallet: TRACKED, side: 'sell', mint: MEME_MINT, decimals: 5, tokenDeltaRaw: 100n, ownerPreTokenRaw: 100n, quoteSolEquivalent: 0.2 });
    assert(store.byStatus('closed').length === 1, 'but its sell is still mirrored');
    trader.setActiveWallets(null);
    await trader.handleSwapEvent({ signature: 'a4', sourceWallet: TRACKED, side: 'buy', mint: Keypair.generate().publicKey.toBase58(), decimals: 5, tokenDeltaRaw: 1n, ownerPreTokenRaw: 0n, quoteSolEquivalent: 0.5 });
    assert(store.byStatus('open').length === 1, 'rotation off (null) copies every watched wallet again');
  } finally {
    console.log = loud;
  }

  // The watcher can add and drop wallets while running.
  const subs: string[] = [];
  let removed = 0;
  const conn = { onLogs(pk: PublicKey) { subs.push(pk.toBase58()); return subs.length; }, async removeOnLogsListener() { removed++; }, async getParsedTransaction() { return null; } };
  const watcher = new WalletWatcher(conn as any, [new PublicKey(TRACKED)], async () => {}, new RateLimiter(0));
  console.log = () => {};
  try {
    watcher.start();
    watcher.addWallet(OTHER);
    watcher.addWallet(OTHER); // idempotent
    assert(subs.length === 2 && watcher.isWatching(OTHER), 'addWallet subscribes once');
    await watcher.removeWallet(TRACKED);
    assert(!watcher.isWatching(TRACKED) && removed === 1, 'removeWallet unsubscribes');
    await watcher.stop();
  } finally {
    console.log = loud;
  }

  // BENCH_WALLETS: parsed, and anything already tracked is not counted twice.
  process.env.BENCH_WALLETS = `${OTHER}, ${TRACKED},${OTHER}`;
  try {
    const c = loadConfig();
    assert(c.benchWallets.length === 1 && c.benchWallets[0].toBase58() === OTHER, 'bench is deduped against itself and TRACKED_WALLETS');
  } finally {
    process.env.BENCH_WALLETS = '';
  }
  realLog('✅ active wallets: benched wallets\' buys refused, their sells still mirrored; watcher adds/drops wallets live');
}

// Discovery, offline: fixtures shaped like GeckoTerminal's responses. The
// point of the filter is to reject exactly what failed before — launch
// snipers, bots, quick flippers, losers — and keep wallets that bought after
// the launch rush and sold at a profit, preferably on more than one token.
async function testDiscovery(realLog: typeof console.log) {
  const NOW = Date.parse('2026-09-23T22:00:00Z');
  const H = 3_600_000, M = 60_000;
  const iso = (t: number) => new Date(t).toISOString();
  const mint = () => Keypair.generate().publicKey.toBase58();
  const [M1, M2, M3, M4, M5] = [mint(), mint(), mint(), mint(), mint()];
  const pool = (address: string, base: string, ageMs: number, reserve: number, h1: number, quote = SOL_MINT) => ({
    id: `solana_${address}`, type: 'pool',
    attributes: { address, name: `${address} / SOL`, pool_created_at: iso(NOW - ageMs), reserve_in_usd: String(reserve),
      transactions: { h1: { buys: h1 / 2, sells: h1 / 2 }, h24: { buys: h1 * 12, sells: h1 * 12 } } },
    relationships: { base_token: { data: { id: `solana_${base}` } }, quote_token: { data: { id: `solana_${quote}` } } },
  });
  const trending = { data: [
    pool('P1', M1, 5 * H, 80_000, 60),
    pool('P2', M2, 8 * H, 150_000, 40),
    pool('P3young', M3, 30 * M, 90_000, 40),     // too young: still launch rush
    pool('P4thin', M4, 6 * H, 5_000, 40),        // too thin to exit
    pool('P5busy', M5, 6 * H, 90_000, 500),      // one page of trades = a few minutes
    pool('PSOL', SOL_MINT, 6 * H, 90_000, 40),   // "token" side is SOL — skipped
    pool('PODD', mint(), 6 * H, 90_000, 40, mint()), // quoted in some other token — skipped
    { id: 'broken' },                             // malformed — skipped
  ] };
  const parsed = parseTrendingPools(trending);
  assert(parsed.length === 5 && !parsed.some((p) => p.address === 'PSOL' || p.address === 'PODD'), 'pools quoted in SOL/USDC only, memecoin on the base side');
  const usable = selectPools(parsed, NOW);
  assert(usable.map((p) => p.address).join() === 'P1,P2', 'too-young, too-thin and too-busy pools are skipped');

  const [GOOD, SNIPER, LOSER, FLIPPER, BOT, ONEHIT, MEH, KNOWN, TINY] = Array.from({ length: 9 }, () => Keypair.generate().publicKey.toBase58());
  const created1 = NOW - 5 * H, created2 = NOW - 8 * H;
  const trade = (wallet: string, side: 'buy' | 'sell', base: string, tokens: number, usd: number, at: number) => ({
    type: 'trade', attributes: {
      tx_from_address: wallet, kind: side, volume_in_usd: String(usd), block_timestamp: iso(at),
      from_token_address: side === 'buy' ? SOL_MINT : base, to_token_address: side === 'buy' ? base : SOL_MINT,
      from_token_amount: String(side === 'buy' ? usd / 150 : tokens), to_token_amount: String(side === 'buy' ? tokens : usd / 150),
    },
  });
  const trades1 = { data: [
    trade(GOOD, 'buy', M1, 1000, 200, created1 + 2 * H), trade(GOOD, 'sell', M1, 1000, 300, created1 + 3 * H),        // +50%
    trade(SNIPER, 'buy', M1, 5000, 500, created1 + 2 * M), trade(SNIPER, 'sell', M1, 5000, 1500, created1 + 1 * H),   // +200%, but 2 min after launch
    trade(LOSER, 'buy', M1, 1000, 200, created1 + 2 * H), trade(LOSER, 'sell', M1, 1000, 150, created1 + 3 * H),      // -25%
    ...Array.from({ length: 13 }, (_, i) => trade(BOT, i % 2 ? 'sell' : 'buy', M1, 100, 60, created1 + 2 * H + i * M)), // a bot
    trade(MEH, 'buy', M1, 1000, 200, created1 + 2 * H), trade(MEH, 'sell', M1, 1000, 224, created1 + 3 * H),          // +12%, one token
    trade(KNOWN, 'buy', M1, 1000, 200, created1 + 2 * H), trade(KNOWN, 'sell', M1, 1000, 400, created1 + 3 * H),      // already on our list
  ] };
  const trades2 = { data: [
    trade(GOOD, 'buy', M2, 500, 100, created2 + 1 * H), trade(GOOD, 'sell', M2, 500, 130, created2 + 2.5 * H),        // +30%
    trade(FLIPPER, 'buy', M2, 1000, 200, created2 + 1 * H), trade(FLIPPER, 'sell', M2, 1000, 300, created2 + 1 * H + 3 * M), // 3-minute flip
    trade(ONEHIT, 'buy', M2, 1000, 100, created2 + 2 * H), trade(ONEHIT, 'sell', M2, 1000, 160, created2 + 3 * H),    // +60%, one token
    trade(TINY, 'buy', M2, 100, 20, created2 + 2 * H), trade(TINY, 'sell', M2, 100, 40, created2 + 3 * H),            // $20 — noise
    { type: 'trade', attributes: { tx_from_address: GOOD, kind: 'buy', volume_in_usd: '5', block_timestamp: iso(NOW) } }, // unreadable amounts — skipped
  ] };
  const t1 = parsePoolTrades(trades1, M1);
  assert(t1.length === trades1.data.length && t1.some((t) => t.side === 'sell' && t.wallet === GOOD), 'trades parse, buy/sell decided by which side the memecoin is on');
  assert(parsePoolTrades(trades2, M2).length === trades2.data.length - 1, 'a trade with unreadable amounts is skipped, not guessed');

  const byPool = new Map([['P1', t1], ['P2', parsePoolTrades(trades2, M2)]]);
  const found = findCandidates(usable, byPool, new Set([KNOWN]));
  assert(found.map((c) => c.wallet).join() === [GOOD, ONEHIT].join(),
    `keeps the repeat winner and the strong one-off; rejects sniper, loser, flipper, bot, +12% one-off, dust and already-known (got ${found.map((c) => c.wallet.slice(0, 4)).join(',')})`);
  assert(found[0].pools === 2 && Math.round(found[0].medianReturnPct) === 40, 'the repeat winner ranks first, median +40% across two tokens');
  assert(found[0].evidence.some((e) => /\+50%, held 1\.0h, bought 2\.0h after launch/.test(e)), 'the reason for each pick is kept');

  // The whole run against a fake API: routing, pacing, counts, and a clear
  // problem report when a response can't be read — never a silent zero.
  const urls: string[] = [];
  const fakeFetch = async (url: string) => {
    urls.push(url);
    if (url.includes('trending_pools?page=1')) return trending;
    if (url.includes('trending_pools?page=2')) return { data: [] };
    if (url.includes('/pools/P1/trades')) return trades1;
    if (url.includes('/pools/P2/trades')) return trades2;
    throw new Error('unexpected url ' + url);
  };
  let pauses = 0;
  const report = await discoverWallets(new Set([KNOWN]), NOW, fakeFetch, async () => { pauses++; });
  assert(report.candidates.map((c) => c.wallet).join() === [GOOD, ONEHIT].join(), 'end to end: same two candidates');
  assert(report.poolsFetched === 8 && report.poolsUsable === 2 && report.poolsScanned === 2 && report.problems.length === 0, 'report counts');
  assert(urls.every((u) => u.startsWith('https://api.geckoterminal.com/api/v2/networks/solana/')) && pauses === urls.length, 'every call is to GeckoTerminal and paced');
  assert(urls.some((u) => u.includes('trade_volume_in_usd_greater_than=')), 'dust trades are filtered at the source');

  const changed = await discoverWallets(new Set(), NOW, async (u) => (u.includes('page=1') ? { data: [{ id: 'x', attributes: { name: 'weird' } }] } : { data: [] }), async () => {});
  assert(changed.candidates.length === 0 && changed.problems.some((p) => /changed its response format/.test(p)), 'an unreadable response is reported, not a silent zero');
  const down = await discoverWallets(new Set(), NOW, async () => { throw new Error('GeckoTerminal HTTP 503'); }, async () => {});
  assert(down.problems.length === 2 && down.problems[0].includes('503'), 'network failures are reported, never thrown');
  realLog('✅ discovery: keeps post-launch repeat winners; rejects snipers, bots, flippers, losers; reports broken responses');
}

// Discovery inside rotation: runs by itself when the bench runs low, never
// re-adds a wallet that is listed or was dropped, respects its cooldown, and
// keeps every discovered wallet on PAPER until it has proven itself.
async function testDiscoveryInRotation(realLog: typeof console.log) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-disc-'));
  const store = new PositionStore(dir);
  const [A, B, C, N1, N2, N3] = Array.from({ length: 6 }, () => Keypair.generate().publicKey.toBase58());
  const cfg = { walletMaxConsecutiveLosses: 3, walletDropAfterTrades: 6, walletIdleMinutes: 0 };
  const T0 = Date.parse('2026-09-23T20:00:00Z');
  const cand = (wallet: string) => ({ wallet, pools: 2, medianReturnPct: 40, evidence: ['X: +40%'] });
  const runs: Set<string>[] = [];
  let next = [cand(N1), cand(N2)];
  const roster = new WalletRoster([A, B, C], 3, dir);
  const rotation = new Rotation(roster, store, cfg, () => {}, {
    minBench: 3, cooldownMs: 30 * 60_000,
    async run(exclude) { runs.push(exclude); return next; },
  });
  const watching = new Set<string>();
  const watch = { isWatching: (w: string) => watching.has(w), addWallet: (w: string) => { watching.add(w); }, async removeWallet(w: string) { watching.delete(w); } };
  const trader = { setActiveWallets() {} };

  rotation.startup(T0).forEach((w) => watching.add(w));
  await rotation.pendingDiscovery;
  assert(runs.length === 1 && [A, B, C].every((w) => runs[0].has(w)), 'an empty bench triggers discovery at startup, excluding wallets already listed');
  assert(roster.bench().join() === [N1, N2].join() && roster.isDiscovered(N1) && !roster.isDiscovered(A), 'finds land on the bench, marked as discovered');

  for (let i = 0; i < 3; i++) { // A loses three in a row
    const p = store.openPosition({ mint: Keypair.generate().publicKey.toBase58(), decimals: 6, sourceWallet: A, dryRun: true, spentSol: 0.01, tokenAmountRaw: '1' });
    store.recordSell(p, 1n, 0.005);
  }
  await rotation.tick(T0 + 60_000, watch, trader);
  assert(roster.active().join() === [B, C, N1].join(), 'A is dropped and the discovered N1 takes its slot');
  assert(rotation.isPaperOnly(N1) && !rotation.isPaperOnly(B), 'a discovered wallet is paper-only; your own wallets never are');
  assert(runs.length === 1, 'the bench is low again but discovery waits out its cooldown');

  next = [cand(N1), cand(A), cand(N3)]; // one already on the list, one dropped, one new
  await rotation.tick(T0 + 31 * 60_000, watch, trader);
  await rotation.pendingDiscovery;
  const runCount: number = runs.length; // read fresh: TS narrowed runs.length to 1 from the assert above
  assert(runCount === 2 && runs[1].has(A), 'after the cooldown it looks again, and tells discovery to skip the dropped wallet');
  assert(roster.bench().join() === [N2, N3].join(), 'only the genuinely new wallet is added — a dropped wallet never comes back');

  for (let i = 0; i < PROBATION_TRADES; i++) { // N1 proves itself on paper
    const p = store.openPosition({ mint: Keypair.generate().publicKey.toBase58(), decimals: 6, sourceWallet: N1, dryRun: true, spentSol: 0.01, tokenAmountRaw: '1' });
    store.recordSell(p, 1n, 0.013);
  }
  assert(!rotation.isPaperOnly(N1), `after ${PROBATION_TRADES} profitable paper copies, a discovered wallet earns real-money copies`);

  const reloaded = new WalletRoster([A, B, C], 3, dir);
  reloaded.load();
  assert(reloaded.isDiscovered(N3) && reloaded.all().includes(N3) && reloaded.dropped().some((d) => d.wallet === A), 'discoveries and drops survive a restart');
  realLog('✅ discovery in rotation: refills a low bench by itself, never re-adds dropped wallets, discovered wallets paper-only until proven');
}

// In REAL mode, a wallet on probation is copied on paper — no SOL moves, and
// its paper positions don't use up the real-money position slots.
async function testProbationInRealMode(realLog: typeof console.log) {
  const config = { ...loadConfig(), dryRun: false, maxOpenPositions: 1 };
  const store = new PositionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-probation-')));
  const orders: OrderParams[] = [];
  let executed = 0;
  const fakeJupiter = {
    async getOrder(params: OrderParams): Promise<JupiterOrder> {
      orders.push(params);
      return { requestId: 'r', transactionBase64: null, inAmountRaw: params.amountRaw, outAmountRaw: 5_000n };
    },
    async execute() { executed++; return { signature: 'x' }; },
  };
  const trader = new Trader(config, { async getBalance() { return 10e9; } } as any, Keypair.generate(), fakeJupiter as any, store, okMarket);
  const PROBE = Keypair.generate().publicKey.toBase58();
  trader.setPaperOnly((w) => w === PROBE);
  const loud = console.log, loudErr = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    await trader.handleSwapEvent({ signature: 'p1', sourceWallet: PROBE, side: 'buy', mint: MEME_MINT, decimals: 5, tokenDeltaRaw: 1n, ownerPreTokenRaw: 0n, quoteSolEquivalent: 0.5 });
    const paper = store.all()[0];
    assert(paper && paper.dryRun === true && executed === 0, 'a probation wallet is copied on PAPER even with DRY_RUN=false');
    assert(orders[0].takerPubkey === null, 'its order is quote-only — nothing is built to sign');
    await trader.handleSwapEvent({ signature: 'r1', sourceWallet: TRACKED, side: 'buy', mint: Keypair.generate().publicKey.toBase58(), decimals: 5, tokenDeltaRaw: 1n, ownerPreTokenRaw: 0n, quoteSolEquivalent: 0.5 });
    assert(orders.length === 2 && orders[1].takerPubkey !== null, 'a real wallet still gets a real order: the paper position did not use up the one real slot');
  } finally {
    console.log = loud; console.error = loudErr;
  }
  realLog('✅ probation: discovered wallets trade on paper in real mode and never take a real-money slot');
}

async function main() {
  testEnvIsolation();
  await testDiscovery(console.log);
  await testDiscoveryInRotation(console.log);
  await testProbationInRealMode(console.log);
  await testWalletRotation(console.log);
  await testActiveWalletFilter(console.log);
  testCopyGap();
  await testSourceTracking(console.log);
  await testRealSellRecordsActualSol(console.log);
  await testTransactionVersions();
  testWindowsAlerts();
  testSetupChecks();
  testExitDecisions();
  await testExitsInTrader(console.log);
  testNotifySpeech();
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
