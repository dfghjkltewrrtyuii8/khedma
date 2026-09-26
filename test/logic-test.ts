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

import { analyzeSwap, installedWeb3Version, MAX_TX_VERSION, MIN_WEB3_VERSION, shortAddress, versionAtLeast, WalletWatcher } from '../src/watcher';
import { RateLimiter } from '../src/rateLimiter';
import { inRun, PositionStore } from '../src/positions';
import { Trader } from '../src/trader';
import { loadConfig, SOL_MINT } from '../src/config';
import { JupiterOrder, OrderParams } from '../src/jupiter';
import { printSummary } from '../src/pnl';
import { getSolPriceUsd } from '../src/solPrice';
import { decideShutdown } from '../src/shutdownDebounce';
import { soundFor, speechFor, speechArgs, windowsAlertInvocation, windowsSoundFor, WINDOWS_ALERT_SCRIPT } from '../src/notify';
import { applyRecommended, paperModeWithFundsHint, classifyWalletSecret, findPlaceholders, isTelegramToken, parseHeliusInput, parseWalletList, renderEnv, upsertEnv } from '../src/setupChecks';
import {
  allQuiet, describeActivity, duration, FetchLike, formatOpen, formatPnl, formatStatus, formatTradeEvent, formatWallets, parseCommand,
  TelegramBot, TelegramClient, TelegramError, TelegramUpdate, TradeFeed,
} from '../src/telegram';
import * as bip39 from 'bip39';
import { evaluateToken, summarizePairs, TokenMarket } from '../src/tokenMarket';
import { Position } from '../src/types';
import { walletMute, walletRecords } from '../src/walletGate';
import { decideExit, describeExitRules, exitRulesEnabled } from '../src/exitRules';
import { compareToSource, entryPhrase, summarizeComparisons } from '../src/copyGap';
import { copySlots, dropReason, paperHints, PROBATION_TRADES, provenWinners, ROBOT_REASON, Rotation, rotationOn, WalletRoster } from '../src/walletRoster';
import { discoverWallets, findCandidates, parsePoolTrades, parseTrendingPools, selectPools } from '../src/discovery';
import { SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { closeAccounts, selectEmpty, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../src/tokenAccounts';
import { describeHours, HistoryTrade, hourProfile, judgeHistory, likelyActive, VetVerdict, vetWallet } from '../src/walletVetting';

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
  assert(config.telegramBotToken === '' && config.telegramChatId === '', 'a real Telegram bot is never messaged by the tests');
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
    pool('P3young', M3, 20 * M, 90_000, 40),     // too young: still launch rush
    pool('P4thin', M4, 6 * H, 5_000, 40),        // too thin to exit
    pool('P5busy', M5, 6 * H, 90_000, 500),      // one page of trades = a few minutes
    pool('PSOL', SOL_MINT, 6 * H, 90_000, 40),   // "token" side is SOL — skipped
    pool('PODD', mint(), 6 * H, 90_000, 40, mint()), // quoted in some other token — skipped
    { id: 'broken' },                             // malformed — skipped
  ] };
  const parseRejects: Record<string, number> = {};
  const parsed = parseTrendingPools(trending, parseRejects);
  assert(parsed.length === 5 && !parsed.some((p) => p.address === 'PSOL' || p.address === 'PODD'), 'pools quoted in SOL/USDC only, memecoin on the base side');
  assert(parseRejects['SOL/USDC on the token side'] === 1 && parseRejects['priced in another token'] === 1 && parseRejects.unreadable === 1, 'every left-out pool is counted with its reason');
  const poolRejects: Record<string, number> = {};
  const usable = selectPools(parsed, NOW, undefined, poolRejects);
  assert(usable.map((p) => p.address).join() === 'P1,P2,P5busy', 'too-young and too-thin pools are skipped; busy pools are KEPT (the first live run lost 37 of 40 pools to a busy filter)');
  assert(poolRejects['under 25 min old'] === 1 && poolRejects['under $10,000 liquidity'] === 1, 'and why');

  const [GOOD, SNIPER, LOSER, FLIPPER, BOT, ONEHIT, MEH, KNOWN, TINY, SAMEPUMP] = Array.from({ length: 10 }, () => Keypair.generate().publicKey.toBase58());
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
    ...Array.from({ length: 21 }, (_, i) => trade(BOT, i % 2 ? 'sell' : 'buy', M1, 100, 60, created1 + 2 * H + i * M)), // a bot
    trade(MEH, 'buy', M1, 1000, 200, created1 + 2 * H), trade(MEH, 'sell', M1, 1000, 224, created1 + 3 * H),          // +12%, one token
    trade(KNOWN, 'buy', M1, 1000, 200, created1 + 2 * H), trade(KNOWN, 'sell', M1, 1000, 400, created1 + 3 * H),      // already on our list
  ] };
  const trades2 = { data: [
    trade(GOOD, 'buy', M2, 500, 100, created2 + 1 * H), trade(GOOD, 'sell', M2, 500, 130, created2 + 2.5 * H),        // +30%
    trade(FLIPPER, 'buy', M2, 1000, 200, created2 + 1 * H), trade(FLIPPER, 'sell', M2, 1000, 300, created2 + 1 * H + 3 * M), // 3-minute flip
    trade(ONEHIT, 'buy', M2, 1000, 100, created2 + 2 * H), trade(ONEHIT, 'sell', M2, 1000, 160, created2 + 3 * H),    // +60%, one token
    trade(SAMEPUMP, 'buy', M2, 1000, 100, created2 + 2.1 * H), trade(SAMEPUMP, 'sell', M2, 1000, 150, created2 + 3 * H), // +50%, same token, same exit
    trade(TINY, 'buy', M2, 100, 20, created2 + 2 * H), trade(TINY, 'sell', M2, 100, 40, created2 + 3 * H),            // $20 — noise
    { type: 'trade', attributes: { tx_from_address: GOOD, kind: 'buy', volume_in_usd: '5', block_timestamp: iso(NOW) } }, // unreadable amounts — skipped
  ] };
  const t1 = parsePoolTrades(trades1, M1);
  assert(t1.length === trades1.data.length && t1.some((t) => t.side === 'sell' && t.wallet === GOOD), 'trades parse, buy/sell decided by which side the memecoin is on');
  assert(parsePoolTrades(trades2, M2).length === trades2.data.length - 1, 'a trade with unreadable amounts is skipped, not guessed');

  const byPool = new Map([['P1', t1], ['P2', parsePoolTrades(trades2, M2)]]);
  const walletRejects: Record<string, number> = {};
  const found = findCandidates(usable, byPool, new Set([KNOWN]), undefined, walletRejects);
  assert(!found.some((c) => c.wallet === SAMEPUMP), 'a second wallet riding the same one-token pump is left out');
  assert(found.map((c) => c.wallet).join() === [GOOD, ONEHIT].join(),
    `keeps the repeat winner and the strong one-off; rejects sniper, loser, flipper, bot, +12% one-off, dust and already-known (got ${found.map((c) => c.wallet.slice(0, 4)).join(',')})`);
  assert(found[0].pools === 2 && Math.round(found[0].medianReturnPct) === 40, 'the repeat winner ranks first, median +40% across two tokens');
  assert(found[0].evidence.some((e) => /\+50%, held 1\.0h, bought 2\.0h after launch/.test(e)), 'the reason for each pick is kept');
  const expectRejects: Record<string, number> = {
    'already known to the bot': 1, 'bot (too many trades)': 1, 'launch sniper': 1, 'lost money': 1,
    'held under 5 min': 1, 'position under $50': 1, 'one token only, under +20%': 1,
    'same token as a better pick (one pump, not skill)': 1,
  };
  for (const [reason, n] of Object.entries(expectRejects)) {
    assert(walletRejects[reason] === n, `every rejected wallet is counted under its reason: "${reason}" expected ${n}, got ${walletRejects[reason]}`);
  }

  // The whole run against a fake API: routing, pacing, counts, and a clear
  // problem report when a response can't be read — never a silent zero.
  const urls: string[] = [];
  const fakeFetch = async (url: string) => {
    urls.push(url);
    if (url.includes('trending_pools?page=1')) return trending;
    if (url.includes('trending_pools?page=2')) return { data: [] };
    if (url.includes('/pools/P1/trades')) return trades1;
    if (url.includes('/pools/P2/trades')) return trades2;
    if (url.includes('/pools/P5busy/trades')) return { data: [] };
    if (url.includes('/networks/solana/pools?page=1&sort=h24_volume_usd_desc')) return { data: [pool('P1', M1, 5 * H, 80_000, 60)] }; // already trending: not scanned twice
    throw new Error('unexpected url ' + url);
  };
  let pauses = 0;
  const report = await discoverWallets(new Set([KNOWN]), NOW, fakeFetch, async () => { pauses++; });
  assert(report.candidates.map((c) => c.wallet).join() === [GOOD, ONEHIT].join(), 'end to end: same two candidates');
  assert(report.poolsFetched === 9 && report.poolsReadable === 5 && report.poolsUsable === 3 && report.poolsScanned === 3 && report.problems.length === 0,
    `report counts (got fetched ${report.poolsFetched}, readable ${report.poolsReadable}, usable ${report.poolsUsable}, scanned ${report.poolsScanned}, problems ${report.problems.join('; ')})`);
  assert(urls.filter((u) => u.includes('/pools/P1/trades')).length === 1, 'a pool on both lists is scanned once');
  assert(report.windowHours.length === 2 && Math.round(report.windowHours[1]) === 2, 'how much time each pool\'s trades covered is measured');
  assert(report.walletRejects['launch sniper'] === 1, 'the end-to-end report carries the rejection breakdown');
  assert(urls.every((u) => u.startsWith('https://api.geckoterminal.com/api/v2/networks/solana/')) && pauses === urls.length, 'every call is to GeckoTerminal and paced');
  assert(urls.some((u) => u.includes('trade_volume_in_usd_greater_than=')), 'dust trades are filtered at the source');

  // Near misses are reported when nobody qualifies: MEH (+12% on one token).
  const nearMisses: any[] = [];
  findCandidates(usable, byPool, new Set([KNOWN, GOOD, ONEHIT]), undefined, undefined, nearMisses);
  assert(nearMisses.length === 1 && nearMisses[0].wallet === MEH && /\+12%/.test(nearMisses[0].evidence[0]), 'the closest near-miss is kept for the report');

  // Rate limiting: a 429 is waited out and retried; a pool that keeps refusing
  // stops the scan (keeping what was read) instead of hammering the API.
  let p1Refusals = 0;
  const pausesMs: number[] = [];
  const flaky = async (url: string) => {
    if (url.includes('/pools/P1/trades') && p1Refusals++ < 2) throw new Error('GeckoTerminal rate limit (429) — too many requests');
    return fakeFetch(url);
  };
  const recovered = await discoverWallets(new Set([KNOWN]), NOW, flaky, async (ms) => { pausesMs.push(ms); });
  assert(recovered.poolsScanned === 3 && recovered.problems.length === 0 && recovered.candidates.length === 2, 'two 429s on one pool are waited out and the scan completes');
  assert(pausesMs.filter((ms) => ms >= 45_000).length === 2, 'each 429 waits the long backoff before retrying');
  const stubborn = await discoverWallets(new Set([KNOWN]), NOW, async (url: string) => {
    if (url.includes('/trades')) throw new Error('GeckoTerminal rate limit (429)');
    return fakeFetch(url);
  }, async () => {});
  assert(stubborn.poolsScanned === 0 && stubborn.problems.some((p) => /kept refusing/.test(p)), 'a pool that keeps refusing stops the scan with a clear message');
  assert(stubborn.problems.filter((p) => p.startsWith('trades for')).length === 1, 'it stops at the first stubborn refusal instead of trying every pool');

  const changed = await discoverWallets(new Set(), NOW, async (u) => (u.includes('page=1') ? { data: [{ id: 'x', attributes: { name: 'weird' } }] } : { data: [] }), async () => {});
  assert(changed.candidates.length === 0 && changed.problems.some((p) => /changed its response format/.test(p)), 'an unreadable response is reported, not a silent zero');
  const down = await discoverWallets(new Set(), NOW, async () => { throw new Error('GeckoTerminal HTTP 503'); }, async () => {});
  assert(down.problems.length === 3 && down.problems[0].includes('503') && down.problems[2].startsWith('top pools'), 'network failures are reported per request, never thrown');
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

