// `npm run recommended`: puts the settings that keep a paper test busy into
// .env — the wallet scanner on, 4 wallets at a time, no token check — the
// same way on a Mac and on Windows. Every other line of .env stays exactly as
// it was, and nothing that decides how much money is used is touched.

import fs from 'fs';
import path from 'path';
import { applyRecommended } from './setupChecks';

const ENV_PATH = path.join(process.cwd(), '.env');

function main(): void {
  if (!fs.existsSync(ENV_PATH)) {
    console.log('❌ No .env in this folder — run this from the copybot folder, after npm run setup.');
    process.exit(1);
  }
  const { text, changes } = applyRecommended(fs.readFileSync(ENV_PATH, 'utf8'));
  if (changes.length === 0) {
    console.log('✅ Already on the recommended settings — nothing to change.');
    return;
  }
  fs.writeFileSync(ENV_PATH, text, { mode: 0o600 });
  fs.chmodSync(ENV_PATH, 0o600);
  console.log('✅ Updated .env:');
  for (const c of changes) console.log(`   ${c.key}: ${c.from ?? '(not set)'} → ${c.to}   — ${c.why}`);
  console.log('\n   Not touched: DRY_RUN, buy size, position limits, your wallets and keys.');
  console.log('   Before trading real money, consider turning the token check back on');
  console.log('   (MIN_TOKEN_AGE_MINUTES / MIN_LIQUIDITY_USD) — it guards against brand-new rugs.');
  console.log('\n   Restart the bot to use them: Ctrl+C in its window (if running), then  npm start');
}

main();
