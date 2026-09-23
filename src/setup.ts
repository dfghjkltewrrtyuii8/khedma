// Interactive first-time setup: asks for the four things the bot needs, checks
// each one as you paste it, and writes .env. Run with: npm run setup
//
// Why a wizard instead of "copy .env.example and edit it": every first-time
// install in this project's history went wrong in the editor — a placeholder
// left in, a phrase pasted with a line break, the example copied over a
// finished .env. The wizard validates each value before anything is written,
// derives the wallet address so you can confirm it's the right wallet, and
// never overwrites an existing .env without keeping a backup. Secrets are
// typed hidden and go nowhere but .env on this machine.

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { createPrompter } from './prompt';
import {
  classifyWalletSecret,
  ENV_DEFAULTS,
  maskSecret,
  parseHeliusInput,
  parseWalletList,
  renderEnv,
} from './setupChecks';
import { loadKeypair } from './wallet';
import { shortAddress } from './watcher';

const ENV_PATH = path.join(process.cwd(), '.env');
const MAX_ATTEMPTS = 5;

const { ask, askHidden, askYesNo, done } = createPrompter('setup');

function say(text = ''): void {
  console.log(text);
}

function bail(message: string): never {
  say(`\n❌ ${message} Nothing was written.`);
  process.exit(1);
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function deriveAddress(privateKeyBase58: string, walletMnemonic: string): string {
  return loadKeypair({ privateKeyBase58: privateKeyBase58 || null, walletMnemonic: walletMnemonic || null }).publicKey.toBase58();
}

async function main(): Promise<void> {
  say('╔══════════════════════════════════════════╗');
  say('║   Copy-bot setup                         ║');
  say('╚══════════════════════════════════════════╝');
  say('Four questions. Each answer is checked before anything is written.');
  say('Nothing is sent anywhere — your keys only go into .env on this Mac.\n');

  const existing: Record<string, string> = fs.existsSync(ENV_PATH) ? dotenv.parse(fs.readFileSync(ENV_PATH, 'utf8')) : {};
  if (Object.keys(existing).length > 0) {
    say('Found an existing .env — press Return at any question to keep what is there.');
    say('The old file is backed up before anything is overwritten.\n');
  }

  // ---- 1. wallet ----
  let privateKeyBase58 = (existing.PRIVATE_KEY_BASE58 ?? '').trim();
  let walletMnemonic = (existing.WALLET_MNEMONIC ?? '').trim();
  let address: string | null = null;
  if (privateKeyBase58 || walletMnemonic) {
    try {
      address = deriveAddress(privateKeyBase58, walletMnemonic);
    } catch {
      address = null;
    }
  }
  say('1/4  YOUR WALLET');
  say('     Paste EITHER the private key (Phantom → Settings → Manage Accounts → your account → Show Private Key)');
  say('     OR the 12/24-word recovery phrase, all on one line. Typing is hidden.');
  if (address) say(`     Press Return to keep the current wallet (${address}).`);
  for (let attempt = 1; ; attempt++) {
    const secret = await askHidden('     > ');
    if (!secret && address) break;
    const kind = classifyWalletSecret(secret);
    if (kind.kind === 'invalid') {
      say(`     ✗ ${kind.reason}`);
      if (attempt >= MAX_ATTEMPTS) bail('Too many attempts.');
      continue;
    }
    const candidateKey = kind.kind === 'key' ? secret : '';
    const candidateMnemonic = kind.kind === 'mnemonic' ? secret.toLowerCase().replace(/\s+/g, ' ') : '';
    let candidateAddress: string;
    try {
      candidateAddress = deriveAddress(candidateKey, candidateMnemonic);
    } catch (error) {
      say(`     ✗ ${(error as Error).message}`);
      continue;
    }
    say(`     ✓ received ${kind.kind === 'key' ? 'a private key' : `a ${kind.words}-word phrase`} → wallet address ${candidateAddress}`);
    if (await askYesNo('     Is that the wallet the bot should trade from? Compare it with the address shown in Phantom.')) {
      privateKeyBase58 = candidateKey;
      walletMnemonic = candidateMnemonic;
      address = candidateAddress;
      break;
    }
    say('     OK — paste the right one.');
  }

  // ---- 2. Helius ----
  say('\n2/4  HELIUS  (free account at dashboard.helius.dev → copy the API key)');
  say('     Paste the API key by itself, or the full RPC URL from the dashboard.');
  let heliusHttpsUrl = (existing.HELIUS_HTTPS_URL ?? '').trim();
  let heliusWssUrl = (existing.HELIUS_WSS_URL ?? '').trim();
  const heliusKept = parseHeliusInput(heliusHttpsUrl) !== null && !heliusHttpsUrl.includes('YOUR_KEY_HERE') && heliusWssUrl.startsWith('wss://');
  if (heliusKept) say(`     Press Return to keep the current key (${maskSecret(heliusHttpsUrl)}).`);
  for (;;) {
    const input = await ask('     > ');
    if (!input && heliusKept) break;
    const parsed = parseHeliusInput(input);
    if (!parsed) {
      say('     ✗ that does not look like a Helius key or URL (the key is a long string of letters, digits and dashes)');
      continue;
    }
    heliusHttpsUrl = parsed.https;
    heliusWssUrl = parsed.wss;
    say('     ✓ Helius endpoints set');
    break;
  }

  // ---- 3. Jupiter ----
  say('\n3/4  JUPITER  (free key at portal.jup.ag → create a key)');
  say('     One key per bot — a key is limited to 1 request/second, so two bots on one key starve each other.');
  let jupiterApiKey = (existing.JUPITER_API_KEY ?? '').trim();
  if (jupiterApiKey) say(`     Press Return to keep the current key (${maskSecret(jupiterApiKey)}).`);
  for (;;) {
    const input = await ask('     > ');
    if (!input && jupiterApiKey) break;
    if (input.length < 8 || /\s/.test(input)) {
      say('     ✗ that does not look like an API key');
      continue;
    }
    jupiterApiKey = input;
    say('     ✓ Jupiter key set');
    break;
  }

  // ---- 4. wallets to copy ----
  const maxWallets = Number(existing.MAX_TRACKED_WALLETS ?? ENV_DEFAULTS.MAX_TRACKED_WALLETS) || 6;
  say(`\n4/4  WALLETS TO COPY  (up to ${maxWallets}; separate with commas, spaces or new lines)`);
  const kept = parseWalletList(existing.TRACKED_WALLETS ?? '');
  let trackedWallets = kept.invalid.length === 0 && kept.valid.length > 0 && kept.valid.length <= maxWallets ? kept.valid : [];
  if (trackedWallets.length > 0) {
    say(`     Press Return to keep the current ${trackedWallets.length}: ${trackedWallets.map(shortAddress).join(', ')}`);
  }
  for (;;) {
    const input = await ask('     > ');
    if (!input && trackedWallets.length > 0) break;
    const parsed = parseWalletList(input);
    if (parsed.invalid.length > 0) {
      say(`     ✗ not valid Solana addresses: ${parsed.invalid.join(', ')}`);
      continue;
    }
    if (parsed.valid.length === 0) {
      say('     ✗ no addresses found');
      continue;
    }
    if (parsed.valid.length > maxWallets) {
      say(`     ✗ ${parsed.valid.length} wallets — the free tier can't keep up past ${maxWallets}. Pick your best ${maxWallets}.`);
      continue;
    }
    trackedWallets = parsed.valid;
    say(`     ✓ ${trackedWallets.length} wallet(s)`);
    break;
  }

  // ---- write ----
  const settings: Record<string, string> = {};
  for (const key of Object.keys(ENV_DEFAULTS)) {
    const value = (existing[key] ?? '').trim();
    if (value) settings[key] = value;
  }
  const wasLive = settings.DRY_RUN?.toLowerCase() === 'false';
  settings.DRY_RUN = 'true';

  const text = renderEnv({ privateKeyBase58, walletMnemonic, heliusHttpsUrl, heliusWssUrl, jupiterApiKey, trackedWallets, settings });
  if (fs.existsSync(ENV_PATH)) {
    const backup = `${ENV_PATH}.backup-${stamp()}`;
    fs.copyFileSync(ENV_PATH, backup);
    fs.chmodSync(backup, 0o600);
    say(`\nPrevious .env saved as ${path.basename(backup)} (delete it once you're happy).`);
  }
  fs.writeFileSync(ENV_PATH, text, { mode: 0o600 });
  fs.chmodSync(ENV_PATH, 0o600);

  say('\n✅ .env written. DRY_RUN=true — paper trading until you change that yourself.');
  say(`   Wallet ${address}, copying ${trackedWallets.length} wallet(s).`);
  if (wasLive) say('   Note: DRY_RUN was false before and has been reset to true. Flip it back only after watching a run.');
  say('\nNext:  npm run doctor     (checks keys, network and wallets — before any money moves)');
  say('Then:  npm start');
  done();
}

main().catch((error) => {
  console.error(`\n❌ Setup failed: ${(error as Error).message}`);
  process.exit(1);
});