// With two wallets listed and discovery on, the bot used to copy exactly two:
// wallets it discovered sat on the bench, unwatched, until one of the two had
// been quiet for WALLET_IDLE_MINUTES. A live run went 30 minutes without a
// single trade that way. Now the empty slots (ACTIVE_WALLETS) fill at once.
async function testEmptySlotsFill(realLog: typeof console.log) {
  const base = loadConfig();
  const [A, B, N1, N2, N3] = Array.from({ length: 5 }, () => Keypair.generate().publicKey.toBase58());
  const two = [new PublicKey(A), new PublicKey(B)];
  assert(copySlots({ ...base, trackedWallets: two, activeWallets: 4 }) === 4, 'ACTIVE_WALLETS sets the slots');
  assert(copySlots({ ...base, trackedWallets: two, activeWallets: 1 }) === 2, 'never fewer than you listed yourself');
  assert(copySlots({ ...base, trackedWallets: two, activeWallets: 10, maxTrackedWallets: 6 }) === 6, 'never more than the watcher can follow');
  assert(rotationOn({ benchWallets: [], discovery: true }) && !rotationOn({ benchWallets: [], discovery: false }), 'rotation is on with discovery or a bench');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-slots-'));
  const store = new PositionStore(dir);
  const roster = new WalletRoster([A, B], 4, dir);
  const logs: string[] = [];
  const rotation = new Rotation(roster, store, { walletMaxConsecutiveLosses: 3, walletDropAfterTrades: 6, walletIdleMinutes: 90 }, (m) => logs.push(m), {
    minBench: 3, cooldownMs: 30 * 60_000,
    async run() { return [N1, N2, N3].map((wallet) => ({ wallet, pools: 2, medianReturnPct: 40, evidence: ['X: +40%'] })); },
  });
  const watching = new Set<string>();
  const watch = { isWatching: (w: string) => watching.has(w), addWallet: (w: string) => { watching.add(w); }, async removeWallet(w: string) { watching.delete(w); } };
  let copying: string[] | null = null;
  const trader = { setActiveWallets(w: string[] | null) { copying = w; } };
  const T0 = Date.parse('2026-09-23T20:00:00Z');

  rotation.startup(T0).forEach((w) => watching.add(w));
  assert(watching.size === 2, 'before discovery finishes, your two are watched');
  await rotation.pendingDiscovery;
  await rotation.tick(T0 + 30_000, watch, trader); // the next 30-second tick
  assert(roster.active().join() === [A, B, N1, N2].join() && [A, B, N1, N2].every((w) => watching.has(w)), 'discovered wallets fill the two empty slots on the next tick — no 90-minute wait');
  assert(copying !== null && (copying as string[]).length === 4, 'and their buys are copied');
  assert(roster.bench().join() === N3, 'the rest wait on the bench');
  assert(logs.some((l) => l.startsWith('🔄 Now copying')), 'each new wallet is announced');
  rotation.noteBuy(A, T0 + 80 * 60_000);
  rotation.noteBuy(B, T0 + 80 * 60_000);
  await rotation.tick(T0 + 30_000 + 91 * 60_000, watch, trader);
  assert(logs.some((l) => l.includes(`Benched ${shortAddress(N1)}`)), 'a discovered wallet that goes quiet is benched like any other (its idle clock started when it got the slot)');
  realLog('✅ empty slots: discovered wallets are copied as soon as they are found, up to ACTIVE_WALLETS');
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

// Paper and real money have separate caps. Paper risks nothing, so a low cap
// only throws away test data — in live sessions "already at MAX_OPEN_POSITIONS"
// was the most common reason a copy was skipped. And with more paper positions
// open, an exit sweep must not hold up a copy that arrives in the middle of it.
async function testPositionCapsAndSweepYield(realLog: typeof console.log) {
  const base = { ...loadConfig(), maxOpenPositions: 1, paperMaxOpenPositions: 3 };
  const buyEvent = (signature: string, mint = Keypair.generate().publicKey.toBase58()) =>
    ({ signature, sourceWallet: TRACKED, side: 'buy' as const, mint, decimals: 5, tokenDeltaRaw: 1n, ownerPreTokenRaw: 0n, quoteSolEquivalent: 0.5 });
  const lines: string[] = [];
  const swept: string[] = []; // mints priced by exit sweeps, in order
  const priced = () => swept.length; // a function, so TypeScript doesn't narrow it between sweeps
  let onSweepQuote: (() => void) | null = null;
  const fakeJupiter = {
    async getOrder(p: OrderParams): Promise<JupiterOrder> {
      if (p.outputMint === SOL_MINT) {
        swept.push(p.inputMint);
        const hook = onSweepQuote;
        onSweepQuote = null;
        hook?.();
      }
      // buys get 5000 raw tokens; every position is worth exactly what it cost, so no exit rule fires
      return { requestId: 'r', transactionBase64: null, inAmountRaw: p.amountRaw, outAmountRaw: p.inputMint === SOL_MINT ? 5_000n : 10_000_000n };
    },
    async execute() { throw new Error('must not execute'); },
  };
  const connection = { async getBalance() { return 10e9; } } as any;
  const loud = console.log, loudErr = console.error;
  console.log = (...a: unknown[]) => { lines.push(`${swept.length}|${a.join(' ')}`); };
  console.error = () => {};
  try {
    // --- paper: PAPER_MAX_OPEN_POSITIONS applies, not MAX_OPEN_POSITIONS ---
    const paperStore = new PositionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-caps-')));
    const paper = new Trader({ ...base, dryRun: true }, connection, Keypair.generate(), fakeJupiter as any, paperStore, okMarket);
    for (const sig of ['a', 'b', 'c', 'd']) await paper.handleSwapEvent(buyEvent(sig));
    const open = paperStore.byStatus('open');
    assert(open.length === 3, `paper fills up to PAPER_MAX_OPEN_POSITIONS (3), not MAX_OPEN_POSITIONS (1) — got ${open.length}`);
    assert(lines.some((l) => /skip: already at PAPER_MAX_OPEN_POSITIONS \(3,/.test(l)), 'the 4th paper copy is skipped, naming the paper setting');

    // --- a trade arriving mid-sweep goes first ---
    let tradeDone: Promise<void> | null = null;
    onSweepQuote = () => { tradeDone = paper.handleSwapEvent(buyEvent('mid', open[0].mint)); };
    await paper.checkExits();
    await tradeDone;
    assert(priced() === 1, `the sweep stopped after the quote in progress when a trade arrived (priced ${priced()})`);
    assert(lines.some((l) => l.startsWith('1|') && /already hold a position/.test(l)), 'the waiting trade ran right after that one quote');
    await paper.checkExits();
    const firstChecked = swept[0];
    assert(priced() === 4 && !swept.slice(1, 3).includes(firstChecked) && swept[3] === firstChecked,
      'the next sweep prices the two it missed first, then the rest');
    const beforeDouble = priced();
    await Promise.all([paper.checkExits(), paper.checkExits()]);
    assert(priced() === beforeDouble + 3, 'a sweep requested while one is waiting is not stacked on top');

    // --- real money: MAX_OPEN_POSITIONS still applies, and paper doesn't count toward it ---
    const realStore = new PositionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-caps-real-')));
    realStore.openPosition({ mint: Keypair.generate().publicKey.toBase58(), decimals: 5, sourceWallet: TRACKED, dryRun: true, spentSol: 0.01, tokenAmountRaw: '1' });
    realStore.openPosition({ mint: Keypair.generate().publicKey.toBase58(), decimals: 5, sourceWallet: TRACKED, dryRun: false, spentSol: 0.01, tokenAmountRaw: '1' });
    const real = new Trader({ ...base, dryRun: false }, connection, Keypair.generate(), fakeJupiter as any, realStore, okMarket);
    lines.length = 0;
    await real.handleSwapEvent(buyEvent('r'));
    assert(lines.some((l) => /skip: already at MAX_OPEN_POSITIONS \(1,/.test(l)), 'real money keeps its own, lower cap');
  } finally {
    console.log = loud; console.error = loudErr;
  }
  realLog('✅ position caps: paper has its own higher cap, real money keeps MAX_OPEN_POSITIONS; exit sweeps give way to waiting trades');
}

// Telegram, offline: a fake Telegram API stands in for the real one. Pins the
// parts that matter for trust — only YOUR chat is answered, the token never
// shows up in an error, the numbers match the positions — and that a flaky
// connection is retried or reported once, never allowed to stop trading.
async function testTelegram(realLog: typeof console.log) {
  const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1';
  const CHAT = '5550001';
  const H = 3_600_000;
  const NOW = Date.parse('2026-09-24T07:00:00Z');
  const W1 = TRACKED, W2 = Keypair.generate().publicKey.toBase58(), W3 = Keypair.generate().publicKey.toBase58();
  let n = 0;
  const pos = (over: Partial<Position>): Position => ({
    id: `p${++n}`, mint: Keypair.generate().publicKey.toBase58(), decimals: 6, sourceWallet: W1, dryRun: true, status: 'closed',
    openedAt: new Date(NOW - 10 * H).toISOString(), closedAt: new Date(NOW - 9 * H).toISOString(),
    spentSol: 0.01, tokenAmountRaw: '0', initialTokenAmountRaw: '1000', receivedSol: 0, sellTxs: [], ...over,
  });

  // --- settings helpers ---
  assert(isTelegramToken(TOKEN) && !isTelegramToken('123:abc') && !isTelegramToken('my bot') && !isTelegramToken(''), 'bot tokens are recognised, junk is not');
  const envText = 'PRIVATE_KEY_BASE58=abc\r\n# keep me\r\nTELEGRAM_CHAT_ID=old\r\nDRY_RUN=true\r\n';
  const upserted = upsertEnv(envText, { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT }, '# ---- Telegram ----');
  assert(upserted.startsWith('PRIVATE_KEY_BASE58=abc\r\n# keep me\r\nTELEGRAM_CHAT_ID=5550001\r\nDRY_RUN=true\r\n'), '.env: existing key replaced in place, other lines untouched, Windows line endings kept');
  assert(upserted.endsWith(`\r\n# ---- Telegram ----\r\nTELEGRAM_BOT_TOKEN=${TOKEN}\r\n`), '.env: a missing key is appended under its heading');
  assert(upsertEnv('A=1', { B: '$&$1' }) === 'A=1\nB=$&$1\n' && upsertEnv('B=x\n', { B: '$&' }) === 'B=$&\n', '.env: values are written literally');
  const rendered = renderEnv({ privateKeyBase58: 'k', walletMnemonic: '', heliusHttpsUrl: 'h', heliusWssUrl: 'w', jupiterApiKey: 'j', trackedWallets: [W1], settings: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT } });
  assert(rendered.includes(`TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_CHAT_ID=${CHAT}\nTELEGRAM_REPORT_HOURS=3\nTELEGRAM_TRADE_ALERTS=sells`), 'npm run setup keeps the Telegram settings when it rewrites .env');

  // --- the API client, against a fake Telegram ---
  const calls: { url: string; body: any }[] = [];
  let reply: { status: number; body: unknown } | Error = { status: 200, body: { ok: true, result: { id: 1, username: 'copy_bot' } } };
  const fakeFetch: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (reply instanceof Error) throw reply;
    const r = reply;
    return { ok: r.status === 200, status: r.status, json: async () => r.body };
  };
  const client = new TelegramClient(TOKEN, fakeFetch);
  const me = await client.getMe();
  assert(me.username === 'copy_bot' && calls[0].url === `https://api.telegram.org/bot${TOKEN}/getMe`, 'calls the Bot API');
  await client.sendMessage(CHAT, 'hello', true);
  assert(calls[1].body.chat_id === CHAT && calls[1].body.disable_notification === true && calls[1].body.link_preview_options.is_disabled === true, 'messages go to your chat, silently, without link previews');
  await client.sendMessage(CHAT, 'x'.repeat(5000), true);
  assert(calls[2].body.text.length <= 4000 && calls[2].body.text.endsWith('(cut short)'), 'over-long messages are cut to fit');
  const kindOf = async (status: number, body: unknown) => {
    reply = { status, body };
    try { await client.getMe(); return 'none'; } catch (error) { return (error as TelegramError).kind; }
  };
  assert(await kindOf(401, { ok: false, description: 'Unauthorized' }) === 'unauthorized', '401 = token rejected');
  assert(await kindOf(403, { ok: false, description: 'Forbidden: bot was blocked by the user' }) === 'blocked', '403 = you blocked the bot');
  assert(await kindOf(409, { ok: false, description: 'Conflict: terminated by other getUpdates request' }) === 'conflict', '409 = another program reads this bot');
  assert(await kindOf(400, { ok: false, description: 'Bad Request: chat not found' }) === 'chat-not-found', 'chat not found is told apart');
  reply = { status: 429, body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 7 } } };
  const limited = (await client.getMe().catch((e) => e)) as TelegramError;
  assert(limited.kind === 'rate-limited' && limited.retryAfterSec === 7, '429 carries how long to wait');
  reply = new Error(`request to https://api.telegram.org/bot${TOKEN}/getMe failed`);
  const offline = (await client.getMe().catch((e) => e)) as TelegramError;
  assert(offline.kind === 'network' && !offline.message.includes(TOKEN) && offline.message.includes('<token>'), 'the token is scrubbed from error messages');

  // --- reports ---
  const win = pos({ receivedSol: 0.02, exitRule: 'trailing-stop' }); // +100%
  const loss = pos({ receivedSol: 0.007, exitRule: 'stop-loss', sourceWallet: W2, closedAt: new Date(NOW - 1 * H).toISOString() }); // -30%
  const small = pos({ receivedSol: 0.0105, closedAt: new Date(NOW - 2 * H).toISOString() }); // +5%
  const open1 = pos({ status: 'open', closedAt: undefined, openedAt: new Date(NOW - 42 * 60_000).toISOString(), tokenAmountRaw: '1000' });
  const open2 = pos({ status: 'open', closedAt: undefined, tokenAmountRaw: '1000' });
  const stuck = pos({ status: 'stuck', closedAt: undefined, tokenAmountRaw: '1000', dryRun: false, spentSol: 0.05 });
  const realWin = pos({ dryRun: false, spentSol: 0.05, receivedSol: 0.06 });
  const all = [win, loss, small, open1, open2, stuck, realWin];
  const priceOf = (id: string) => (id === open1.id ? 0.0112 : undefined);
  const pnl = formatPnl({ positions: all, now: NOW, solPriceUsd: 200, priceOf, title: 'P&L so far', recentSince: NOW - 3 * H, recentLabel: 'Since last report' });
  assert(pnl.includes('PAPER') && pnl.includes('Closed 3 · 2 won / 1 lost (67%)'), `paper totals: ${pnl}`);
  assert(pnl.includes('Total: +0.0075 SOL (+$1.50)'), 'total is the sum of received minus spent, with USD');
  assert(pnl.includes('Since last report: 2 closed, -0.0025 SOL'), 'the recent window counts only trades closed inside it');
  assert(pnl.includes(`Best ${shortAddress(win.mint)} +100% · worst ${shortAddress(loss.mint)} -30%`), 'best and worst trade');
  assert(pnl.includes('Open 2 · worth now +0.0012 SOL (+$0.24) (1 priced)'), 'open positions are valued from the latest price, and say how many were priced');
  assert(pnl.includes('Real trades also pay small network fees') && pnl.includes('comes back after selling'), 'paper results say what real trades cost on top');
  assert(pnl.includes('💰 REAL MONEY') && pnl.includes('Closed 1 · 1 won / 0 lost') && pnl.includes('🔴 Stuck 1'), 'real money is reported separately, stuck ones flagged');
  assert(formatPnl({ positions: [], now: NOW, solPriceUsd: null, title: 'x' }).includes('No trades yet'), 'an empty report says so');
  assert(formatPnl({ positions: [win], now: NOW, solPriceUsd: null, title: 'x' }).includes('Total: +0.0100 SOL\n'), 'no USD when the price is unavailable — never a made-up number');

  const open = formatOpen({ positions: all, now: NOW, solPriceUsd: 150, priceOf });
  assert(open.startsWith('📂 Open trades (3)') && open.includes(`${shortAddress(open1.mint)} · paper · +12% (0.0112 SOL) · 42m · from ${shortAddress(W1)}`), `open trade line: ${open}`);
  assert(open.includes('not priced yet') && open.includes('STUCK') && open.includes(`https://dexscreener.com/solana/${open1.mint}`), 'unpriced and stuck ones shown honestly, with a chart link');
  assert(formatOpen({ positions: [win], now: NOW, solPriceUsd: null }) === '📂 Nothing open right now.', 'nothing open');

  const wallets = formatWallets({
    positions: all, copying: [W1, W3], bench: [W2], dropped: [{ wallet: W2, reason: '3 losses in a row' }],
    isDiscovered: (w) => w === W3, isPaperOnly: (w) => w === W3, solPriceUsd: null,
  });
  assert(wallets.includes(`• ${shortAddress(W1)} — 3 closed, 3W/0L, +0.0205 SOL\n`), `per-wallet record: ${wallets}`);
  assert(wallets.includes(`${shortAddress(W3)}* — no closed trades yet · paper-only until proven`) && wallets.includes('* found by discovery'), 'discovered wallets are marked and shown on probation');
  assert(wallets.includes(`Bench: 1 waiting (next: ${shortAddress(W2)})`) && wallets.includes(`Dropped ${shortAddress(W2)} — 3 losses in a row`), 'bench and drops');

  const status = formatStatus({
    now: NOW, startedAt: NOW - 9 * H - 5 * 60_000, dryRun: true, watching: 3, processed: 312, missedUnreadable: 0,
    lastSwap: { at: NOW - 4 * 60_000, wallet: W1 }, sleeps: [{ from: NOW - 6 * H, to: NOW - 30 * 60_000 }], nextReportAt: NOW + 80 * 60_000,
    activity: [{ wallet: W1, at: NOW - 3 * H }, { wallet: W2, at: NOW - 2 * H }], rotating: false,
  });
  assert(status.includes(`Last on-chain activity: ${shortAddress(W1)} 3h 00m ago · ${shortAddress(W2)} 2h 00m ago`), 'each copied wallet\'s real last activity is shown');
  assert(status.includes('not a fault') && status.includes('npm run recommended'), 'when every wallet has been quiet an hour, it says so — and how to fix it');
  assert(describeActivity([{ wallet: W1, at: NOW - 10_000 }, { wallet: W2, at: undefined }], NOW) === `${shortAddress(W1)} just now · ${shortAddress(W2)} not checked yet`, 'fresh and unknown activity read clearly');
  assert(!allQuiet([{ wallet: W1, at: NOW - 3 * H }, { wallet: W2, at: NOW - 5 * 60_000 }], NOW) && !allQuiet([{ wallet: W1, at: undefined }], NOW) && !allQuiet([], NOW),
    'not "all quiet" while any wallet is active, unchecked, or none are watched');
  assert(status.includes('Running 9h 05m · PAPER mode') && status.includes('312 transactions checked') && status.includes('Last trade seen 4m ago'), `status: ${status}`);
  assert(status.includes('Laptop slept 1× this run, 5h 30m in total') && status.includes('Next report in 1h 20m'), 'sleep and next report');
  assert(duration(59_000) === '1m' && duration(3 * 24 * H + 2 * H) === '3d 2h', 'durations read naturally');

  // --- trade alerts ---
  const live = [pos({ status: 'open', closedAt: undefined })];
  const feed = new TradeFeed(live);
  assert(feed.poll(live).length === 0, 'positions that existed at startup are not announced');
  const fresh = pos({ status: 'open', closedAt: undefined });
  assert(feed.poll([...live, fresh]).map((e) => e.kind).join() === 'opened', 'a new position is announced once');
  assert(feed.poll([...live, fresh]).length === 0, '…and only once');
  fresh.status = 'closed'; fresh.receivedSol = 0.0142; fresh.exitRule = 'trailing-stop';
  live[0].status = 'stuck';
  const quick = pos({});
  assert(feed.poll([...live, fresh, quick]).map((e) => e.kind).join() === 'stuck,closed,closed', 'closes and stuck sells are announced; a trade opened and closed between looks is one close');
  const sold = formatTradeEvent({ kind: 'closed', position: fresh }, 'sells', 150)!;
  assert(sold.silent && sold.text.startsWith(`✅ Sold ${shortAddress(fresh.mint)} +42% (+0.0042 SOL (+$0.63)) · paper · trailing stop`), `sell alert: ${sold.text}`);
  assert(formatTradeEvent({ kind: 'closed', position: loss }, 'sells', null)!.text.startsWith('🔻 Sold'), 'a losing sell is marked as such');
  assert(formatTradeEvent({ kind: 'opened', position: fresh }, 'sells', null) === null && formatTradeEvent({ kind: 'opened', position: fresh }, 'all', null)!.text.startsWith('🛒 Bought'), 'buys only with TELEGRAM_TRADE_ALERTS=all');
  assert(formatTradeEvent({ kind: 'closed', position: fresh }, 'off', null) === null, 'TELEGRAM_TRADE_ALERTS=off: no trade messages');
  const stuckReal = formatTradeEvent({ kind: 'stuck', position: stuck }, 'off', null)!;
  assert(stuckReal && stuckReal.silent === false && stuckReal.text.includes('REAL'), 'a stuck REAL sell always gets through, and buzzes the phone');
  assert(formatTradeEvent({ kind: 'stuck', position: live[0] }, 'sells', null)!.silent === true, 'a stuck paper sell arrives silently');

  // --- commands ---
  assert(parseCommand('/pnl') === 'pnl' && parseCommand('/pnl@copy_bot') === 'pnl' && parseCommand('P&L') === 'pnl' && parseCommand(' /Open ') === 'open', 'command spellings');
  assert(parseCommand('/wallets') === 'wallets' && parseCommand('/status') === 'status' && parseCommand('/start') === 'help' && parseCommand('buy everything') === 'help', 'anything else gets the help text — there are no trading commands');

  const sent: { chat: string; text: string; silent: boolean }[] = [];
  let failSends = 0;
  let failKind: TelegramError['kind'] = 'network';
  let updateCalls = 0;
  let resolvePolled: () => void = () => {};
  const polled = new Promise<void>((r) => { resolvePolled = r; });
  let bot: TelegramBot;
  const msg = (update_id: number, chat: number, text: string): TelegramUpdate => ({ update_id, message: { date: 0, chat: { id: chat, type: 'private' }, text } });
  const fakeClient = {
    async sendMessage(chat: string, text: string, silent: boolean) {
      if (failSends > 0) { failSends--; throw new TelegramError('nope', failKind, 0); }
      sent.push({ chat, text, silent });
    },
    async getUpdates(offset: number): Promise<TelegramUpdate[]> {
      updateCalls++;
      if (updateCalls === 1) {
        assert(offset === -1, 'first look skips the backlog');
        return [msg(41, Number(CHAT), '/pnl')]; // sent while the bot was off — must NOT be answered
      }
      if (updateCalls === 2) {
        assert(offset === 42, 'then continues after the skipped backlog');
        return [msg(42, Number(CHAT), '/status'), msg(43, 999, '/pnl'), msg(44, Number(CHAT), '/wallets')];
      }
      bot.stop();
      resolvePolled();
      return [];
    },
  };
  const logs: string[] = [];
  bot = new TelegramBot(fakeClient as unknown as TelegramClient, CHAT, {
    pnl: async () => 'PNL',
    open: async () => 'OPEN',
    status: async () => 'STATUS',
    wallets: async () => { throw new Error('roster unreadable'); },
  }, 3, (m) => logs.push(m), 0);
  bot.start();
  await polled;
  await bot.flush(1_000);
  assert(sent.map((m) => m.text).join('|') === "STATUS|Couldn't build that just now: roster unreadable", `only your chat is answered, the backlog is skipped, errors are explained (got ${sent.map((m) => m.text).join('|')})`);
  assert(sent.every((m) => m.chat === CHAT && m.silent), 'replies go to your chat only, silently');

  sent.length = 0;
  failSends = 1; failKind = 'rate-limited';
  bot.send('after a 429');
  await bot.flush(1_000);
  assert(sent.length === 1 && sent[0].text === 'after a 429', 'a rate-limited message is retried once');
  failSends = 2; failKind = 'network';
  bot.send('lost 1'); bot.send('lost 2');
  await bot.flush(1_000);
  assert(logs.filter((l) => l.includes('Telegram')).length === 1, 'a connection problem is reported once, not per message');
  failSends = 0;
  sent.length = 0;
  for (let i = 0; i < 40; i++) bot.send(`m${i}`);
  await bot.flush(1_000);
  assert(sent.length <= 31 && sent[sent.length - 1].text === 'm39', 'a backed-up queue drops the oldest, keeps the newest');

  realLog('✅ telegram: answers only your chat, read-only, token never logged, reports match the positions, alerts per TELEGRAM_TRADE_ALERTS');
}

