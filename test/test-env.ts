// Pins EVERY setting the bot reads, BEFORE src/config.ts pulls in dotenv.
//
// This file must be the FIRST import in the test suite. Imports are hoisted,
// so `process.env.X = …` written between import statements runs too late:
// src/config.ts has already run `import 'dotenv/config'` by then and loaded
// the real .env, and whatever the person running the tests happens to have
// configured leaks in. That is not hypothetical — a live .env with
// COPY_BUY_AMOUNT_SOL=0.05 made the exit tests fail on a machine where the
// code was perfectly fine, which is the worst kind of test failure: it blames
// the code for the environment.
//
// dotenv never overwrites a variable that is already set, so setting them all
// here means the suite reads identically on every machine, with or without a
// .env present.

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export const TEST_WALLET = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';

// Every variable loadConfig() and notify() read. Keep this list complete: a
// setting missing here is a setting the person's own .env still controls.
const TEST_ENV: Record<string, string> = {
  // A throwaway key generated per run, so no private key is ever committed and
  // the tests cannot touch a funded wallet.
  PRIVATE_KEY_BASE58: bs58.encode(Keypair.generate().secretKey),
  WALLET_MNEMONIC: '',
  HELIUS_HTTPS_URL: 'https://example.com',
  HELIUS_WSS_URL: 'wss://example.com',
  JUPITER_API_KEY: 'test',
  TRACKED_WALLETS: TEST_WALLET,
  DRY_RUN: 'true',
  COPY_BUY_AMOUNT_SOL: '0.01',
  MAX_OPEN_POSITIONS: '3',
  PAPER_MAX_OPEN_POSITIONS: '10',
  MIN_TRACKED_BUY_SOL: '0.05',
  MIN_SOL_RESERVE: '0.05',
  SLIPPAGE_BPS: '300',
  MIN_TOKEN_AGE_MINUTES: '30',
  MIN_LIQUIDITY_USD: '20000',
  WALLET_MAX_CONSECUTIVE_LOSSES: '3',
  WALLET_MUTE_HOURS: '24',
  MAX_TRACKED_WALLETS: '6',
  BENCH_WALLETS: '',
  ACTIVE_WALLETS: '4',
  WALLET_DROP_AFTER_TRADES: '6',
  WALLET_IDLE_MINUTES: '90',
  WALLET_MAX_TX_PER_10MIN: '150',
  DISCOVERY: 'false',
  PROBATION_TRADES: '6',
  TAKE_PROFIT_PERCENT: '0',
  STOP_LOSS_PERCENT: '30',
  TRAILING_STOP_PERCENT: '30',
  EXIT_CHECK_SECONDS: '30',
  EXIT_REBUY_COOLDOWN_HOURS: '24',
  RPC_REQUESTS_PER_SECOND: '8',
  SUMMARY_INTERVAL_SECONDS: '30',
  // Empty: the tests must never message anyone's real Telegram.
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_CHAT_ID: '',
  TELEGRAM_REPORT_HOURS: '3',
  TELEGRAM_TRADE_ALERTS: 'sells',
  // Running the tests must never make the machine ding or talk.
  NOTIFICATIONS: 'false',
  SOUNDS: 'false',
  SPEECH: 'false',
};

for (const [key, value] of Object.entries(TEST_ENV)) process.env[key] = value;
