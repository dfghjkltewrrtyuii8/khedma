// Preflight: checks every key, endpoint and setting the bot depends on and
// says exactly what to fix — before a single trade. Run with: npm run doctor
//
// Read-only and cheap: one Helius read per tracked wallet, one quote-only
// Jupiter request, one Dexscreener lookup. Nothing is signed or sent.

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Connection } from '@solana/web3.js';
import dotenv from 'dotenv';
import { loadConfig, SOL_MINT, USDC_MINT } from './config';
import { JupiterClient, JupiterError } from './jupiter';
import { soundFor, speechFor, speechArgs, windowsSoundFor } from './notify';
import { RateLimiter, sleep } from './rateLimiter';
import { describeExitRules, exitRulesEnabled } from './exitRules';
import { findPlaceholders } from './setupChecks';
import { getSolPriceUsd } from './solPrice';
import { fetchDexscreenerMarket } from './tokenMarket';
import { loadKeypair } from './wallet';
import { installedWeb3Version, MIN_WEB3_VERSION, shortAddress, versionAtLeast } from './watcher';
import { fetchGeckoTerminal, parseTrendingPools } from './discovery';

const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

let failures = 0;
let warnings = 0;
const ok = (message: string) => console.log(`  ✅ ${message}`);
const warn = (message: string) => {
  warnings += 1;
  console.log(`  ⚠️  ${message}`);
};
const bad = (message: string, fix?: string) => {
  failures += 1;
  console.log(`  ❌ ${message}`);
  if (fix) console.log(`     → ${fix}`);
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms).unref()),
  ]);
}

function ago(epochSeconds: number): { label: string; minutes: number } {
  const minutes = (Date.now() / 1000 - epochSeconds) / 60;
  if (minutes < 60) return { label: `${Math.round(minutes)} min ago`, minutes };
  if (minutes < 24 * 60) return { label: `${(minutes / 60).toFixed(1)} h ago`, minutes };
  return { label: `${(minutes / (24 * 60)).toFixed(1)} days ago`, minutes };
}

function finish(): never {
  console.log('');
  if (failures > 0) {
    console.log(`❌ ${failures} problem(s) to fix, ${warnings} warning(s). Fix the ❌ lines above, then run: npm run doctor`);
    process.exit(1);
  }
  console.log(`✅ Ready${warnings > 0 ? ` — with ${warnings} warning(s) above worth reading` : ''}. Start with: npm start`);
  process.exit(0);
}

// Node 22+ has a built-in WebSocket; that's enough to prove the wss:// URL and
// key are accepted, which is what the live wallet watching depends on.
async function checkWebSocket(url: string): Promise<void> {
  const WS = (globalThis as { WebSocket?: new (u: string) => any }).WebSocket;
  if (typeof WS !== 'function') {
    warn('WebSocket check skipped (needs Node 22+) — the bot will still try at startup');
    return;
  }
  await new Promise<void>((resolve) => {
    let done = false;
    let socket: any;
    const settle = (report: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      report();
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      resolve();
    };
    const timer = setTimeout(
      () => settle(() => bad('WebSocket did not connect within 10s', 'check HELIUS_WSS_URL (wss://mainnet.helius-rpc.com/?api-key=…)')),
      10_000
    );
    try {
      socket = new WS(url);
    } catch (error) {
      settle(() => bad(`WebSocket URL invalid: ${(error as Error).message}`, 'run: npm run setup'));
      return;
    }
    socket.onopen = () => settle(() => ok('WebSocket connects — live wallet watching will work'));
    socket.onerror = () => settle(() => bad('WebSocket connection refused', 'check HELIUS_WSS_URL and the API key in it'));
  });
}