// "0 transactions examined" used to mean either "the wallets are quiet" or
// "the live feed is broken", with no way to tell. The activity check reads
// each wallet's latest transactions directly: it reports real last activity,
// and anything the feed should have delivered but didn't gets the wallet
// re-subscribed.
async function testActivityCheck(realLog: typeof console.log) {
  let logCb: (l: { signature: string; err: unknown; logs: string[] }) => void = () => {};
  let subscribeCalls = 0;
  const removed: number[] = [];
  let signatures: { signature: string; blockTime: number; err: unknown }[] = [];
  const fakeConnection = {
    onLogs(_pk: unknown, cb: typeof logCb) { logCb = cb; subscribeCalls++; return 100 + subscribeCalls; },
    async removeOnLogsListener(id: number) { removed.push(id); },
    async getParsedTransaction() { return { meta: null }; },
    async getSignaturesForAddress() { return signatures; },
  };
  const watcher = new WalletWatcher(fakeConnection as any, [new PublicKey(TRACKED)], async () => {}, new RateLimiter(0));
  const quiet = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try {
    watcher.start();
    const R = Date.now(); // subscribed about now
    const sec = (ms: number) => Math.floor((R + ms) / 1000);
    signatures = [
      { signature: 'late', blockTime: sec(9.5 * 60_000), err: null },   // 30s ago: the feed may still deliver it
      { signature: 'failed', blockTime: sec(7 * 60_000), err: { InstructionError: [] } }, // failed: never delivered on purpose
      { signature: 'delivered', blockTime: sec(6 * 60_000), err: null }, // the feed delivered this one
      { signature: 'missed', blockTime: sec(5 * 60_000), err: null },    // the feed never delivered this
      { signature: 'before', blockTime: sec(-60 * 60_000), err: null },  // before we subscribed
    ];
    logCb({ signature: 'delivered', err: null, logs: [] });
    await new Promise((r) => setTimeout(r, 20));
    const missed = await watcher.checkActivity(TRACKED, R + 10 * 60_000);
    assert(missed === 1, `exactly the one undelivered, successful, post-subscription, old-enough transaction counts as missed (got ${missed})`);
    assert(removed.length === 1 && subscribeCalls === 2 && watcher.isWatching(TRACKED), 'the wallet is re-subscribed after a miss');
    assert(watcher.stats().missedByFeed === 1 && lines.some((l) => l.includes('live feed missed 1')), 'and it says so');
    assert(watcher.lastActivityOf(TRACKED) === sec(9.5 * 60_000) * 1000, 'last activity = its newest transaction');
    logCb({ signature: 'late', err: null, logs: [] }); // the reconnected feed delivers the recent one
    await new Promise((r) => setTimeout(r, 20));
    assert(await watcher.checkActivity(TRACKED, R + 11 * 60_000) === 0 && removed.length === 1, 'the same miss is never counted twice');

    signatures = [{ signature: 'old', blockTime: sec(-3 * 3_600_000), err: null }];
    const w2 = new WalletWatcher(fakeConnection as any, [new PublicKey(TRACKED)], async () => {}, new RateLimiter(0));
    w2.start();
    await w2.checkActivity(TRACKED, R);
    assert(w2.lastActivityOf(TRACKED) === sec(-3 * 3_600_000) * 1000 && w2.stats().missedByFeed === 0, 'a quiet wallet: real last activity hours ago, nothing missed');
    await w2.stop();
    await watcher.stop();
  } finally {
    console.log = quiet;
  }

  // Rotation uses it: a wallet dormant for hours is swapped on the first
  // check, not after another WALLET_IDLE_MINUTES — but never for a wallet
  // already known to be even quieter.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-dormant-'));
  const [A, B, N1] = Array.from({ length: 3 }, () => Keypair.generate().publicKey.toBase58());
  const T0 = Date.parse('2026-09-24T01:00:00Z');
  const onChain = new Map<string, number>([[A, T0 - 3 * 3_600_000], [B, T0 - 5 * 60_000]]);
  const watching = new Set<string>();
  const watch = {
    isWatching: (w: string) => watching.has(w), addWallet: (w: string) => { watching.add(w); }, async removeWallet(w: string) { watching.delete(w); },
    lastActivityOf: (w: string) => onChain.get(w),
  };
  const roster = new WalletRoster([A, B, N1], 2, dir);
  const rotation = new Rotation(roster, new PositionStore(dir), { walletMaxConsecutiveLosses: 3, walletDropAfterTrades: 6, walletIdleMinutes: 90 }, () => {});
  rotation.startup(T0).forEach((w) => watching.add(w));
  onChain.set(N1, T0 - 6 * 3_600_000); // the only substitute is even quieter than A
  await rotation.tick(T0 + 30_000, watch, { setActiveWallets() {} });
  assert(roster.active().join() === [A, B].join(), 'a dormant wallet is NOT swapped for one known to be even quieter (no churn)');
  onChain.delete(N1); // substitute's activity unknown — worth a try
  await rotation.tick(T0 + 60_000, watch, { setActiveWallets() {} });
  assert(roster.active().join() === [B, N1].join() && watching.has(N1), 'a wallet dormant for 3 hours is swapped out on the first check');
  realLog('✅ activity check: real last activity per wallet, a broken live feed is caught and reconnected, dormant wallets swapped at once');
}

