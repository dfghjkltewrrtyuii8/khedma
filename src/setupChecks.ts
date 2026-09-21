// Pure helpers behind `npm run setup` and `npm run doctor`: everything that
// validates or renders configuration, kept free of prompts and network so it
// can be tested offline. The checks encode the mistakes that actually happened
// on first installs: a public ADDRESS pasted instead of the private key, a
// recovery phrase with a word wrong, a placeholder left in .env, the example
// file copied over a finished one.

import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import * as bip39 from 'bip39';

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

export function maskSecret(value: string): string {
  const text = value.trim();
  return text.length <= 4 ? '••••' : `••••${text.slice(-4)}`;
}

// Every tunable with its default, in the order .env is written.
export const ENV_DEFAULTS: Record<string, string> = {
  DRY_RUN: 'true',
  COPY_BUY_AMOUNT_SOL: '0.01',
  MAX_OPEN_POSITIONS: '3',
  MIN_TRACKED_BUY_SOL: '0.05',
  MIN_SOL_RESERVE: '0.05',
  SLIPPAGE_BPS: '300',
  MIN_TOKEN_AGE_MINUTES: '30',
  MIN_LIQUIDITY_USD: '20000',
  WALLET_MAX_CONSECUTIVE_LOSSES: '3',
  WALLET_MUTE_HOURS: '24',
  MAX_TRACKED_WALLETS: '6',
  RPC_REQUESTS_PER_SECOND: '8',
  NOTIFICATIONS: 'true',
  SOUNDS: 'true',
  SOUND_BUY: 'Glass',
  SOUND_SELL: 'Hero',
  SOUND_FAIL: 'Basso',
  SUMMARY_INTERVAL_SECONDS: '30',
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
    '# ---- Pace, alerts, reporting ----',
    line('RPC_REQUESTS_PER_SECOND'),
    line('NOTIFICATIONS'),
    line('SOUNDS'),
    line('SOUND_BUY'),
    line('SOUND_SELL'),
    line('SOUND_FAIL'),
    line('SUMMARY_INTERVAL_SECONDS'),
    '',
  ].join('\n');
}
