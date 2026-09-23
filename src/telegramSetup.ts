// `npm run telegram`: links the bot to Telegram so reports reach your phone.
//
// Two steps: create a bot of your own with @BotFather and paste its token,
// then send that bot a message so it learns which chat is yours. Writes two
// lines to .env (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) and leaves every other
// line exactly as it was. The token is typed hidden and goes nowhere but .env
// and Telegram itself.

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { createPrompter } from './prompt';
import { isTelegramToken, upsertEnv } from './setupChecks';
import { sleep } from './rateLimiter';
import { explainTelegramError, helpText, TelegramClient, TelegramError, TelegramMessage, TelegramUser } from './telegram';

const ENV_PATH = path.join(process.cwd(), '.env');
const MAX_ATTEMPTS = 5;
const WAIT_MINUTES = 5;
// A message sent this long before the waiting starts still counts — people
// often press Start while reading the instructions.
const RECENT_SECONDS = 15 * 60;
const ENV_HEADING = '# ---- Reports on your phone (README: "Telegram") — set up with: npm run telegram ----';

const { askHidden, askYesNo, done } = createPrompter('Telegram setup');

function say(text = ''): void {
  console.log(text);
}

function bail(message: string): never {
  say(`\n❌ ${message} Nothing was written.`);
  process.exit(1);
}

async function tokenFromUser(): Promise<{ token: string; me: TelegramUser }> {
  say('\n1/2  CREATE YOUR BOT  (in the Telegram app, on your phone or computer)');
  say('     • Search for  @BotFather  (it has a blue tick) and open it');
  say('     • Send  /newbot');
  say('     • Give it any name, e.g.  My Copybot');
  say('     • Give it a username that ends in "bot", e.g.  ahmed_copy_2026_bot');
  say('     • BotFather replies with a token like  123456789:AAH…  — copy all of it');
  say('     Each computer running the bot needs its own Telegram bot — don\'t share one with a friend.');
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const input = await askHidden('     Paste the token (it stays hidden): ');
    if (!isTelegramToken(input)) {
      say("     ✗ that doesn't look like a bot token — it's a number, a colon, then a long code (123456789:AAH…)");
      continue;
    }
    try {
      const me = await new TelegramClient(input).getMe();
      say(`     ✓ token works — your bot is @${me.username}`);
      return { token: input, me };
    } catch (error) {
      if (error instanceof TelegramError && error.kind === 'unauthorized') {
        say('     ✗ Telegram rejected that token — copy it again from @BotFather (all of it, nothing extra).');
      } else {
        say(`     ✗ ${explainTelegramError(error)}`);
      }
    }
  }
  bail('No working token after several tries.');
}

// Waits for the first private message to the bot, up to WAIT_MINUTES.
async function waitForMessage(client: TelegramClient): Promise<TelegramMessage | null> {
  const deadline = Date.now() + WAIT_MINUTES * 60_000;
  let offset = 0;
  let complained = false;
  while (Date.now() < deadline) {
    let updates;
    try {
      updates = await client.getUpdates(offset, 20);
    } catch (error) {
      if (error instanceof TelegramError && error.kind === 'conflict') {
        bail('Your copy bot seems to be running and already reading this bot\'s messages. Stop it (Ctrl+C in its window), then run npm run telegram again.');
      }
      if (!complained) say(`     (${explainTelegramError(error)} — still trying)`);
      complained = true;
      await sleep(5_000);
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      const message = update.message;
      if (message && message.chat.type === 'private' && Date.now() / 1000 - message.date <= RECENT_SECONDS) {
        // Mark it read, so the running bot doesn't answer it later.
        await client.getUpdates(offset, 0).catch(() => {});
        return message;
      }
    }
  }
  return null;
}

async function main(): Promise<void> {
  say('╔══════════════════════════════════════════╗');
  say('║   Telegram setup — reports on your phone ║');
  say('╚══════════════════════════════════════════╝');
  say('About 3 minutes. The bot will only ever answer YOU, and it is read-only:');
  say('you can check profit and loss from your phone, but not trade from it.');

  if (!fs.existsSync(ENV_PATH)) bail('No .env in this folder — run this from the copybot folder, after npm run setup.');
  const envText = fs.readFileSync(ENV_PATH, 'utf8');
  const existing = dotenv.parse(envText);
  const reportHours = Number(existing.TELEGRAM_REPORT_HOURS || 3);

  // Already set up? Offer to keep it.
  let token = (existing.TELEGRAM_BOT_TOKEN ?? '').trim();
  let me: TelegramUser | null = null;
  if (isTelegramToken(token)) {
    me = await new TelegramClient(token).getMe().catch(() => null);
    const chatId = (existing.TELEGRAM_CHAT_ID ?? '').trim();
    if (me && chatId) {
      say(`\nTelegram is already set up with your bot @${me.username}.`);
      if (!(await askYesNo('Set it up again?'))) {
        try {
          await new TelegramClient(token).sendMessage(chatId, '👋 Still connected — your copybot reports arrive here.', true);
          say('✅ Kept as it is. A test message is on its way to your phone.');
        } catch (error) {
          say(`⚠️  Kept as it is, but the test message failed: ${explainTelegramError(error)}`);
        }
        done();
        return;
      }
      me = null;
    } else if (me) {
      say(`\nUsing the bot already in .env: @${me.username}.`);
    }
  }
  if (!me) ({ token, me } = await tokenFromUser());
  const client = new TelegramClient(token);

  say('\n2/2  LINK YOUR PHONE');
  say(`     Open  https://t.me/${me.username}  (or search @${me.username} in Telegram),`);
  say('     press START, then send it:  hi');
  say(`     Waiting for your message… (up to ${WAIT_MINUTES} minutes; Ctrl+C to cancel)`);
  const message = await waitForMessage(client);
  if (!message) bail(`No message arrived in ${WAIT_MINUTES} minutes. Run npm run telegram again when you're ready.`);
  const who = `${message.from?.first_name ?? 'someone'}${message.from?.username ? ` (@${message.from.username})` : ''}`;
  const said = (message.text ?? '').replace(/\s+/g, ' ').slice(0, 40);
  say(`     ✓ got "${said}" from ${who}`);
  if (!(await askYesNo('     Is that you?'))) {
    bail('Then someone else messaged your bot first. Run npm run telegram again and send the message yourself.');
  }

  const updated = upsertEnv(fs.readFileSync(ENV_PATH, 'utf8'), { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: String(message.chat.id) }, ENV_HEADING);
  fs.writeFileSync(ENV_PATH, updated, { mode: 0o600 });
  fs.chmodSync(ENV_PATH, 0o600);

  try {
    await client.sendMessage(String(message.chat.id), `✅ Connected! Your copybot reports will arrive here.\n\n${helpText(reportHours)}`, true);
  } catch (error) {
    say(`⚠️  Saved, but the welcome message failed: ${explainTelegramError(error)}`);
  }

  say('\n✅ Telegram linked. .env now has TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');
  say('   Restart the bot to turn it on: Ctrl+C in its window (if running), then  npm start');
  say('   Then on your phone, send your bot  /pnl  any time.');
  done();
}

main().catch((error) => {
  console.error(`\n❌ Telegram setup failed: ${(error as Error).message}`);
  process.exit(1);
});