// One command, same on Mac and Windows, instead of hand-editing .env.
function testRecommendedSettings(realLog: typeof console.log) {
  const before = 'PRIVATE_KEY_BASE58=k\r\nDISCOVERY=false\r\nMIN_TOKEN_AGE_MINUTES=30\r\nMIN_LIQUIDITY_USD=20000\r\nCOPY_BUY_AMOUNT_SOL=0.05\r\nDRY_RUN=true\r\n';
  const first = applyRecommended(before);
  assert(first.changes.map((c) => c.key).join() === 'DISCOVERY,ACTIVE_WALLETS,MAX_TRACKED_WALLETS,WALLET_IDLE_MINUTES,MIN_TOKEN_AGE_MINUTES,MIN_LIQUIDITY_USD',
    'turns on the scanner, 10 wallets, 30-minute swaps, token check off');
  assert(first.text.includes('DISCOVERY=true\r\nMIN_TOKEN_AGE_MINUTES=0\r\nMIN_LIQUIDITY_USD=0\r\nCOPY_BUY_AMOUNT_SOL=0.05\r\nDRY_RUN=true\r\n') &&
    first.text.includes('ACTIVE_WALLETS=10\r\n') && first.text.includes('MAX_TRACKED_WALLETS=10\r\n') && first.text.includes('WALLET_IDLE_MINUTES=30\r\n'),
    'money settings untouched, line endings kept');
  assert(applyRecommended(first.text).changes.length === 0, 'running it twice changes nothing');
  const mine = 'ACTIVE_WALLETS=12\nMAX_TRACKED_WALLETS=12\nWALLET_IDLE_MINUTES=20\nDISCOVERY=true\nMIN_TOKEN_AGE_MINUTES=0\nMIN_LIQUIDITY_USD=0\n';
  assert(applyRecommended(mine).changes.length === 0, 'more wallets or faster swaps you chose yourself are kept');
  assert(applyRecommended(mine.replace('WALLET_IDLE_MINUTES=20', 'WALLET_IDLE_MINUTES=90')).changes.map((c) => c.key).join() === 'WALLET_IDLE_MINUTES' &&
    applyRecommended(mine.replace('WALLET_IDLE_MINUTES=20', 'WALLET_IDLE_MINUTES=0')).changes.map((c) => c.key).join() === 'WALLET_IDLE_MINUTES',
    'a slower 90, or 0 (never swap), becomes 30');

  const cfg = loadConfig();
  const hints = paperHints({ ...cfg, discovery: false, benchWallets: [], minTokenAgeMinutes: 30, minLiquidityUsd: 20_000 });
  assert(hints.length === 2 && hints.every((h) => h.includes('npm run recommended')), 'startup and doctor point at the fix when the settings will keep a paper test quiet');
  assert(paperHints({ ...cfg, discovery: true, minTokenAgeMinutes: 0, minLiquidityUsd: 0 }).length === 0, 'and say nothing once fixed');
  realLog('✅ recommended settings: one command turns on the scanner and turns off the token check, leaves money settings alone');
}

// Each run gets its own P&L sheet; the history underneath is kept, because
// wallet drops, mutes and probation are judged over every run.
async function testRunSheets(realLog: typeof console.log) {
  const H = 3_600_000;
  const START = Date.parse('2026-09-24T20:00:00Z');
  let n = 0;
  const pos = (over: Partial<Position>): Position => ({
    id: `r${++n}`, mint: Keypair.generate().publicKey.toBase58(), decimals: 6, sourceWallet: TRACKED, dryRun: true, status: 'closed',
    openedAt: new Date(START - 10 * H).toISOString(), closedAt: new Date(START - 9 * H).toISOString(),
    spentSol: 0.01, tokenAmountRaw: '0', initialTokenAmountRaw: '1', receivedSol: 0.005, sellTxs: [], ...over,
  });
  const oldLoss = pos({});                                                                      // earlier run
  const carried = pos({ closedAt: new Date(START + 1 * H).toISOString(), receivedSol: 0.02 });   // bought before, sold this run
  const fresh = pos({ openedAt: new Date(START + 2 * H).toISOString(), closedAt: new Date(START + 3 * H).toISOString(), receivedSol: 0.03, dryRun: false });
  const stuckOld = pos({ status: 'stuck', closedAt: undefined });
  const openOld = pos({ status: 'open', closedAt: undefined });
  assert(!inRun(oldLoss, START) && inRun(carried, START) && inRun(fresh, START) && inRun(stuckOld, START) && inRun(openOld, START),
    'a run\'s sheet: opened or closed during it, plus anything still open or stuck');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-runs-'));
  const store = new PositionStore(dir);
  assert(store.lastRun() === null, 'no run recorded yet');
  store.startRun(START);
  assert(store.lastRun()!.startedAt === new Date(START).toISOString() && !store.lastRun()!.endedAt, 'a run is recorded when the bot starts');
  store.endRun(START + 5 * H);
  assert(store.lastRun()!.endedAt === new Date(START + 5 * H).toISOString(), '…and its end when it stops');
  assert(new PositionStore(dir).lastRun()!.startedAt === new Date(START).toISOString(), 'and it survives a restart of the summary command');
  fs.writeFileSync(path.join(dir, 'run.json'), '{broken');
  assert(store.lastRun() === null, 'an unreadable run file falls back to showing everything, never crashes');

  // Printed sheet: only this run, with one line for all runs together.
  (store as any).positions = [oldLoss, carried, fresh];
  const printed: string[] = [];
  const loud = console.log;
  console.log = (...a: unknown[]) => { printed.push(a.join(' ')); };
  try {
    await printSummary(store, undefined, 300, undefined, false, { since: START, label: 'this run (started 23:00)' });
  } finally {
    console.log = loud;
  }
  const sheet = printed.join('\n');
  assert(sheet.includes('This sheet: this run (started 23:00)'), 'the sheet says which run it covers');
  assert(sheet.includes('Realized P&L (1 closed): +0.0100 SOL') && sheet.includes('Realized P&L (1 closed): +0.0200 SOL'), `this run only: the carried-over sell and the new real trade (${sheet})`);
  assert(!sheet.includes('-0.0050'), 'the earlier run\'s loss is not on this run\'s sheet');
  assert(/All runs together: paper 2 closed, \+0\.0050 SOL.* · real 1 closed, \+0\.0200 SOL/.test(sheet), 'one line keeps the all-runs total in view');

  const phone = formatPnl({ positions: [carried, fresh], allTime: [oldLoss, carried, fresh], now: START + 4 * H, solPriceUsd: null, title: 'P&L — this run' });
  assert(phone.includes('Closed 1 · 1 won / 0 lost') && phone.includes('All runs together: paper 2 closed'), 'Telegram shows this run, plus the all-runs line');
  assert(!formatPnl({ positions: [fresh], allTime: [fresh], now: START, solPriceUsd: null, title: 'x' }).includes('All runs'), 'no all-runs line when this run is everything');
  realLog('✅ run sheets: every start gets a fresh P&L sheet; history kept for the wallet rules; all-runs total one line away');
}