async function main(): Promise<void> {
  console.log('\n🩺 Copy-bot doctor — checking everything before any money moves\n');

  console.log('Config');
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    bad('.env not found', 'run: npm run setup');
    finish();
  }
  const raw = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
  const placeholders = findPlaceholders(raw);
  if (placeholders.length > 0) {
    bad(`still empty or placeholder text: ${placeholders.join(', ')}`, 'run: npm run setup   (or fix them with: open -e .env)');
    finish();
  }
  ok('.env present, no placeholders');
  const web3Version = installedWeb3Version();
  if (versionAtLeast(web3Version, MIN_WEB3_VERSION)) {
    ok(`Solana library ${web3Version} — reads the current transaction format`);
  } else {
    bad(`Solana library ${web3Version} is too old (needs ${MIN_WEB3_VERSION}+) — most trades would be invisible`, 'run: npm install');
  }
  const config = loadConfig(); // exits with its own precise message if a value is malformed
  ok(`${config.trackedWallets.length} tracked wallet(s), DRY_RUN=${config.dryRun}`);
  if (config.benchWallets.length > 0) {
    ok(`rotation on: ${config.benchWallets.length} wallet(s) on the bench, copying ${config.trackedWallets.length} at a time`);
  }

  console.log('\nWallet');
  let keypair;
  try {
    keypair = loadKeypair(config);
    ok(`key loads → address ${keypair.publicKey.toBase58()}  (check this matches Phantom)`);
  } catch (error) {
    bad((error as Error).message, 'run: npm run setup and paste the key or phrase again');
    finish();
  }

  console.log('\nHelius');
  const connection = new Connection(config.heliusHttpsUrl, { commitment: 'confirmed' });
  let balanceSol: number | null = null;
  try {
    const lamports = await withTimeout(connection.getBalance(keypair.publicKey), 15_000);
    balanceSol = lamports / 1e9;
    ok(`HTTPS RPC answers — wallet balance ${balanceSol.toFixed(4)} SOL`);
  } catch (error) {
    bad(`HTTPS RPC failed: ${(error as Error).message}`, 'check the Helius API key (dashboard.helius.dev) — run: npm run setup');
  }
  await checkWebSocket(config.heliusWssUrl);

  console.log('\nJupiter');
  try {
    const jupiter = new JupiterClient(config.jupiterApiKey, new RateLimiter(1_100));
    const order = await jupiter.getOrder({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amountRaw: 1_000_000n, // 0.001 SOL, quote only — no taker, nothing built or sent
      takerPubkey: null,
      slippageBps: 50,
    });
    ok(`API key works — quote-only test: 0.001 SOL → ${(Number(order.outAmountRaw) / 1e6).toFixed(3)} USDC`);
  } catch (error) {
    const err = error as JupiterError;
    if (err.kind === 'rate-limited') {
      bad('rate-limited (429) on a single request', 'something else is using this key right now — is a bot already running with it?');
    } else if (/HTTP 401|HTTP 403/.test(err.message)) {
      bad('API key rejected', 'create a key at portal.jup.ag and run: npm run setup');
    } else {
      bad(`request failed: ${err.message.slice(0, 160)}`);
    }
  }

  console.log('\nMarket data');
  const market = await fetchDexscreenerMarket(BONK_MINT);
  if (market && market.ageMinutes !== null) {
    ok(`Dexscreener reachable (BONK: ${Math.round(market.ageMinutes / (24 * 60))} days old, $${Math.round(market.liquidityUsd ?? 0).toLocaleString('en-US')} liquidity)`);
  } else {
    bad('Dexscreener unreachable — the token gate would skip EVERY buy', `check your network/firewall; test: curl -s https://api.dexscreener.com/latest/dex/tokens/${BONK_MINT}`);
  }
  if (config.discovery) {
    try {
      const body = await fetchGeckoTerminal('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1');
      const raw = Array.isArray((body as any)?.data) ? (body as any).data.length : 0;
      const pools = parseTrendingPools(body);
      if (pools.length > 0) ok(`GeckoTerminal reachable — ${pools.length} of ${raw} trending pools readable (for DISCOVERY)`);
      else bad(`GeckoTerminal answered but none of its ${raw} pools could be read — discovery would find nothing`, 'run: npm run discover   and send the output to whoever maintains the bot');
    } catch (error) {
      bad(`GeckoTerminal unreachable: ${(error as Error).message} — DISCOVERY can't find wallets`, 'check your network, or set DISCOVERY=false');
    }
  }
  const price = await getSolPriceUsd();
  if (price !== null) ok(`CoinGecko SOL price $${price.toFixed(2)}`);
  else warn('CoinGecko unreachable — P&L will say "USD price unavailable" (trading itself is unaffected)');

  console.log('\nTracked and bench wallets — last activity (a wallet quiet for days has nothing to copy)');
  for (const wallet of [...config.trackedWallets, ...config.benchWallets].slice(0, 20)) {
    const name = shortAddress(wallet.toBase58());
    try {
      const signatures = await withTimeout(connection.getSignaturesForAddress(wallet, { limit: 1 }), 15_000);
      const blockTime = signatures[0]?.blockTime;
      if (!blockTime) {
        warn(`${name}: no transactions found — is the address right?`);
      } else {
        const when = ago(blockTime);
        if (when.minutes > 24 * 60) warn(`${name}: last transaction ${when.label} — quiet wallet`);
        else ok(`${name}: active ${when.label}`);
      }
    } catch (error) {
      warn(`${name}: could not check (${(error as Error).message})`);
    }
    await sleep(250);
  }

  console.log('\nSettings');
  if (config.dryRun) {
    ok('DRY_RUN=true — paper trading, nothing will be sent');
  } else {
    warn('DRY_RUN=false — REAL trading with REAL SOL from this wallet');
    if (balanceSol !== null) {
      const maxSpend = config.copyBuyAmountSol * config.maxOpenPositions;
      if (balanceSol < maxSpend + config.minSolReserve) {
        warn(
          `settings can spend up to ${maxSpend.toFixed(3)} SOL (+${config.minSolReserve} reserve) but the wallet holds ${balanceSol.toFixed(4)} — ` +
            'later buys will be skipped for low balance'
        );
      } else {
        ok(`balance covers ${config.maxOpenPositions} × ${config.copyBuyAmountSol} SOL + ${config.minSolReserve} reserve`);
      }
    }
  }
  if (exitRulesEnabled(config)) {
    ok(`exits on our own terms — ${describeExitRules(config)}, checked every ${config.exitCheckSeconds}s`);
    if (config.takeProfitPercent > 0 && config.trailingStopPercent > 0) {
      warn(
        `TAKE_PROFIT_PERCENT=${config.takeProfitPercent} caps every winner, including the rare big one this ` +
          'strategy depends on — the trailing stop alone usually does better'
      );
    }
  } else {
    warn('all exit rules are off — positions are only sold when the tracked wallet sells');
  }
  if (process.platform === 'win32') {
    const missing = (['buy', 'sell', 'fail'] as const)
      .map((kind) => windowsSoundFor(kind))
      .filter((file): file is string => file !== null && !fs.existsSync(file));
    if (missing.length > 0) warn(`Windows sound file(s) not found: ${missing.join(', ')} — speech will still play`);
    else ok('Windows chimes configured');
    const phrase = speechFor('buy', false);
    if (phrase === null) ok('speech off (SPEECH=false)');
    else ok(`speech on via Windows voices — e.g. "${phrase}"${process.env.SPEECH_VOICE ? `, voice "${process.env.SPEECH_VOICE}"` : ''}`);
    console.log('     hear them all with: npm run alerts   (male voice: SPEECH_VOICE=male)');
  }
  if (process.platform === 'darwin') {
    const missing = (['buy', 'sell', 'fail'] as const)
      .map((kind) => soundFor(kind))
      .filter((file): file is string => file !== null && !fs.existsSync(file));
    if (missing.length > 0) warn(`sound file(s) not found: ${missing.join(', ')} — the default names are Glass, Hero, Basso`);
    else ok('chimes configured');
    const phrase = speechFor('buy', false);
    if (phrase === null) {
      ok('speech off (SPEECH=false)');
    } else {
      // A voice that isn't installed makes `say` fail silently — you'd hear
      // nothing and never learn why, so check it here instead.
      const wanted = (process.env.SPEECH_VOICE ?? '').trim();
      const configured = speechArgs().includes('-v');
      if (wanted && !configured) {
        warn(`SPEECH_VOICE="${wanted}" is not a usable voice name — the default voice will be used instead`);
      } else if (wanted) {
        const installed = await new Promise<boolean>((resolve) => {
          execFile('say', ['-v', '?'], (error, stdout) => {
            if (error) return resolve(true); // can't tell — don't cry wolf
            resolve(stdout.toLowerCase().includes(wanted.toLowerCase()));
          });
        });
        if (installed) ok(`speech on, voice "${wanted}" — e.g. "${phrase}"`);
        else warn(`voice "${wanted}" is not installed on this Mac — nothing would be spoken. List them: say -v "?"`);
      } else {
        ok(`speech on, default voice — e.g. "${phrase}"`);
      }
      console.log('     hear them all with: npm run alerts');
    }
  }

  finish();
}

main().catch((error) => {
  console.error(`\n❌ Doctor crashed: ${(error as Error).message}`);
  process.exit(1);
});
