import 'dotenv/config';
import { PublicKey } from '@solana/web3.js';

// Well-known mint addresses. These are the "quote" side of trades:
// when a tracked wallet trades one of these for some other token, that
// other token is what we consider bought/sold.
export const SOL_MINT = 'So11111111111111111111111111111111111111112'; // wrapped SOL
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);

export interface Config {
  privateKeyBase58: string | null;
  walletMnemonic: string | null;
  heliusHttpsUrl: string;
  heliusWssUrl: string;
  jupiterApiKey: string;
  trackedWallets: PublicKey[];
  dryRun: boolean;
  copyBuyAmountSol: number;
  maxOpenPositions: number;
  minTrackedBuySol: number;
  minSolReserve: number;
  slippageBps: number;
  rpcRequestsPerSecond: number;
  summaryIntervalSeconds: number;
}

function fail(message: string): never {
  console.error(`\n❌ Config error: ${message}`);
  console.error('   Fix your .env file and try again (see .env.example for reference).\n');
  process.exit(1);
}

function requireEnv(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (!value) fail(`${name} is missing or empty.`);
  return value;
}

function numberEnv(name: string, defaultValue: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`${name}="${raw}" is not a valid number.`);
  return parsed;
}

export function loadConfig(): Config {
  const privateKeyBase58 = (process.env.PRIVATE_KEY_BASE58 ?? '').trim() || null;
  const walletMnemonic = (process.env.WALLET_MNEMONIC ?? '').trim() || null;
  if (!privateKeyBase58 && !walletMnemonic) {
    fail('Set either PRIVATE_KEY_BASE58 or WALLET_MNEMONIC (one of the two is required).');
  }

  const heliusHttpsUrl = requireEnv('HELIUS_HTTPS_URL');
  const heliusWssUrl = requireEnv('HELIUS_WSS_URL');
  if (!heliusHttpsUrl.startsWith('https://')) fail('HELIUS_HTTPS_URL must start with https://');
  if (!heliusWssUrl.startsWith('wss://')) fail('HELIUS_WSS_URL must start with wss://');

  const jupiterApiKey = requireEnv('JUPITER_API_KEY');

  const walletsRaw = requireEnv('TRACKED_WALLETS');
  const trackedWallets: PublicKey[] = [];
  for (const piece of walletsRaw.split(',')) {
    const address = piece.trim();
    if (!address) continue;
    try {
      trackedWallets.push(new PublicKey(address));
    } catch {
      fail(`TRACKED_WALLETS contains "${address}", which is not a valid Solana address.`);
    }
  }
  if (trackedWallets.length === 0) fail('TRACKED_WALLETS has no valid addresses.');

  // SAFETY: dry-run unless DRY_RUN is exactly "false".
  const dryRun = (process.env.DRY_RUN ?? 'true').trim().toLowerCase() !== 'false';

  const config: Config = {
    privateKeyBase58,
    walletMnemonic,
    heliusHttpsUrl,
    heliusWssUrl,
    jupiterApiKey,
    trackedWallets,
    dryRun,
    copyBuyAmountSol: numberEnv('COPY_BUY_AMOUNT_SOL', 0.01),
    maxOpenPositions: numberEnv('MAX_OPEN_POSITIONS', 3),
    minTrackedBuySol: numberEnv('MIN_TRACKED_BUY_SOL', 0.05),
    minSolReserve: numberEnv('MIN_SOL_RESERVE', 0.05),
    slippageBps: numberEnv('SLIPPAGE_BPS', 300),
    rpcRequestsPerSecond: numberEnv('RPC_REQUESTS_PER_SECOND', 8),
    summaryIntervalSeconds: numberEnv('SUMMARY_INTERVAL_SECONDS', 30),
  };

  if (config.copyBuyAmountSol <= 0) fail('COPY_BUY_AMOUNT_SOL must be greater than 0.');
  if (config.rpcRequestsPerSecond <= 0) fail('RPC_REQUESTS_PER_SECOND must be greater than 0.');
  if (config.summaryIntervalSeconds <= 0) fail('SUMMARY_INTERVAL_SECONDS must be greater than 0.');
  return config;
}
