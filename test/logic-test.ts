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

import { analyzeSwap } from '../src/watcher';
import { RateLimiter } from '../src/rateLimiter';
import { PositionStore } from '../src/positions';
import { Trader } from '../src/trader';
import { loadConfig, SOL_MINT } from '../src/config';
import { JupiterOrder, OrderParams } from '../src/jupiter';
import { printSummary } from '../src/pnl';
import { getSolPriceUsd } from '../src/solPrice';

const TRACKED = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
const MEME_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // BONK mint (any valid pubkey works)

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

  const trader = new Trader(config, fakeConnection as any, keypair, fakeJupiter as any, store);

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
  const realTrader = new Trader({ ...config, dryRun: false }, fakeConnection as any, keypair, fakeJupiter as any, realStore);
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

async function main() {
  await testAnalyzeSwap();
  await testRateLimiter();
  await testTrader();
  await testSummary();
  console.log('\nAll logic tests passed.');
}

main().catch((e) => { console.error('❌ TEST FAILED:', e.message); process.exit(1); });
