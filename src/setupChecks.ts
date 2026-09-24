// Pure helpers behind `npm run setup` and `npm run doctor`: everything that
// validates or renders configuration, kept free of prompts and network so it
// can be tested offline. The checks encode the mistakes that actually happened
// on first installs: a public ADDRESS pasted instead of the private key, a
// recovery phrase with a word wrong, a placeholder left in .env, the example
// file copied over a finished one.

import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import * as bip39 from 'bip39';
import dotenv from 'dotenv';

export type WalletSecretKind =
  | { kind: 'key' }
  | { kind: 'mnemonic'; words: number }
  | { kind: 'invalid'; reason: string };

// Phantom exports a 64-byte secret key as base58; a recovery phrase is 12 or
// 24 words. Says exactly what was pasted when it's the wrong thing.
export function classifyWalletSecret(input: string): WalletSecretKind {
  const text = input.trim();
  if (!text) return { kind: 'invalid', reason: 'nothing was entered' };

  const words = text.toLowerCase().split(/\s+/);
  if (words.length > 1) {
    if (![12, 15, 18, 21, 24].includes(words.length)) {
      return {
        kind: 'invalid',
        reason: `${words.length} words — a recovery phrase has 12 or 24 (paste all of them on one line, separated by spaces)`,
      };
    }
    if (!bip39.validateMnemonic(words.join(' '))) {
      return { kind: 'invalid', reason: 'not a valid recovery phrase — a word is misspelled, missing, or out of order' };
    }
    return { kind: 'mnemonic', words: words.length };
  }

  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(text);
  } catch {
    return { kind: 'invalid', reason: 'not a private key (base58) and not a 12/24-word phrase' };
  }
  if (bytes.length === 64) return { kind: 'key' };
  if (bytes.length === 32) {
    return {
      kind: 'invalid',
      reason: 'that is a public ADDRESS (32 bytes), not the private key — in Phantom use "Show Private Key"',
    };
  }
  return { kind: 'invalid', reason: `decodes to ${bytes.length} bytes; a private key is 64` };
}

// Accepts the bare Helius API key, or either full URL from the dashboard, and
// returns both endpoints the bot needs.
export function parseHeliusInput(input: string): { https: string; wss: string } | null {
  const text = input.trim();
  const fromUrl = /api-key=([A-Za-z0-9-]+)/.exec(text);
  const key = fromUrl ? fromUrl[1] : /^[A-Za-z0-9-]{16,}$/.test(text) ? text : null;
  if (!key) return null;
  return {
    https: `https://mainnet.helius-rpc.com/?api-key=${key}`,
    wss: `wss://mainnet.helius-rpc.com/?api-key=${key}`,
  };
}

// Addresses separated by commas, spaces or new lines; duplicates dropped.
export function parseWalletList(input: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const piece of input.split(/[\s,;]+/)) {
    if (!piece) continue;
    try {
      const address = new PublicKey(piece).toBase58();
      if (!valid.includes(address)) valid.push(address);
    } catch {
      invalid.push(piece);
    }
  }
  return { valid, invalid };
}

const PLACEHOLDER_MARKERS = ['YOUR_KEY_HERE', 'WalletAddress1', 'WalletAddress2'];
const REQUIRED_KEYS = ['HELIUS_HTTPS_URL', 'HELIUS_WSS_URL', 'JUPITER_API_KEY', 'TRACKED_WALLETS'];

// Names of settings still empty or left at the example file's placeholder text.
export function findPlaceholders(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  if (!(env.PRIVATE_KEY_BASE58 ?? '').trim() && !(env.WALLET_MNEMONIC ?? '').trim()) {
    problems.push('PRIVATE_KEY_BASE58 or WALLET_MNEMONIC');
  }
  for (const key of REQUIRED_KEYS) {
    const value = (env[key] ?? '').trim();
    if (!value || PLACEHOLDER_MARKERS.some((marker) => value.includes(marker))) problems.push(key);
  }
  return problems;
}

// A Telegram bot token as @BotFather hands it out: "123456789:AAH…".
export function isTelegramToken(input: string): boolean {
  return /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(input.trim());
}

