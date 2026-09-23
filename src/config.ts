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
  // Quality gates — see tokenMarket.ts and walletGate.ts.
  minTokenAgeMinutes: number;
  minLiquidityUsd: number;
  walletMaxConsecutiveLosses: number;
  walletMuteHours: number;
  maxTrackedWallets: number;
  // Exits on our own terms — see exitRules.ts.
  takeProfitPercent: number;
  stopLossPercent: number;
  trailingStopPercent: number;
  exitCheckSeconds: number;
  exitRebuyCooldownHours: number;
  // Wallet rotation — see walletRoster.ts. On only when benchWallets is set.
  benchWallets: PublicKey[];
  walletDropAfterTrades: number;
  walletIdleMinutes: number;
  // Automatic wallet discovery — see discovery.ts. Implies rotation.
  discovery: boolean;
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

// `purpose` decides which checks apply: 'trade' (the bot) enforces the tracked-
// wallet cap; 'report' (npm run summary) does not, so the per-wallet table can
// still be read while trimming the list down to the cap.
export function loadConfig(purpose: 'trade' | 'report' = 'trade'): Config {
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

  // Substitutes for rotation. Optional; anything already in TRACKED_WALLETS
  // is ignored here rather than counted twice.
  const tracked = new Set(trackedWallets.map((w) => w.toBase58()));
  const benchWallets: PublicKey[] = [];
  for (const piece of (process.env.BENCH_WALLETS ?? '').split(',')) {
    const address = piece.trim();
    if (!address) continue;
    let key: PublicKey;
    try {
      key = new PublicKey(address);
    } catch {
      fail(`BENCH_WALLETS contains "${address}", which is not a valid Solana address.`);
    }
    if (tracked.has(key.toBase58()) || benchWallets.some((b) => b.equals(key))) continue;
    benchWallets.push(key);
  }
  if (benchWallets.length > 30) fail(`BENCH_WALLETS has ${benchWallets.length} addresses; keep it to 30 or fewer.`);

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
    minTokenAgeMinutes: numberEnv('MIN_TOKEN_AGE_MINUTES', 30),
    minLiquidityUsd: numberEnv('MIN_LIQUIDITY_USD', 20_000),
    walletMaxConsecutiveLosses: numberEnv('WALLET_MAX_CONSECUTIVE_LOSSES', 3),
    walletMuteHours: numberEnv('WALLET_MUTE_HOURS', 24),
    maxTrackedWallets: numberEnv('MAX_TRACKED_WALLETS', 6),
    takeProfitPercent: numberEnv('TAKE_PROFIT_PERCENT', 0),
    stopLossPercent: numberEnv('STOP_LOSS_PERCENT', 30),
    trailingStopPercent: numberEnv('TRAILING_STOP_PERCENT', 30),
    exitCheckSeconds: numberEnv('EXIT_CHECK_SECONDS', 30),
    exitRebuyCooldownHours: numberEnv('EXIT_REBUY_COOLDOWN_HOURS', 24),
    benchWallets,
    walletDropAfterTrades: numberEnv('WALLET_DROP_AFTER_TRADES', 6),
    walletIdleMinutes: numberEnv('WALLET_IDLE_MINUTES', 90),
    discovery: (process.env.DISCOVERY ?? 'false').trim().toLowerCase() === 'true',
  };

  if (config.copyBuyAmountSol <= 0) fail('COPY_BUY_AMOUNT_SOL must be greater than 0.');
  if (config.rpcRequestsPerSecond <= 0) fail('RPC_REQUESTS_PER_SECOND must be greater than 0.');
  if (config.summaryIntervalSeconds <= 0) fail('SUMMARY_INTERVAL_SECONDS must be greater than 0.');
  if (config.maxTrackedWallets <= 0) fail('MAX_TRACKED_WALLETS must be greater than 0.');
  if (config.exitCheckSeconds <= 0) fail('EXIT_CHECK_SECONDS must be greater than 0.');
  if (config.stopLossPercent >= 100) fail('STOP_LOSS_PERCENT must be below 100 (100% would mean the position is already worthless).');
  if (config.trailingStopPercent >= 100) fail('TRAILING_STOP_PERCENT must be below 100.');
  if (purpose === 'trade' && trackedWallets.length > config.maxTrackedWallets) {
    fail(
      `TRACKED_WALLETS has ${trackedWallets.length} addresses, more than MAX_TRACKED_WALLETS (${config.maxTrackedWallets}).\n` +
        '   On a free Helius plan the watcher drops trades past a handful of busy wallets (measured: 27% of\n' +
        '   signals lost at 6), and dropped trades make every result meaningless.\n' +
        `   Run \`npm run summary\` to see which wallets actually made money, keep at most ${config.maxTrackedWallets}\n` +
        '   of them in TRACKED_WALLETS, and start again. (Raise MAX_TRACKED_WALLETS only on a paid Helius plan.)'
    );
  }
  return config;
}