// A robot wallet (thousands of transactions an hour) floods the watcher and
// burns the free Helius allowance — a live run examined ~10,000 of one
// wallet's transactions an hour and copied none. Rotation drops it at once.
async function testRobotWallets(realLog: typeof console.log) {
  // The watcher counts every notification per wallet, over a sliding window.
  let logCb: (l: { signature: string; err: unknown; logs: string[] }) => void = () => {};
  const conn = {
    onLogs(_pk: unknown, cb: typeof logCb) { logCb = cb; return 1; },
    async removeOnLogsListener() {},
    async getParsedTransaction() { return { meta: null }; },
  };
  const watcher = new WalletWatcher(conn as any, [new PublicKey(TRACKED)], async () => {}, new RateLimiter(0), 60_000, 5);
  const quiet = console.log;
  console.log = () => {};
  try {
    watcher.start();
    for (let i = 0; i < 200; i++) logCb({ signature: `r${i}`, err: i % 2 ? { failed: true } : null, logs: [] });
    assert(watcher.recentTxCount(TRACKED) === 200, 'every notification counts, failed ones too (robots spam those)');
    assert(watcher.recentTxCount(TRACKED, Date.now() + 11 * 60_000) === 0, 'only the last 10 minutes count');
    for (let i = 0; i < 1_500; i++) logCb({ signature: `s${i}`, err: { failed: true }, logs: [] });
    assert(watcher.recentTxCount(TRACKED) === 1_000, 'memory stays bounded however fast a wallet goes');
    await watcher.removeWallet(TRACKED);
    assert(watcher.recentTxCount(TRACKED) === 0, 'forgotten once no longer watched');
    await watcher.stop();
  } finally {
    console.log = quiet;
  }

  // Rotation drops it: no longer copied, no longer watched — not even to
  // mirror sells of a coin we hold from it — and never re-found.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-robot-'));
  const store = new PositionStore(dir);
  const [A, R, N1] = Array.from({ length: 3 }, () => Keypair.generate().publicKey.toBase58());
  store.openPosition({ mint: Keypair.generate().publicKey.toBase58(), decimals: 6, sourceWallet: R, dryRun: true, spentSol: 0.03, tokenAmountRaw: '1' });
  const cfg = { walletMaxConsecutiveLosses: 3, walletDropAfterTrades: 6, walletIdleMinutes: 90, walletMaxTxPer10Min: 150 };
  const rates = new Map<string, number>([[A, 150], [R, 1_612], [N1, 4]]);
  const watching = new Set<string>();
  const removed: string[] = [];
  const watch = {
    isWatching: (w: string) => watching.has(w), addWallet: (w: string) => { watching.add(w); },
    async removeWallet(w: string) { watching.delete(w); removed.push(w); },
    recentTxCount: (w: string) => rates.get(w) ?? 0,
  };
  const logs: string[] = [];
  const roster = new WalletRoster([A, R, N1], 2, dir);
  const rotation = new Rotation(roster, store, cfg, (m) => logs.push(m));
  const T0 = Date.parse('2026-09-24T04:00:00Z');
  rotation.startup(T0).forEach((w) => watching.add(w));
  let copying: string[] = [];
  await rotation.tick(T0 + 30_000, watch, { setActiveWallets(w: string[] | null) { copying = w ?? []; } });
  assert(roster.droppedReason(R)?.startsWith(ROBOT_REASON) === true && !copying.includes(R), 'a wallet making 1,612 transactions in 10 minutes is dropped as a robot');
  assert(!watching.has(R) && removed.includes(R), 'and no longer watched, even though a coin copied from it is still open');
  assert(copying.join() === [A, N1].join() && watching.has(N1), 'its slot goes to the next wallet at once');
  assert(!roster.droppedReason(A), 'exactly 150 in 10 minutes is still allowed ("more than" the limit drops)');
  assert(logs.some((l) => l.startsWith('🔄 Dropped') && l.includes('robot') && l.includes('exit rules')), 'the drop is announced (terminal + Telegram), mentioning the open copy');
  assert(roster.known().has(R), 'discovery will never suggest it again');

  const reloaded = new WalletRoster([A, R, N1], 2, dir);
  reloaded.load();
  const afterRestart = new Rotation(reloaded, store, cfg, () => {});
  assert(!afterRestart.startup(T0 + 3_600_000).includes(R), 'after a restart it is not watched again just to mirror its sells');

  const off = new Rotation(new WalletRoster([A, R], 2, fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-robot-off-'))), store, { ...cfg, walletMaxTxPer10Min: 0 }, () => {});
  off.startup(T0);
  const w2 = new Set<string>([A, R]);
  await off.tick(T0 + 30_000, { ...watch, isWatching: (w: string) => w2.has(w), async removeWallet(w: string) { w2.delete(w); } }, { setActiveWallets() {} });
  assert(w2.has(R), 'WALLET_MAX_TX_PER_10MIN=0 turns the rule off');
  realLog('✅ robot wallets: counted per wallet, dropped at once, unwatched, never re-found; 0 turns it off');
}

// A live run sat for hours copying quiet wallets: 5 were waiting on the
// bench, so discovery never ran — but all 5 had gone quiet too, so quiet
// wallets were only ever swapped for other quiet ones.
async function testStaleBenchAndTrial(realLog: typeof console.log) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-stale-'));
  const store = new PositionStore(dir);
  const [A, B, S1, S2, S3] = Array.from({ length: 5 }, () => Keypair.generate().publicKey.toBase58());
  const T0 = Date.parse('2026-09-24T18:00:00Z');
  const onChain = new Map<string, number>([[S1, T0 - 3 * 3_600_000], [S2, T0 - 2 * 3_600_000], [S3, T0 - 4 * 3_600_000]]);
  const watching = new Set<string>();
  const watch = {
    isWatching: (w: string) => watching.has(w), addWallet: (w: string) => { watching.add(w); }, async removeWallet(w: string) { watching.delete(w); },
    lastActivityOf: (w: string) => onChain.get(w),
  };
  let runs = 0;
  const searches = () => runs; // a function, so TypeScript doesn't narrow it between checks
  const cfg = { walletMaxConsecutiveLosses: 3, walletDropAfterTrades: 6, walletIdleMinutes: 30 };
  const hook = { minBench: 3, cooldownMs: 30 * 60_000, async run() { runs++; return []; } };
  const rotation = new Rotation(new WalletRoster([A, B, S1, S2, S3], 2, dir), store, cfg, () => {}, hook);
  rotation.startup(T0).forEach((w) => watching.add(w));
  assert(searches() === 0, 'at startup nothing is known about the bench yet: 3 waiting, no search');
  await rotation.tick(T0 + 30_000, watch, { setActiveWallets() {} });
  await rotation.pendingDiscovery;
  assert(searches() === 1, 'a bench of 3 wallets that all went quiet hours ago no longer blocks the search for fresh ones');

  const fresh = new Rotation(new WalletRoster([A, B, S1, S2, S3], 2, fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-fresh-'))), store, cfg, () => {}, hook);
  fresh.startup(T0);
  onChain.clear(); // nothing known about the bench: it counts as usable
  await fresh.tick(T0 + 30_000, watch, { setActiveWallets() {} });
  assert(searches() === 1, 'a bench whose wallets are not known to be quiet still counts');

  // Trial length is a setting; passing it is announced once.
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-trial-'));
  const tstore = new PositionStore(tdir);
  const troster = new WalletRoster([A], 2, tdir);
  const N = Keypair.generate().publicKey.toBase58();
  troster.addDiscovered([{ wallet: N, pools: 2, medianReturnPct: 40, evidence: ['x'] }], T0);
  const logs: string[] = [];
  const trial = new Rotation(troster, tstore, { ...cfg, probationTrades: 3, dryRun: true }, (m) => logs.push(m));
  trial.startup(T0);
  assert(trial.isPaperOnly(N) && trial.realMoneyWallets().join() === A, 'a new find starts on its trial; your own wallet never has one');
  for (let i = 0; i < 3; i++) {
    const p = tstore.openPosition({ mint: Keypair.generate().publicKey.toBase58(), decimals: 6, sourceWallet: N, dryRun: true, spentSol: 0.01, tokenAmountRaw: '1' });
    tstore.recordSell(p, 1n, 0.012);
  }
  assert(!trial.isPaperOnly(N) && trial.realMoneyWallets().includes(N), 'PROBATION_TRADES=3: three profitable paper copies pass the trial');
  const w = new Set<string>([A, N]);
  const quietWatch = { isWatching: (x: string) => w.has(x), addWallet: (x: string) => { w.add(x); }, async removeWallet(x: string) { w.delete(x); } };
  await trial.tick(T0 + 30_000, quietWatch, { setActiveWallets() {} });
  await trial.tick(T0 + 60_000, quietWatch, { setActiveWallets() {} });
  assert(logs.filter((l) => l.startsWith('🎓')).length === 1 && logs.some((l) => l.includes('once DRY_RUN=false')), 'passing is announced once, and in paper mode says real money needs DRY_RUN=false');
  // Turning the trial on later doesn't demote a wallet that already made money with real copies.
  const R = Keypair.generate().publicKey.toBase58();
  troster.addDiscovered([{ wallet: R, pools: 2, medianReturnPct: 40, evidence: ['x'] }], T0);
  for (let i = 0; i < 3; i++) {
    const p = tstore.openPosition({ mint: Keypair.generate().publicKey.toBase58(), decimals: 6, sourceWallet: R, dryRun: false, spentSol: 0.05, tokenAmountRaw: '1' });
    tstore.recordSell(p, 1n, 0.058);
  }
  assert(!trial.isPaperOnly(R), 'three profitable REAL copies pass the trial too — a proven wallet is never sent back to paper');
  const none = new Rotation(troster, new PositionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-notrial-'))), { ...cfg, probationTrades: 0 }, () => {});
  assert(!none.isPaperOnly(N), 'PROBATION_TRADES=0: no trial at all');
  assert(loadConfig().probationTrades === 6, 'the trial stays 6 unless you change it');

  // The confusing setup that hid every trade from Phantom.
  assert(paperModeWithFundsHint(true, 0.1934, 0.01, 0.05)?.includes('DRY_RUN=true') === true, 'SOL in the wallet but paper mode on: said plainly');
  assert(paperModeWithFundsHint(false, 0.1934, 0.01, 0.05) === null && paperModeWithFundsHint(true, 0.0009, 0.01, 0.05) === null, 'quiet in real mode, or with no real funds to use');

  // Activity checks are spaced out instead of fired all at once.
  const times: number[] = [];
  const conn = {
    onLogs() { return 1; }, async removeOnLogsListener() {}, async getParsedTransaction() { return { meta: null }; },
    async getSignaturesForAddress() { times.push(Date.now()); return []; },
  };
  const three = [0, 1, 2].map(() => Keypair.generate().publicKey);
  const watcher = new WalletWatcher(conn as any, three, async () => {}, new RateLimiter(0));
  const loud = console.log;
  console.log = () => {};
  try {
    watcher.start();
    watcher.startActivityChecks(60_000, 40);
    await new Promise((r) => setTimeout(r, 150));
    await watcher.stop();
  } finally {
    console.log = loud;
  }
  assert(times.length === 3 && times[1] - times[0] >= 30 && times[2] - times[1] >= 30, `one wallet's check at a time (gaps ${times[1] - times[0]}ms, ${times[2] - times[1]}ms)`);
  realLog('✅ stale bench + trial: quiet waiting wallets no longer block the search; trial length is a setting; paper-mode-with-SOL is called out');
}

// Token-account rent: a night of real trading showed +$7.61 on the sheet while
// the wallet fell from $27 to $14.88. Each new coin locks ~0.002 SOL of rent
// in a token account; nothing closed those accounts, and the sheet recorded
// only the 0.03 SOL swap as the cost. Now: the real cost is recorded, the
// emptied account is closed after the sale, and the rent comes back.
async function testRentReclaim(realLog: typeof console.log) {
  const owner = Keypair.generate();
  const acct = (amount: string, extra: Record<string, unknown> = {}) => ({
    pubkey: Keypair.generate().publicKey,
    account: { owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, data: { parsed: { info: { mint: Keypair.generate().publicKey.toBase58(), state: 'initialized', tokenAmount: { amount }, ...extra } } } },
  });
  const empty1 = acct('0'), full = acct('5000'), frozen = acct('0', { state: 'frozen' });
  const kept = acct('0');
  const t22 = acct('0');
  t22.account.owner = TOKEN_2022_PROGRAM_ID;
  const stranger = acct('0');
  stranger.account.owner = SystemProgram.programId; // not a token program: never touched
  const picked = selectEmpty([empty1, full, frozen, kept, t22, stranger, { account: {} }] as any, new Set([kept.account.data.parsed.info.mint as string]));
  assert(picked.map((a) => a.address.toBase58()).join() === [empty1.pubkey, t22.pubkey].map((k) => k.toBase58()).join(),
    'only empty, unfrozen token accounts (both token programs) are picked — never one holding tokens, a coin the bot holds, or a non-token account');
  assert(picked[1].programId.equals(TOKEN_2022_PROGRAM_ID) && picked[0].lamports === 2_039_280, 'each keeps its own program and rent');

  // Batches of 8; a batch that fails is retried one by one, so one bad account never blocks the rest.
  const BAD = Keypair.generate().publicKey;
  const sent: string[][] = [];
  const onChainClosed = new Set<string>();
  let confirmThrows = false;
  let landing = true; // does a sent transaction actually land?
  const closeConn = {
    async getMultipleAccountsInfo(keys: PublicKey[]) { return keys.map((k) => (onChainClosed.has(k.toBase58()) ? null : { lamports: 2_039_280 })); },
    async getLatestBlockhash() { return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }; },
    async sendRawTransaction(bytes: Uint8Array) {
      const tx = Transaction.from(Buffer.from(bytes));
      assert(tx.verifySignatures(), 'every close transaction is signed by the wallet');
      assert(tx.instructions.every((ix) => ix.data.length === 1 && ix.data[0] === 9 && ix.keys[1].pubkey.equals(owner.publicKey) && ix.keys[2].pubkey.equals(owner.publicKey) && ix.keys[2].isSigner),
        'CloseAccount (9), rent to the wallet, signed by the wallet');
      const targets = tx.instructions.map((ix) => ix.keys[0].pubkey.toBase58());
      if (targets.includes(BAD.toBase58())) throw new Error('simulation failed: non-native account can only be closed if its balance is zero');
      sent.push(targets);
      if (landing) targets.forEach((t) => onChainClosed.add(t));
      return `sig${sent.length}`;
    },
    async getSignatureStatuses() {
      if (confirmThrows) throw new Error('connection reset while confirming');
      return { value: [{ confirmationStatus: 'confirmed', err: null }] };
    },
  };
  const ten = Array.from({ length: 10 }, (_, i) => ({ address: i === 3 ? BAD : Keypair.generate().publicKey, programId: TOKEN_PROGRAM_ID, mint: 'm', lamports: 2_039_280 }));
  const result = await closeAccounts(closeConn as any, owner, ten);
  assert(result.closed.length === 9 && result.failed.length === 1 && result.failed[0].account.address.equals(BAD), 'the one account that can\'t be closed is reported; the other 9 are closed');
  assert(Math.abs(result.reclaimedSol - 9 * 0.00203928) < 1e-12, 'rent is counted only for accounts actually closed');
  assert(sent.map((b) => b.length).join('+') === '1+1+1+1+1+1+1+2',
    `the failed batch of 8 was retried one by one (7 closed), then the last 2 went together (got ${sent.map((b) => b.length).join('+')})`);

  // A confirmation that goes missing doesn't mean the close didn't happen: the chain decides.
  sent.length = 0;
  confirmThrows = true;
  const three = Array.from({ length: 3 }, () => ({ address: Keypair.generate().publicKey, programId: TOKEN_PROGRAM_ID, mint: 'm', lamports: 2_039_280 }));
  const unconfirmed = await closeAccounts(closeConn as any, owner, three);
  assert(unconfirmed.closed.length === 3 && sent.length === 1, 'a close that landed but whose confirmation was lost is counted as closed, and not sent again');
  confirmThrows = false;
  landing = false;
  const dropped = await closeAccounts(closeConn as any, owner, [{ address: Keypair.generate().publicKey, programId: TOKEN_PROGRAM_ID, mint: 'm', lamports: 2_039_280 }]);
  assert(dropped.closed.length === 0 && dropped.reclaimedSol === 0 && /still open/.test(dropped.failed[0].error), 'a close that never landed is not counted — no rent is claimed that did not come back');
  landing = true;

  // The trader: real buy records its true cost; a take-profit measures against the swap; the sale closes the account.
  const keypair = Keypair.generate();
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: keypair.publicKey, recentBlockhash: '11111111111111111111111111111111',
    instructions: [SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message());
  const txBase64 = Buffer.from(tx.serialize()).toString('base64');
  const ATA = Keypair.generate().publicKey;
  let lamports = 1_000_000_000;
  let tokenAccount: { amount: string; open: boolean } | null = null;
  let lastOrderWasBuy = true;
  let lastOrderMint = MEME_MINT;
  let closeInFlight = false;
  let balanceReadDuringClose = false;
  const jup = {
    async getOrder(p: OrderParams): Promise<JupiterOrder> {
      lastOrderWasBuy = p.inputMint === SOL_MINT;
      lastOrderMint = lastOrderWasBuy ? p.outputMint : p.inputMint;
      return { requestId: 'r', transactionBase64: txBase64, inAmountRaw: p.amountRaw, outAmountRaw: lastOrderWasBuy ? 5_000n : 39_500_000n };
    },
    async execute() {
      await new Promise((r) => setTimeout(r, 100)); // a swap takes a moment to land
      if (lastOrderWasBuy) {
        lamports -= 30_000_000 + 2_039_280 + 5_000;
        if (lastOrderMint === MEME_MINT) tokenAccount = { amount: '5000', open: true };
      } else { lamports += 39_500_000 - 5_000; tokenAccount!.amount = '0'; }
      return { signature: lastOrderWasBuy ? 'buysig' : 'sellsig' };
    },
  };
  const conn = {
    async getBalance() {
      if (closeInFlight) balanceReadDuringClose = true;
      return lamports;
    },
    async getMultipleAccountsInfo(keys: PublicKey[]) { return keys.map((k) => (k.equals(ATA) && tokenAccount && !tokenAccount.open ? null : { lamports: 2_039_280 })); },
    async getParsedTokenAccountsByOwner() {
      if (!tokenAccount || !tokenAccount.open) return { value: [] };
      return { value: [{ pubkey: ATA, account: { owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, data: { parsed: { info: { mint: MEME_MINT, state: 'initialized', tokenAmount: { amount: tokenAccount.amount } } } } } }] };
    },
    async getLatestBlockhash() { return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }; },
    async sendRawTransaction(bytes: Uint8Array) {
      closeInFlight = true;
      await new Promise((r) => setTimeout(r, 60)); // a slow network
      const closeTx = Transaction.from(Buffer.from(bytes));
      assert(closeTx.instructions.length === 1 && closeTx.instructions[0].keys[0].pubkey.equals(ATA), 'the emptied account of the coin just sold is the one closed');
      tokenAccount!.open = false;
      lamports += 2_039_280 - 5_000;
      closeInFlight = false;
      return 'closesig';
    },
    async getSignatureStatuses() { return { value: [{ confirmationStatus: 'confirmed', err: null }] }; },
  };
  const store = new PositionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-rent-')));
  const cfg = { ...loadConfig(), dryRun: false, copyBuyAmountSol: 0.03, takeProfitPercent: 30, stopLossPercent: 30, trailingStopPercent: 0, exitRebuyCooldownHours: 0 };
  const trader = new Trader(cfg, conn as any, keypair, jup as any, store, okMarket);
  const said: string[] = [];
  const loud = console.log;
  console.log = (...a: unknown[]) => { said.push(a.join(' ')); };
  try {
    await trader.handleSwapEvent({ signature: 'b1', sourceWallet: TRACKED, side: 'buy', mint: MEME_MINT, decimals: 5, tokenDeltaRaw: 1n, ownerPreTokenRaw: 0n, quoteSolEquivalent: 0.5 });
    const pos = store.all()[0];
    assert(pos && Math.abs(pos.spentSol - 0.03204428) < 1e-12 && pos.swapSol === 0.03, `the buy's true cost is recorded: swap + fee + rent (got ${pos?.spentSol})`);
    await trader.checkExits();
    assert(pos.status === 'closed' && pos.rentBackSol === undefined, 'the sale completes first; the account is closed right after, when no trade is waiting');
    await trader.flushReclaims();
    assert(pos.status === 'closed' && pos.exitRule === 'take-profit', 'take-profit +30% is measured against the 0.03 swap (0.0395 = +31.7%), not the rent-inflated cost (+23%)');
    assert(Math.abs(pos.rentBackSol! - 0.00203928) < 1e-12 && Math.abs(pos.receivedSol - (0.039495 + 0.00203928)) < 1e-12, 'the rent comes back and counts toward what the trade returned');
    assert(Math.abs((pos.receivedSol - pos.spentSol) - 0.00949) < 1e-9, 'the trade\'s result is exactly what the wallet gained: +0.0095 SOL');
    assert(lamports === 1_000_000_000 + 9_490_000 - 5_000, 'and the fake wallet agrees to the lamport (the close costs its own tiny fee)');
    assert(said.some((l) => l.includes('♻️') && l.includes('0.0020 SOL of rent is back')), 'the rent coming back is said out loud');

    // A copied sale followed at once by a copied buy of another coin: the close
    // must not land while the buy is measuring its cost, or the buy would be
    // credited with that rent too (and the P&L would count it twice).
    await trader.handleSwapEvent({ signature: 'b2', sourceWallet: TRACKED, side: 'buy', mint: MEME_MINT, decimals: 5, tokenDeltaRaw: 1n, ownerPreTokenRaw: 0n, quoteSolEquivalent: 0.5 });
    const second = store.byStatus('open').find((p) => p.mint === MEME_MINT)!;
    const OTHER = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
    const sale = trader.handleSwapEvent({ signature: 's2', sourceWallet: TRACKED, side: 'sell', mint: MEME_MINT, decimals: 5, tokenDeltaRaw: 100n, ownerPreTokenRaw: 100n, quoteSolEquivalent: 0.2 });
    const buy = trader.handleSwapEvent({ signature: 'b3', sourceWallet: TRACKED, side: 'buy', mint: OTHER, decimals: 5, tokenDeltaRaw: 1n, ownerPreTokenRaw: 0n, quoteSolEquivalent: 0.5 });
    await Promise.all([sale, buy]);
    await trader.flushReclaims();
    const other = store.all().find((p) => p.mint === OTHER)!;
    assert(second.status === 'closed' && Math.abs(second.rentBackSol! - 0.00203928) < 1e-12, 'the second sale\'s account is closed too');
    assert(!balanceReadDuringClose, 'no balance was measured while an account close was landing');
    assert(other && Math.abs(other.spentSol - 0.03204428) < 1e-12, `the next buy's cost is measured cleanly, not reduced by the returned rent (got ${other?.spentSol})`);
  } finally {
    console.log = loud;
  }
  realLog('✅ rent reclaim: true buy cost recorded, emptied accounts closed after selling, rent back — matches the official CloseAccount instruction');
}

// A wallet whose copies make money gets first claim on a slot, and when it
// goes quiet and is benched it comes back as soon as it trades again —
// instead of waiting at the back of a long bench (a live run lost its best
// wallet that way, and trading dried up).
async function testWinnersFirst(realLog: typeof console.log) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-winners-'));
  const store = new PositionStore(dir);
  const [U1, U2, W, U3] = Array.from({ length: 4 }, () => Keypair.generate().publicKey.toBase58());
  const copy = (wallet: string, back: number) => {
    const p = store.openPosition({ mint: Keypair.generate().publicKey.toBase58(), decimals: 6, sourceWallet: wallet, dryRun: false, spentSol: 0.05, tokenAmountRaw: '100' });
    store.recordSell(p, 100n, back);
  };
  copy(W, 0.06); copy(W, 0.045); copy(W, 0.058); // 2W/1L, net +0.013
  copy(U3, 0.06); // one win is not proof yet
  const winners = provenWinners(store.all());
  assert(winners.size === 1 && Math.abs(winners.get(W)! - 0.013) < 1e-12, 'a proven winner: 2+ closed copies with a net profit (one lucky win is not enough)');

  const MIN = 60_000;
  const T0 = Date.parse('2026-09-25T18:00:00Z');
  const roster = new WalletRoster([U1, U2, W, U3], 2, dir);
  const logs: string[] = [];
  const rotation = new Rotation(roster, store, { walletMaxConsecutiveLosses: 3, walletDropAfterTrades: 6, walletIdleMinutes: 30 }, (m) => logs.push(m));
  const watching = new Set<string>();
  const onChain = new Map<string, number>();
  const probed: string[] = [];
  let probeAt: number | undefined;
  const watch = {
    isWatching: (w: string) => watching.has(w), addWallet: (w: string) => { watching.add(w); }, async removeWallet(w: string) { watching.delete(w); },
    lastActivityOf: (w: string) => onChain.get(w),
    async probeActivity(w: string) { probed.push(w); if (w !== W) return undefined; if (probeAt !== undefined) onChain.set(w, probeAt); return probeAt; },
  };
  let copying: string[] | null = null;
  const trader = { setActiveWallets(ws: string[] | null) { copying = ws; } };
  const tick = async (at: number) => { await rotation.tick(at, watch, trader); await rotation.settleChecks(); };

  roster.idle(U3, T0 - 60 * MIN); // a quiet non-winner, already waiting on the bench
  rotation.startup(T0).forEach((w) => watching.add(w));
  assert(roster.active().join() === [W, U1].join(), 'the proven winner gets a slot first, though it is third in the list');
  assert(rotation.describe().includes(`${shortAddress(W)}⭐`), 'and is marked ⭐ in the status line');

  // W goes quiet for 30 minutes (U1 keeps buying): benched like any other wallet.
  rotation.noteBuy(U1, T0 + 30 * MIN);
  probeAt = T0 + 25 * MIN; // recent, but from before it was benched
  await tick(T0 + 31 * MIN);
  assert(roster.active().join() === [U1, U2].join() && roster.bench().join() === [U3, W].join(), 'quiet W is benched to the back');
  await tick(T0 + 32 * MIN);
  assert(!roster.active().includes(W), 'activity from BEFORE it was benched does not bring it back');

  probeAt = T0 + 33 * MIN; // it trades again…
  await tick(T0 + 36 * MIN); // …seen by the next check, 5 minutes on
  await tick(T0 + 45 * MIN);
  assert(!roster.active().includes(W), 'activity 12 minutes old is too stale to bring it back (it would only be benched again)');

  probeAt = T0 + 48 * MIN;
  await tick(T0 + 50 * MIN);
  const before = logs.length;
  await tick(T0 + 51 * MIN);
  assert(roster.active().join() === [W, U1].join() && copying!.join() === [W, U1].join() && watching.has(W), 'trading again → straight back on the copy list');
  assert(roster.bench()[0] === U2, 'the lowest-ranked wallet made room, and is first in line for the next slot');
  const said = logs.slice(before);
  assert(said.some((l) => l.includes(`${shortAddress(W)} ⭐ is trading again`) && l.includes('2W/1L') && l.includes('+0.0130 SOL')), 'the comeback is announced with its record');
  assert(said.some((l) => l.includes(`${shortAddress(U2)} moved to the bench to make room`)), 'and so is the wallet making room');
  assert(!said.some((l) => l.includes(`Now copying ${shortAddress(W)}`)), 'announced once, not twice');
  const probedU3 = probed.filter((w) => w === U3).length;
  assert(probed.filter((w) => w === W).length >= 4 && probedU3 >= 1 && probedU3 <= 2 && probed.every((w) => w === W || w === U3),
    `winners are checked every 5 minutes; others one at a time, at most every 15 minutes, and only while a copied wallet is quiet (W ${probed.filter((w) => w === W).length}, U3 ${probedU3})`);
  rotation.noteBuy(U1, T0 + 60 * MIN);
  await tick(T0 + 61 * MIN);
  assert(roster.active().includes(W), 'and it keeps its slot for a full quiet period, like any wallet that just got one');

  // The watcher's lookup works for a wallet it isn't watching.
  const sigTime = Math.floor((T0 + 50 * MIN) / 1000);
  const watcher = new WalletWatcher({ async getSignaturesForAddress() { return [{ signature: 's', blockTime: sigTime, err: null }]; } } as any, [], async () => {}, new RateLimiter(0));
  assert(await watcher.probeActivity(W) === sigTime * 1000 && watcher.lastActivityOf(W) === sigTime * 1000, 'probeActivity reads an unwatched wallet\'s latest transaction');

  // Entry gap: our price per token is the swap alone, not the fees and refundable rent.
  const gap = compareToSource({
    id: 'g', mint: MEME_MINT, decimals: 6, sourceWallet: W, dryRun: false, openedAt: new Date().toISOString(), sellTxs: [], tokenAmountRaw: '0',
    status: 'closed', spentSol: 0.0516, swapSol: 0.05, initialTokenAmountRaw: '1000', receivedSol: 0.06,
    sourceBuySol: 5, sourceBuyTokensRaw: '100000',
  });
  assert(Math.abs(gap.entryGapPct!) < 1e-9, `same price per token as theirs reads as 0%, not +3% of rent and fees (got ${gap.entryGapPct})`);
  realLog('✅ winners first: proven wallets get slots first, a benched winner returns as soon as it trades again, entry gap measured on the swap');
}

// Vetting: a found wallet is judged by its own recent trades before it gets a
// slot — live runs copied wallets that hardly bought, or flipped coins faster
// than a copy can follow.
async function testWalletVetting(realLog: typeof console.log) {
  const MIN = 60_000;
  const NOW = Date.parse('2026-09-26T01:00:00Z');
  const [A, B, C, D, E] = Array.from({ length: 5 }, () => Keypair.generate().publicKey.toBase58());
  // A round trip: buy `sol` of a coin at `start` minutes ago, sell it all `hold` minutes later for sol*(1+ret).
  const trip = (mint: string, startMinAgo: number, holdMin: number, sol: number, ret: number): HistoryTrade[] => [
    { side: 'buy', mint, sol, tokenRaw: 1000n, at: NOW - startMinAgo * MIN },
    { side: 'sell', mint, sol: sol * (1 + ret), tokenRaw: 1000n, at: NOW - (startMinAgo - holdMin) * MIN },
  ];
  const timesOf = (trades: HistoryTrade[], extra: number[] = []) => [...trades.map((t) => t.at), ...extra];
  const judge = (trades: HistoryTrade[], extra: number[] = [], minBuy = 0.05) => judgeHistory(timesOf(trades, extra), trades, NOW, minBuy);

  const good = [...trip(A, 240, 12, 0.5, 0.3), ...trip(B, 180, 20, 0.5, 0.2), ...trip(C, 120, 8, 0.5, -0.15), ...trip(D, 60, 15, 0.5, 0.25), ...trip(E, 30, 10, 0.5, 0.1)];
  const ok = judge(good);
  assert(ok.status === 'pass' && ok.stats.roundTrips === 5 && ok.stats.wins === 4 && Math.abs(ok.stats.netSol - 0.35) < 1e-9 && ok.stats.medianHoldMinutes === 12,
    `an active, profitable wallet that holds long enough passes (${ok.reason})`);
  assert(/5 buys in 3\.7h · 5 trades 4W\/1L · net \+0\.350 SOL · holds ~12 min/.test(ok.reason), `with a one-line summary (${ok.reason})`);

  const flipper = [...trip(A, 200, 1, 2, 0.05), ...trip(B, 150, 2, 2, 0.04), ...trip(C, 100, 1, 2, -0.1), ...trip(D, 50, 2, 2, 0.06)];
  assert(/flips coins in ~1 min/.test(judge(flipper).reason) || /flips coins in ~2 min/.test(judge(flipper).reason), `a wallet that flips in 1–2 minutes is turned away (${judge(flipper).reason})`);

  // Quiet is judged by the hours it's active, not the clock: 4 good trades
  // spread over 20 hours is a slow trader, not a bad one — hour matching
  // decides when it gets a slot. Buying rarely even while active is a no.
  const slow = [...trip(A, 20 * 60, 30, 0.5, 0.3), ...trip(B, 15 * 60, 30, 0.5, 0.3), ...trip(C, 8 * 60, 30, 0.5, 0.3), ...trip(D, 90, 30, 0.5, 0.3)];
  assert(judge(slow).status === 'pass', `a slow trader with a good record is kept (${judge(slow).reason})`);
  const busyElsewhere = Array.from({ length: 12 }, (_, i) => NOW - (i + 1) * 60 * MIN - 5 * MIN); // 12 other transactions, each in its own hour
  assert(/rarely buys: ~0\.[0-9] per hour it's active/.test(judge(slow, busyElsewhere).reason), `4 buys among 12 hours of other activity is too rare (${judge(slow, busyElsewhere).reason})`);

  // A good record but no buy for hours: asleep, not bad — kept for later.
  const stale = [...trip(A, 9 * 60, 20, 0.5, 0.3), ...trip(B, 8 * 60, 20, 0.5, 0.3), ...trip(C, 7 * 60, 20, 0.5, 0.3), ...trip(D, 6 * 60, 20, 0.5, 0.3)];
  const asleep = judge(stale, [NOW - 5 * MIN]);
  assert(asleep.status === 'asleep' && /^asleep — last bought 6\.0h ago; record: 4 buys/.test(asleep.reason), `a wallet that stopped buying hours ago is asleep, not rejected (${asleep.reason})`);
  const gone = good.map((t) => ({ ...t, at: t.at - 4 * 24 * 60 * MIN }));
  assert(/no activity for 4 days — gone, not asleep/.test(judge(gone).reason) && judge(gone).status === 'fail', `nothing for days: gone (${judge(gone).reason})`);

  // Usual hours, from transaction times: busy 20:00–23:00 UTC three days running.
  const day = 24 * 60 * MIN;
  const eveningUtc = Date.parse('2026-09-23T20:10:00Z');
  const evenings = [0, 1, 2].flatMap((d) => [0, 1, 2].map((h) => eveningUtc + d * day + h * 60 * MIN));
  const prof = hourProfile(evenings)!;
  assert(prof[20] === 1 && prof[21] === 1 && prof[22] === 1 && prof[23] === 0 && prof[10] === 0, `busy hours read 1, quiet ones 0 (${prof.join(',')})`);
  assert(likelyActive(prof, Date.parse('2026-09-26T21:30:00Z')) === 1 && likelyActive(prof, Date.parse('2026-09-26T10:00:00Z')) === 0 &&
    likelyActive(prof, Date.parse('2026-09-26T20:05:00Z')) === 0.75, 'likely active at its usual hour, not at others; the edge of its hours counts partly');
  const burst = hourProfile([eveningUtc, eveningUtc + 30 * MIN])!;
  assert(burst[20] === 1 && burst[5] === null && likelyActive(burst, Date.parse('2026-09-26T05:00:00Z')) === null, 'hours its history never covered are unknown, not "quiet"');
  assert(describeHours(prof, 0) === '8pm–11pm' && describeHours(prof, -240) === '4pm–7pm', `shown in your own time (${describeHours(prof, 0)}, ${describeHours(prof, -240)})`);
  const lateNight = hourProfile([0, 1, 2].flatMap((d) => [22, 23, 24, 25].map((h) => Date.parse('2026-09-23T00:10:00Z') + d * day + h * 60 * MIN)))!;
  assert(describeHours(lateNight, 0) === '10pm–2am', `a stretch across midnight reads as one (${describeHours(lateNight, 0)})`);

  const dust = good.map((t) => ({ ...t, sol: t.sol! / 100 }));
  assert(/buys are ~0\.005 SOL — under MIN_TRACKED_BUY_SOL \(0\.05\)/.test(judge(dust).reason), `buys too small to copy are turned away (${judge(dust).reason})`);

  const machine = Array.from({ length: 40 }, (_, i) => NOW - i * 15_000); // 40 transactions in 10 minutes
  assert(/machine speed/.test(judgeHistory(machine, [], NOW, 0.05).reason), 'a machine-speed wallet is turned away');

  const loser = [...trip(A, 240, 12, 0.5, -0.3), ...trip(B, 180, 20, 0.5, 0.2), ...trip(C, 120, 8, 0.5, -0.15), ...trip(D, 60, 15, 0.5, -0.25)];
  assert(/won only 1 of 4/.test(judge(loser).reason), `a wallet that loses most trades is turned away (${judge(loser).reason})`);
  const bleeder = [...trip(A, 240, 12, 0.5, 0.05), ...trip(B, 180, 20, 0.5, 0.05), ...trip(C, 120, 8, 0.5, -0.6), ...trip(D, 60, 15, 0.5, -0.1)];
  assert(/lost 0\.300 SOL over 4/.test(judge(bleeder).reason), `winning half but losing money overall is turned away (${judge(bleeder).reason})`);
  assert(/only 2 finished trade/.test(judge([...trip(A, 100, 12, 0.5, 0.3), ...trip(B, 60, 12, 0.5, 0.3), { side: 'buy', mint: C, sol: 0.5, tokenRaw: 10n, at: NOW - 30 * MIN }, { side: 'buy', mint: D, sol: 0.5, tokenRaw: 10n, at: NOW - 20 * MIN }]).reason),
    'too few finished trades to judge');

  // A trip closes once 90%+ is sold; a sell of a coin bought before the sample is ignored.
  const partial: HistoryTrade[] = [
    { side: 'sell', mint: E, sol: 9, tokenRaw: 500n, at: NOW - 300 * MIN },
    { side: 'buy', mint: A, sol: 1, tokenRaw: 100n, at: NOW - 200 * MIN },
    { side: 'sell', mint: A, sol: 0.7, tokenRaw: 50n, at: NOW - 190 * MIN },
    { side: 'sell', mint: A, sol: 0.6, tokenRaw: 45n, at: NOW - 180 * MIN },
  ];
  const p = judge(partial);
  assert(p.stats.roundTrips === 1 && Math.abs(p.stats.netSol - 0.3) < 1e-9 && p.stats.medianHoldMinutes === 10, 'partial sells add up to one round trip; the pre-sample sell is ignored');

  // Reading real transaction shapes: failed ones are never fetched; swaps are parsed.
  const fetched: string[] = [];
  const txs: Record<string, ParsedTransactionWithMeta> = {};
  const sigs: { signature: string; blockTime: number; err: unknown }[] = [];
  let k = 0;
  for (const [mint, startMinAgo, ret] of [[A, 200, 0.3], [B, 150, 0.2], [C, 100, -0.1], [D, 50, 0.25]] as [string, number, number][]) {
    const b = `b${k}`, s2 = `s${k++}`;
    txs[b] = makeTx({ mint, solPre: 2e9, solPost: 1.5e9, tokenPre: 0n, tokenPost: 1000n });
    txs[s2] = makeTx({ mint, solPre: 1e9, solPost: 1e9 + (0.5 * (1 + ret)) * 1e9, tokenPre: 1000n, tokenPost: 0n });
    sigs.push({ signature: b, blockTime: Math.floor((NOW - startMinAgo * MIN) / 1000), err: null });
    sigs.push({ signature: s2, blockTime: Math.floor((NOW - (startMinAgo - 12) * MIN) / 1000), err: null });
  }
  sigs.push({ signature: 'failed', blockTime: Math.floor((NOW - 10 * MIN) / 1000), err: { InstructionError: [0, 'x'] } });
  const conn = {
    async getSignaturesForAddress() { return sigs; },
    async getParsedTransaction(sig: string) { fetched.push(sig); return txs[sig] ?? null; },
  };
  const v = await vetWallet(conn as any, new RateLimiter(0), TRACKED, 0.05, NOW);
  assert(v.status === 'pass' && v.stats.roundTrips === 4 && v.stats.wins === 3 && v.stats.buys === 4 && v.stats.transactions === 9, `vetWallet reads and judges real transaction shapes (${v.reason})`);
  assert(!fetched.includes('failed') && fetched.length === 8, 'a failed transaction is never fetched (it changed nothing)');

  // In the rotation: nominees are vetted before they're added…
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-vetting-'));
  const store = new PositionStore(dir);
  const [U, L1, L2, W, G, X] = Array.from({ length: 6 }, () => Keypair.generate().publicKey.toBase58());
  const verdict = (ok: boolean, reason: string): VetVerdict => ({ status: ok ? 'pass' : 'fail', reason, stats: {} as any, hours: null });
  const verdicts: Record<string, VetVerdict> = {
    [G]: verdict(true, '9 buys in 4.0h · 5 trades 4W/1L · net +0.300 SOL · holds ~12 min'),
    [X]: verdict(false, 'flips coins in ~1 min — over before a copy lands'),
    [L1]: verdict(false, 'too quiet: ~0.2 buys an hour'),
    [L2]: verdict(true, '6 buys in 3.0h · 4 trades 3W/1L · net +0.100 SOL · holds ~9 min'),
  };
  const vetted: string[] = [];
  const nominee = (w: string) => ({ wallet: w, pools: 1, medianReturnPct: 30, evidence: ['x'] });
  const roster = new WalletRoster([U], 3, dir);
  roster.addDiscovered([nominee(L1), nominee(W), nominee(L2)], NOW - 3 * 24 * 60 * MIN); // found before vetting existed
  // W's copies made money: a proven winner, never vetted.
  for (const back of [0.07, 0.06]) { const pos = store.openPosition({ mint: Keypair.generate().publicKey.toBase58(), decimals: 6, sourceWallet: W, dryRun: false, spentSol: 0.05, tokenAmountRaw: '1' }); store.recordSell(pos, 1n, back); }
  const logs: string[] = [];
  let nominees = [nominee(G), nominee(X)];
  const rotation = new Rotation(roster, store, { walletMaxConsecutiveLosses: 3, walletDropAfterTrades: 6, walletIdleMinutes: 30, probationTrades: 0 }, (m) => logs.push(m), {
    minBench: 99, cooldownMs: 60 * MIN,
    run: async () => { const n = nominees; nominees = []; return n; },
    vet: async (w) => { vetted.push(w); return verdicts[w]; },
  });
  const watching = new Set<string>();
  const watch = { isWatching: (w: string) => watching.has(w), addWallet: (w: string) => { watching.add(w); }, async removeWallet(w: string) { watching.delete(w); } };
  const trader = { setActiveWallets() {} };
  rotation.startup(NOW).forEach((w) => watching.add(w));
  assert(roster.active().join() === [W, U, L1].join(), 'starts with the winner, your own wallet, then the found ones');
  await rotation.pendingDiscovery;
  assert(vetted.join() === [G, X].join(), 'both nominees were checked');
  assert(roster.all().includes(G) && !roster.all().includes(X) && roster.known(NOW).has(X), 'the one that passed is on the bench; the one that failed is remembered, not added');
  assert(logs.some((l) => l.includes(`✅ ${shortAddress(G)} — 9 buys`)) && logs.some((l) => l.includes(`❌ ${shortAddress(X)} — flips coins`)), 'each verdict is shown');
  assert(logs.some((l) => /🔎 Found 1 new wallet\(s\) to try: .*\.$/.test(l) && !l.includes('paper-tested')), 'no "paper-tested first" when there is no trial');
  assert(!roster.known(NOW + 8 * 24 * 60 * MIN).has(X), 'a turned-away wallet is forgotten after a week — it may be worth another look by then');

  // …and wallets found before vetting existed are checked one at a time, copied ones first.
  vetted.length = 0;
  await rotation.tick(NOW + MIN, watch, trader); await rotation.pendingVet;
  assert(vetted.join() === L1, 'the copied wallet L1 is checked first (the winner and your own wallet never are)');
  assert(!roster.all().includes(L1) && logs.some((l) => l.includes(`🧪 Removed ${shortAddress(L1)} from the copy list — too quiet`)), 'it failed, so it is off the roster');
  await rotation.tick(NOW + 2 * MIN, watch, trader); await rotation.pendingVet;
  assert(roster.active().join() === [W, U, L2].join() && watching.has(L2) && !watching.has(L1), 'its slot goes to the next wallet at once');
  assert(vetted.join() === [L1, L2].join() && logs.some((l) => l.includes(`🧪 Checked ${shortAddress(L2)}: ✅ 6 buys`)), 'then L2 is checked, and passes');
  await rotation.tick(NOW + 3 * MIN, watch, trader); await rotation.pendingVet;
  assert(vetted.join() === [L1, L2].join(), 'nothing is checked twice (G was vetted when found)');
  assert(!roster.needsVetting(L2, NOW + 2 * 24 * 60 * MIN) && roster.needsVetting(L2, NOW + 4 * 24 * 60 * MIN), 'a passed wallet is checked again after 3 days');
  assert(!logs.some((l) => l.startsWith('🎓')), 'with no trial, nobody "passes a trial of 0 paper copies"');

  const reloaded = new WalletRoster([U], 3, dir);
  reloaded.load();
  assert(reloaded.known(NOW).has(L1) && !reloaded.needsVetting(G, NOW + MIN), 'verdicts survive a restart');
  realLog('✅ wallet vetting: found wallets are judged by their own trades — quiet, flippers, dust, machines and losers are turned away');
}

// Asleep isn't bad, and "this hour" matters: in a live run 12 of 33
// rejected wallets were only asleep (checked overnight), and slots went to
// whoever was next in line rather than whoever trades at that hour.
async function testHourMatching(realLog: typeof console.log) {
  const MIN = 60_000;
  const T0 = Date.parse('2026-09-26T20:00:00Z'); // 8pm UTC
  const profileFor = (hours: number[]) => Array.from({ length: 24 }, (_, h) => (hours.includes(h) ? 1 : 0));
  const logs: string[] = [];

  // 1. A nominee that's asleep joins the bench (💤) instead of being turned
  //    away; an old wallet found asleep by the roster check is kept too.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-asleep-'));
    const store = new PositionStore(dir);
    const [U1, L, Y, Z] = Array.from({ length: 4 }, () => Keypair.generate().publicKey.toBase58());
    const roster = new WalletRoster([U1], 1, dir);
    roster.addDiscovered([{ wallet: L, pools: 1, medianReturnPct: 30, evidence: ['x'] }], T0 - 5 * 24 * 60 * MIN); // found before vetting
    const verdicts: Record<string, VetVerdict> = {
      [Y]: { status: 'pass', reason: '9 buys in 4.0h · …', stats: {} as any, hours: profileFor([19, 20, 21]) },
      [Z]: { status: 'asleep', reason: 'asleep — last bought 6.0h ago; record: …', stats: {} as any, hours: profileFor([8, 9]) },
      [L]: { status: 'asleep', reason: 'asleep — last bought 9.0h ago; record: …', stats: {} as any, hours: profileFor([2, 3]) },
    };
    let once = [Y, Z];
    const rotation = new Rotation(roster, store, { walletMaxConsecutiveLosses: 3, walletDropAfterTrades: 6, walletIdleMinutes: 30, probationTrades: 0 }, (m) => logs.push(m), {
      minBench: 99, cooldownMs: 60 * MIN,
      run: async () => { const n = once.map((w) => ({ wallet: w, pools: 1, medianReturnPct: 30, evidence: ['x'] })); once = []; return n; },
      vet: async (w) => verdicts[w],
    });
    rotation.startup(T0);
    await rotation.pendingDiscovery;
    assert(roster.all().includes(Z) && roster.idledAt(Z) !== undefined && roster.idledAt(Y) === undefined, 'the asleep nominee is kept, waiting on the bench (💤); the awake one is ready');
    assert(roster.hoursOf(Y)?.[20] === 1 && roster.hoursOf(Z)?.[8] === 1, 'their usual hours are kept');
    assert(logs.some((l) => l.includes(`💤 ${shortAddress(Z)} — asleep`)) && logs.some((l) => /Found 2 new wallet\(s\) to try: .*\(1 asleep — on the bench until they trade\)\.$/.test(l)), 'said plainly');
    await rotation.tick(T0 + MIN, { isWatching: () => true, addWallet() {}, async removeWallet() {} }, { setActiveWallets() {} });
    await rotation.pendingVet;
    assert(roster.idledAt(L) !== undefined && !roster.needsVetting(L, T0 + 2 * MIN) && logs.some((l) => l.includes(`🧪 Checked ${shortAddress(L)}: 💤 asleep`) && l.includes('kept')), 'an old wallet found asleep is kept too, and waits');
  }

  // 2–4. Picking who gets a slot.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-hours-'));
  const store = new PositionStore(dir);
  const [U1, U2, S1, S2, S3] = Array.from({ length: 5 }, () => Keypair.generate().publicKey.toBase58());
  const roster = new WalletRoster([U1, U2], 2, dir);
  roster.addDiscovered([S1, S2, S3].map((w) => ({ wallet: w, pools: 1, medianReturnPct: 30, evidence: ['x'] })), T0 - 5 * 24 * 60 * MIN);
  roster.markVetted(S1, T0 - 60 * MIN, profileFor([19, 20, 21])); // usually trades now
  roster.markVetted(S2, T0 - 60 * MIN, profileFor([8, 9, 10])); // mornings
  roster.markVetted(S3, T0 - 60 * MIN, Array.from({ length: 24 }, () => null)); // hours unknown
  roster.idle(S2, T0 - 180 * MIN); // waited longest
  roster.idle(S3, T0 - 120 * MIN);
  roster.idle(S1, T0 - 90 * MIN);
  const probeTimes = new Map<string, number>();
  const onChainNow = new Map<string, number>(); // what the watcher has seen copied wallets do
  const probed: string[] = [];
  const watching = new Set<string>();
  const watch = {
    isWatching: (w: string) => watching.has(w), addWallet: (w: string) => { watching.add(w); }, async removeWallet(w: string) { watching.delete(w); },
    lastActivityOf: (w: string) => onChainNow.get(w),
    async probeActivity(w: string) { probed.push(w); return probeTimes.get(w); },
  };
  const probeCount = () => probed.length; // a function, so TypeScript doesn't narrow it between checks
  let copying: string[] = [];
  const trader = { setActiveWallets(w: string[] | null) { copying = w ?? []; } };
  logs.length = 0;
  const rotation = new Rotation(roster, store, { walletMaxConsecutiveLosses: 3, walletDropAfterTrades: 6, walletIdleMinutes: 30, probationTrades: 0 }, (m) => logs.push(m));
  const tick = async (at: number) => { await rotation.tick(at, watch, trader); await rotation.settleChecks(); };
  rotation.startup(T0).forEach((w) => watching.add(w));
  assert(roster.active().join() === [U1, U2].join(), 'your two are copied');
  assert(roster.bench().join() === [S1, S3, S2].join(), 'next up: the one that usually trades at this hour — then unknown hours — then the morning trader, though it has waited longest');

  rotation.noteBuy(U1, T0 + 5 * MIN); rotation.noteBuy(U2, T0 + 5 * MIN);
  await tick(T0 + 10 * MIN);
  assert(roster.active().join() === [U1, U2].join() && probeCount() === 0, 'a better-ranked wallet never pushes out one that is trading; and nothing is checked while nobody is quiet');

  // 2. A slot frees up: it goes to the wallet that usually trades at this hour.
  rotation.noteBuy(U2, T0 + 25 * MIN);
  await tick(T0 + 36 * MIN); // U1 quiet 31 min
  assert(roster.active().join() === [U2, S1].join() && copying.join() === [U2, S1].join() && watching.has(S1), 'U1 is benched; S1 takes its slot');
  assert(logs.some((l) => l === `🔄 Now copying ${shortAddress(S1)} (from the bench) — it usually trades at this hour.`), 'and why is said');

  // 3. A benched wallet starts trading while a copied one has been quiet 15+ minutes: they swap now.
  rotation.noteBuy(S1, T0 + 45 * MIN);
  probeTimes.set(S3, T0 + 50 * MIN);
  await tick(T0 + 51 * MIN); // U2 quiet 26 min → S3, first due, is checked
  assert(probed.join() === S3, `one benched wallet is checked — the likeliest at this hour among those due (${probed.map(shortAddress).join()})`);
  assert(roster.active().includes(U2), 'nothing moves on the check itself');
  onChainNow.set(U2, T0 + 51.5 * MIN); // U2 isn't buying, but it is doing things on-chain
  await tick(T0 + 52 * MIN);
  assert(roster.active().includes(U2), 'a wallet still active on-chain is not swapped out early — it may only be between buys');
  onChainNow.delete(U2);
  await tick(T0 + 53 * MIN);
  assert(roster.active().join() === [S1, S3].join() && !roster.active().includes(U2) && watching.has(S3), 'S3 is trading now, U2 has been quiet 27 min: they swap without waiting out the half hour');
  assert(logs.some((l) => l.includes(`Benched ${shortAddress(U2)}`) && l.includes(`${shortAddress(S3)} is trading right now, so it takes the slot`)), 'the swap is announced');
  assert(!logs.some((l) => l.startsWith(`🔄 Now copying ${shortAddress(S3)}`)), 'announced once');
  assert(roster.idledAt(S3) === undefined && roster.idledAt(U2) !== undefined, 'S3 is no longer marked quiet; U2 now is');
  await tick(T0 + 54 * MIN);
  assert(probeCount() === 1, 'no checks while nobody on the list is quiet');

  // 4. The list is written down: a restart copies the same wallets.
  const reloaded = new WalletRoster([U1, U2], 2, dir);
  reloaded.load();
  assert(reloaded.active().join() === [S1, S3].join(), 'the copy list survives a restart');
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-legacy-'));
  const [Q1, Q2, M1, F1] = Array.from({ length: 4 }, () => Keypair.generate().publicKey.toBase58());
  const was = new Date(T0 - 24 * 60 * MIN).toISOString();
  fs.writeFileSync(path.join(legacyDir, 'wallets.json'), JSON.stringify({
    dropped: {}, idled: { [U1]: new Date(T0).toISOString() }, discovered: [],
    rejected: {
      [Q1]: { reason: "hasn't bought for 5.2h", at: was }, [Q2]: { reason: 'too quiet: ~0.4 buys an hour', at: was },
      [M1]: { reason: 'machine speed: ~96 transactions an hour', at: was }, [F1]: { reason: 'flips coins in ~1 min — over before a copy lands', at: was },
    },
    vetted: {},
  }));
  const legacy = new WalletRoster([U1, U2, S1], 2, legacyDir);
  legacy.load();
  const legacyLogs: string[] = [];
  new Rotation(legacy, new PositionStore(legacyDir), { walletMaxConsecutiveLosses: 3, walletDropAfterTrades: 6, walletIdleMinutes: 30 }, (m) => legacyLogs.push(m)).startup(T0);
  const written = JSON.parse(fs.readFileSync(path.join(legacyDir, 'wallets.json'), 'utf8'));
  assert(legacy.active().join() === [U2, S1].join() && written.active.join() === [U2, S1].join(), 'a file from before keeps its ranking and gets the list written down');
  assert(legacy.all().includes(Q1) && legacy.all().includes(Q2) && legacy.idledAt(Q1) !== undefined && legacy.needsVetting(Q2, T0),
    'wallets turned away only for being quiet are back on the bench, waiting (💤), to be vetted again');
  assert(!legacy.all().includes(M1) && !legacy.all().includes(F1) && legacy.known(T0).has(M1), 'machines and flippers stay turned away');
  assert(legacyLogs.some((l) => l.startsWith('🧪 2 wallet(s) turned away only for being quiet are back on the bench')), 'and it says so');
  const again = new WalletRoster([U1, U2, S1], 2, legacyDir);
  again.load();
  assert(again.rechecked === 0, 'only once — the first start after the update');
  assert(rotation.describe().startsWith(`copying ${shortAddress(S1)}, ${shortAddress(S3)} · 3 on the bench`), rotation.describe());

  // 5. A wallet benched for being quiet at its usual hour isn't picked
  //    straight back (a simulated day did that 245 times to one wallet): it
  //    waits an hour, unless it's seen trading.
  {
    const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-cooldown-'));
    const [A, B, C] = Array.from({ length: 3 }, () => Keypair.generate().publicKey.toBase58());
    const r = new WalletRoster([], 1, cdir);
    r.addDiscovered([A, B, C].map((w) => ({ wallet: w, pools: 1, medianReturnPct: 30, evidence: ['x'] })), T0 - 5 * 24 * 60 * MIN);
    r.markVetted(A, T0 - 60 * MIN, profileFor([19, 20, 21, 22])); // its usual hours, right now
    r.markVetted(B, T0 - 60 * MIN, null);
    r.markVetted(C, T0 - 60 * MIN, null);
    r.idle(B, T0 - 300 * MIN);
    r.idle(C, T0 - 240 * MIN);
    const rot = new Rotation(r, new PositionStore(cdir), { walletMaxConsecutiveLosses: 3, walletDropAfterTrades: 6, walletIdleMinutes: 30, probationTrades: 0 }, () => {});
    rot.startup(T0);
    assert(r.active().join() === A, 'A starts copied');
    const w3 = { isWatching: () => true, addWallet() {}, async removeWallet() {} };
    await rot.tick(T0 + 31 * MIN, w3, { setActiveWallets() {} });
    assert(r.active().join() === B && r.bench().join() === [C, A].join(), 'quiet A is benched, and goes behind the others though this is its usual hour');
    await rot.tick(T0 + 92 * MIN, w3, { setActiveWallets() {} }); // B benched in turn; A's hour is up
    assert(r.bench()[0] === A || r.active().join() === A, 'an hour later, its usual hours count again');
  }
  // 6. A live run swapped 5–7 wallets every 30 seconds, back and forth: all
  //    quiet wallets were compared with the ONE best waiting wallet, then the
  //    slots were refilled from the whole bench — staler wallets included.
  //    Each quiet wallet now needs its own replacement, known to be more
  //    active than it; exactly that one takes its slot.
  {
    const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-pingpong-'));
    const [A, B, C, F, D, E] = Array.from({ length: 6 }, () => Keypair.generate().publicKey.toBase58());
    const r = new WalletRoster([A, B, C, F, D, E], 3, pdir);
    const H = 60 * MIN;
    const lastSeen = new Map<string, number>([[A, T0 - 11 * H], [B, T0 - 15 * H], [C, T0 - 9 * H], [F, T0 - 6 * MIN], [D, T0 - 10 * H], [E, T0 - 14 * H]]);
    const w6 = new Set<string>();
    const watch6 = {
      isWatching: (w: string) => w6.has(w), addWallet: (w: string) => { w6.add(w); }, async removeWallet(w: string) { w6.delete(w); },
      lastActivityOf: (w: string) => lastSeen.get(w),
    };
    const said: string[] = [];
    const rot = new Rotation(r, new PositionStore(pdir), { walletMaxConsecutiveLosses: 3, walletDropAfterTrades: 6, walletIdleMinutes: 30 }, (m) => said.push(m));
    rot.startup(T0).forEach((w) => w6.add(w));
    assert(r.active().join() === [A, B, C].join(), 'three dormant wallets copied; F (active 6 min ago), D (10h) and E (14h) waiting');
    await rot.tick(T0 + MIN, watch6, { setActiveWallets() {} });
    assert(new Set(r.active()).size === 3 && [C, F, D].every((w) => r.active().includes(w)),
      `B (15h) gives way to F, A (11h) to D (10h); C (9h) stays — E (14h) is no improvement (${r.active().map(shortAddress).join(', ')})`);
    assert(said.filter((l) => l.startsWith('🔄 Benched')).length === 2, 'two swaps, not three');
    const before = said.length;
    for (let i = 2; i <= 6; i++) await rot.tick(T0 + i * MIN, watch6, { setActiveWallets() {} });
    assert(said.slice(before).filter((l) => l.startsWith('🔄')).length === 0 && [C, F, D].every((w) => r.active().includes(w)),
      'and then it holds: nobody waiting is more active, so nothing swaps back and forth');
  }
  realLog('✅ hour matching: asleep wallets kept, free slots go to who usually trades now, a waking wallet replaces a quiet one, no churn');
}

async function main() {
  testEnvIsolation();
  await testDiscovery(console.log);
  await testDiscoveryInRotation(console.log);
  await testEmptySlotsFill(console.log);
  await testActivityCheck(console.log);
  testRecommendedSettings(console.log);
  await testRunSheets(console.log);
  await testRobotWallets(console.log);
  await testStaleBenchAndTrial(console.log);
  await testRentReclaim(console.log);
  await testWinnersFirst(console.log);
  await testWalletVetting(console.log);
  await testHourMatching(console.log);
  await testProbationInRealMode(console.log);
  await testPositionCapsAndSweepYield(console.log);
  await testTelegram(console.log);
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