// Sets KEY=value lines in an existing .env text, leaving every other line —
// comments, order, Windows line endings — exactly as it was. Keys not
// present yet are appended at the end, under `heading` if given.
export function upsertEnv(text: string, updates: Record<string, string>, heading?: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let out = text;
  const missing: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    if (pattern.test(out)) out = out.replace(pattern, () => `${key}=${value}`);
    else missing.push(`${key}=${value}`);
  }
  if (missing.length > 0) {
    if (out.length > 0 && !out.endsWith('\n')) out += eol;
    out += [...(heading ? ['', heading] : []), ...missing, ''].join(eol);
  }
  return out;
}

// The settings that keep the bot busy enough to judge: the wallet scanner on,
// 6 wallets at a time (the most the free Helius plan follows reliably), quiet
// ones swapped after 30 minutes, and no token check (the wallets worth
// copying mostly buy coins younger than 30 minutes, so the check skipped
// nearly every copy). Money settings — DRY_RUN, buy size, position caps — are
// never touched here.
export const RECOMMENDED_SETTINGS: Record<string, { value: string; why: string }> = {
  DISCOVERY: { value: 'true', why: 'wallet scanner on — finds wallets that are trading now and swaps out quiet ones' },
  ACTIVE_WALLETS: { value: '6', why: 'copies 6 wallets at a time (the most the free Helius plan follows reliably)' },
  WALLET_IDLE_MINUTES: { value: '30', why: 'swaps out a wallet that has gone 30 minutes without buying, instead of 90' },
  MIN_TOKEN_AGE_MINUTES: { value: '0', why: 'copies new coins too (the token check skipped almost every copy)' },
  MIN_LIQUIDITY_USD: { value: '0', why: 'copies smaller coins too' },
};

export interface SettingChange {
  key: string;
  from: string | null; // null = wasn't in .env
  to: string;
  why: string;
}

// Pure: .env text with the recommended settings applied, and what changed.
// A higher ACTIVE_WALLETS or a shorter WALLET_IDLE_MINUTES you chose yourself
// is kept.
export function applyRecommended(text: string): { text: string; changes: SettingChange[] } {
  const current = dotenv.parse(text);
  const updates: Record<string, string> = {};
  const changes: SettingChange[] = [];
  for (const [key, { value, why }] of Object.entries(RECOMMENDED_SETTINGS)) {
    const from = current[key] !== undefined ? current[key].trim() : null;
    if (from === value) continue;
    if (key === 'ACTIVE_WALLETS' && from !== null && Number(from) >= Number(value)) continue;
    if (key === 'WALLET_IDLE_MINUTES' && from !== null && Number(from) > 0 && Number(from) <= Number(value)) continue;
    updates[key] = value;
    changes.push({ key, from, to: value, why });
  }
  if (changes.length === 0) return { text, changes };
  return { text: upsertEnv(text, updates, '# ---- Added by: npm run recommended ----'), changes };
}

// Pure: the warning for the most confusing setup of all — SOL in the wallet,
// but paper mode on, so nothing will ever show up in Phantom. Null when it
// doesn't apply.
export function paperModeWithFundsHint(dryRun: boolean, balanceSol: number, buySol: number, reserveSol: number): string | null {
  if (!dryRun || balanceSol < buySol + reserveSol) return null;
  return (
    `This wallet holds ${balanceSol.toFixed(4)} SOL, but DRY_RUN=true: every trade is paper and nothing ever ` +
    'reaches Phantom. To trade real money, set DRY_RUN=false in .env.'
  );
}

export function maskSecret(value: string): string {
  const text = value.trim();
  return text.length <= 4 ? '••••' : `••••${text.slice(-4)}`;
}

// Every tunable with its default, in the order .env is written.
export const ENV_DEFAULTS: Record<string, string> = {
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
  STOP_LOSS_PERCENT: '30',
  TRAILING_STOP_PERCENT: '30',
  TAKE_PROFIT_PERCENT: '0',
  EXIT_CHECK_SECONDS: '30',
  EXIT_REBUY_COOLDOWN_HOURS: '24',
  RPC_REQUESTS_PER_SECOND: '8',
  NOTIFICATIONS: 'true',
  SOUNDS: 'true',
  SOUND_BUY: 'Glass',
  SOUND_SELL: 'Hero',
  SOUND_FAIL: 'Basso',
  SPEECH: 'true',
  SPEECH_BUY: 'Order filled',
  SPEECH_SELL: 'Order sold',
  SPEECH_FAIL: 'Sell failed. Position stuck.',
  SPEECH_VOICE: '',
  SPEECH_RATE: '',
  SUMMARY_INTERVAL_SECONDS: '30',
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_CHAT_ID: '',
  TELEGRAM_REPORT_HOURS: '3',
  TELEGRAM_TRADE_ALERTS: 'sells',
};

export interface EnvValues {
  privateKeyBase58: string;
  walletMnemonic: string;
  heliusHttpsUrl: string;
  heliusWssUrl: string;
  jupiterApiKey: string;
  trackedWallets: string[];
  settings: Record<string, string>; // tunables; anything missing takes ENV_DEFAULTS
}

export function renderEnv(v: EnvValues): string {
  const s = { ...ENV_DEFAULTS, ...v.settings };
  const line = (key: string) => `${key}=${s[key]}`;
  return [
    '# Written by `npm run setup`. Change a setting with: open -e .env  (save with Cmd+S).',
    '# To change the wallet or a key, run `npm run setup` again.',
    '# This file holds your private key. It is gitignored — never share or screenshot it.',
    '',
    '# ---- Wallet (exactly one of the two is filled in) ----',
    `PRIVATE_KEY_BASE58=${v.privateKeyBase58}`,
    `WALLET_MNEMONIC=${v.walletMnemonic}`,
    '',
    '# ---- Helius RPC ----',
    `HELIUS_HTTPS_URL=${v.heliusHttpsUrl}`,
    `HELIUS_WSS_URL=${v.heliusWssUrl}`,
    '',
    '# ---- Jupiter (free tier = 1 request/second; one key per bot) ----',
    `JUPITER_API_KEY=${v.jupiterApiKey}`,
    '',
    '# ---- Wallets to copy (comma-separated) ----',
    `TRACKED_WALLETS=${v.trackedWallets.join(',')}`,
    '',
    '# ---- Safety: paper trading until YOU set this to false ----',
    line('DRY_RUN'),
    '',
    '# ---- Sizing and caps ----',
    line('COPY_BUY_AMOUNT_SOL'),
    line('MAX_OPEN_POSITIONS'),
    line('PAPER_MAX_OPEN_POSITIONS'),
    line('MIN_TRACKED_BUY_SOL'),
    line('MIN_SOL_RESERVE'),
    line('SLIPPAGE_BPS'),
    '',
    '# ---- Quality gates (README: "What it refuses to copy") ----',
    line('MIN_TOKEN_AGE_MINUTES'),
    line('MIN_LIQUIDITY_USD'),
    line('WALLET_MAX_CONSECUTIVE_LOSSES'),
    line('WALLET_MUTE_HOURS'),
    line('MAX_TRACKED_WALLETS'),
    '',
    '# ---- Wallet rotation (README: "Wallet rotation") — on when BENCH_WALLETS is set ----',
    line('BENCH_WALLETS'),
    line('ACTIVE_WALLETS'),
    line('WALLET_DROP_AFTER_TRADES'),
    line('WALLET_IDLE_MINUTES'),
    line('WALLET_MAX_TX_PER_10MIN'),
    line('DISCOVERY'),
    line('PROBATION_TRADES'),
    '',
    "# ---- Exits on your own terms (README: \"Exiting without them\") ----",
    line('STOP_LOSS_PERCENT'),
    line('TRAILING_STOP_PERCENT'),
    line('TAKE_PROFIT_PERCENT'),
    line('EXIT_CHECK_SECONDS'),
    line('EXIT_REBUY_COOLDOWN_HOURS'),
    '',
    '# ---- Pace, alerts, reporting ----',
    line('RPC_REQUESTS_PER_SECOND'),
    line('NOTIFICATIONS'),
    line('SOUNDS'),
    line('SOUND_BUY'),
    line('SOUND_SELL'),
    line('SOUND_FAIL'),
    line('SPEECH'),
    line('SPEECH_BUY'),
    line('SPEECH_SELL'),
    line('SPEECH_FAIL'),
    line('SPEECH_VOICE'),
    line('SPEECH_RATE'),
    line('SUMMARY_INTERVAL_SECONDS'),
    '',
    '# ---- Reports on your phone (README: "Telegram") — set up with: npm run telegram ----',
    line('TELEGRAM_BOT_TOKEN'),
    line('TELEGRAM_CHAT_ID'),
    line('TELEGRAM_REPORT_HOURS'),
    line('TELEGRAM_TRADE_ALERTS'),
    '',
  ].join('\n');
}
