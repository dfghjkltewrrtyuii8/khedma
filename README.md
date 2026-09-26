# Solana Copy-Trading Bot

Watches Solana wallets you choose and automatically mirrors their trades:

- When a tracked wallet **buys** a token (paying with SOL, USDC, or USDT), the bot
  buys a **small fixed amount** of that token with your SOL (default: 0.01 SOL —
  it never mirrors their position size).
- When that same wallet **sells**, the bot sells the **same fraction** of your
  position (they sell half → you sell half; they sell out → you sell out).

Built with Node.js + TypeScript (run directly with `tsx`, no build step),
`@solana/web3.js`, Helius RPC for watching wallets, and Jupiter Swap API v2
(`api.jup.ag/swap/v2/order` + `/execute`) for swaps.

## Safety features (on by default)

- **DRY_RUN mode is the default.** The bot fetches real quotes but never sends a
  transaction until you explicitly set `DRY_RUN=false`. Watch it run in dry-run
  first, for as long as you need.
- **One shared rate limiter** in front of *every* Jupiter call — max 1 request in
  flight, ~1.1 s between calls — because the free Jupiter tier is 1 request/second.
- **A position sold outside the bot frees its slot instead of blocking forever.**
  If you sell manually (Phantom, jup.ag) and the bot later finds the wallet
  holds zero of that token, it's marked **abandoned** — not stuck, since
  there's nothing left to retry — and stops counting toward
  `MAX_OPEN_POSITIONS`. No P&L is recorded for it either way, since the bot
  doesn't know what it actually sold for.
- **Real sells are sized from the wallet, not from the quote.** A fill delivers
  slightly less than quoted (that's what slippage is), so selling the quoted
  figure gets rejected as "Insufficient funds" and strands the position. The bot
  reads the actual on-chain balance before every real sell.
- **Failed sells are never faked as closed.** If a real sell fails after retries,
  the position is marked **STUCK** ("tokens still in your wallet"), flagged loudly,
  and excluded from realized P&L.
- **Graceful shutdown that survives an accidental double Ctrl+C.** First
  `Ctrl+C`: stop watching immediately, then try to close all positions. A
  second `Ctrl+C` only force-quits if it arrives more than 5 seconds after the
  first — an instant double-tap (key-repeat, an impatient second press) is
  ignored rather than cutting the close short. Sells are guaranteed not to
  run twice either way.
- **P&L in SOL and USD** (live SOL price from CoinGecko, so it doesn't consume
  your Jupiter request budget), always split into SIMULATED vs REAL — including
  out loud: a paper fill is spoken as "Simulated. Order filled", never as a real one.
- **A setup wizard and a preflight check.** `npm run setup` checks every value
  before writing `.env` (and shows the wallet address it derives, so a wrong
  key is caught before it's saved); `npm run doctor` tests keys, endpoints and
  wallets before any money moves.
- **Hard caps:** fixed SOL per buy, max simultaneous positions (stuck ones count),
  a minimum SOL reserve that real trades will never dip below, and a dust filter
  that ignores tiny tracked buys.
- **Quality gates** refuse the trades that lost before: tokens too new or too
  thin to exit, and wallets on a losing streak. See
  [What it refuses to copy](#what-it-refuses-to-copy-quality-gates).
- **It can exit without the tracked wallet** — a stop-loss and a trailing stop
  that act on your position's own P&L, so you are not chained to their timing.
  See [Exiting without them](#exiting-without-them).

> ⚠️ **Risk note:** only trade with SOL you are fully prepared to lose. Very new
> or thin tokens can lose their Jupiter route within seconds — the bot retries
> sells, but a successful exit is never guaranteed.

---

## Setup (Mac, Terminal, step by step)

You'll do this once. Every command below is typed into Terminal and finished by
pressing **Return**.

### 1. Check that Node.js is installed

```zsh
node --version
```

You should see something like `v20.x.x` or `v22.x.x`. **Node 18 or newer is
required** (the bot uses Node's built-in `fetch`). If you get
`command not found` or an older version, install Node from
<https://nodejs.org> (download the LTS installer, run it, then re-open Terminal
and check again).

### 2. Get the code

**From a file someone sent you** (`khedmacopybot….tar.gz`, usually in Downloads):

```zsh
mkdir -p ~/copybot
tar -xzf "$(ls -t ~/Downloads/*copybot*.tar.gz | head -1)" -C ~/copybot
cd ~/copybot
```

**Or from GitHub** (the bot lives on this branch — `main` is empty):

```zsh
git clone -b claude/solana-trading-bot-setup-ub4hfr https://github.com/dfghjkltewrrtyuii8/khedma.git ~/copybot
cd ~/copybot
```

Then install the dependencies (takes a minute) and run the offline checks:

```zsh
npm install
npm test
```

`npm test` should end with `All logic tests passed.`

### 3. Run the setup wizard

```zsh
npm run setup
```

It asks for four things, checks each one as you paste it, and writes `.env`
for you. Have them ready:

| It asks for | Where to get it |
|---|---|
| Your Phantom **private key** or **recovery phrase** | Phantom → Settings → Manage Accounts → your account → Show Private Key (or Show Recovery Phrase). Typing is hidden. The wizard shows the wallet **address** it derives so you can check it matches Phantom before it's saved. |
| Helius **API key** | Free account at <https://dashboard.helius.dev> → copy the API key. Paste the key alone or the full RPC URL. |
| Jupiter **API key** | Free key at <https://portal.jup.ag>. **One key per bot** — a key is limited to 1 request/second, so two bots on one key starve each other. |
| **Wallets to copy** | Up to 10 addresses, separated by commas or spaces. |

Everything else starts at safe defaults, including `DRY_RUN=true`. Re-running
the wizard keeps your current values (just press Return) and backs up the old
`.env` first, so it can never wipe a finished setup.

> 🔒 Your `.env` holds your private key. It is listed in `.gitignore`, so `git`
> will never upload it. Don't paste it anywhere else, and don't screenshot it.

### 4. Check everything before it runs

```zsh
npm run doctor
```

Read-only. It loads your key and shows the address, reads your balance from
Helius, opens the WebSocket, makes one quote-only Jupiter request, checks
Dexscreener and CoinGecko, and shows when each tracked wallet last traded (a
wallet quiet for days has nothing to copy). Every line is ✅, ⚠️ or ❌ with the
fix next to it. Fix the ❌ lines, run it again, then start the bot.

For a paper test that actually trades, switch on the recommended settings
(the wallet scanner, 10 wallets at a time, quiet ones swapped after 30
minutes, no token check). Same command on
Mac and Windows; it leaves every money setting alone:

```zsh
npm run recommended
```

#### Every setting (reference)

Change any of these later with `open -e .env` (save with Cmd+S, then restart
the bot). To change the wallet or a key, run `npm run setup` again.

| Variable | What to put there |
| `PRIVATE_KEY_BASE58` | Your Phantom private key (Phantom → Settings → Manage Accounts → your account → Show Private Key). **Or** leave empty and use the mnemonic instead. |
| `WALLET_MNEMONIC` | Your 12/24-word recovery phrase (only if not using the private key). Uses the standard path `m/44'/501'/0'/0'`. |
| `HELIUS_HTTPS_URL` | Your Helius HTTPS endpoint (starts with `https://`). |
| `HELIUS_WSS_URL` | Your Helius WebSocket endpoint (starts with `wss://`). |
| `JUPITER_API_KEY` | Your key from portal.jup.ag (free tier is fine — the bot rate-limits itself). |
| `TRACKED_WALLETS` | The wallet addresses to copy, separated by commas, no spaces needed. Example: `9xQe...WeR4,7dHb...pQr2` |
| `DRY_RUN` | Leave as `true` for now. |
| `COPY_BUY_AMOUNT_SOL` | SOL spent per copied buy. Default `0.01`. |
| `MAX_OPEN_POSITIONS` | Max real-money positions at once (stuck ones count). Default `3`. |
| `PAPER_MAX_OPEN_POSITIONS` | Max paper positions at once — paper risks nothing, so a low cap only wastes test data. Counted separately from real ones. Default `10`. |
| `MIN_TRACKED_BUY_SOL` | Ignore tracked buys smaller than this (dust filter). Default `0.05`. |
| `MIN_SOL_RESERVE` | Real trades never spend below this balance. Default `0.05`. |
| `SLIPPAGE_BPS` | Max slippage in basis points (`300` = 3%). |
| `MIN_TOKEN_AGE_MINUTES` | Don't copy a token younger than this (checked on Dexscreener). Default `30`. Set this **and** `MIN_LIQUIDITY_USD` to `0` to turn the token check off. |
| `MIN_LIQUIDITY_USD` | Don't copy a token with less than this much liquidity in its deepest pool. Default `20000`. |
| `WALLET_MAX_CONSECUTIVE_LOSSES` | Mute a tracked wallet after this many copied losses in a row. Default `3`; `0` = never mute. |
| `WALLET_MUTE_HOURS` | How long a muted wallet stays muted. Default `24`; `0` = until you remove it. |
| `MAX_TRACKED_WALLETS` | The most wallets copied at once; the bot refuses to start with more tracked wallets than this. Default `10`. |
| `BENCH_WALLETS` | Substitute wallets for [rotation](#wallet-rotation). Empty = a fixed list. |
| `ACTIVE_WALLETS` | Rotation: how many wallets to copy at once; empty slots fill from the bench and discovery. Default `4`. |
| `WALLET_DROP_AFTER_TRADES` | Rotation: drop a wallet once this many copies have closed at a net loss. Default `6`; `0` = only the losing streak. |
| `WALLET_MAX_TX_PER_10MIN` | Rotation: drop a wallet for good if it makes more transactions than this in 10 minutes — a robot, not a trader. Default `150`; `0` = off. |
| `WALLET_IDLE_MINUTES` | Rotation: bench a wallet after this many minutes without a buy while running. Default `90`; `0` = never. |
| `DISCOVERY` | Find new wallets automatically when the bench runs low ([details](#automatic-wallet-discovery-discoverytrue)). Discovered wallets are paper-only until proven. Default `false`. |
| `STOP_LOSS_PERCENT` | Sell if a position falls this far below what you paid. Default `30`; `0` = off. |
| `TRAILING_STOP_PERCENT` | Sell if a position that has been in profit gives back this much from its own peak. Default `30`; `0` = off. |
| `TAKE_PROFIT_PERCENT` | Sell as soon as a position is up this much. Default `0` (**off on purpose** — see below). |
| `EXIT_CHECK_SECONDS` | How often open positions are priced to check those rules. Default `30`. Costs one Jupiter request per open position each time. |
| `EXIT_REBUY_COOLDOWN_HOURS` | After a rule sells a token, ignore new buys of it for this long. Default `24`; `0` = allow immediately. |
| `RPC_REQUESTS_PER_SECOND` | How fast the watcher may read from Helius. Default `8`. Lower it if you see rate-limit retries. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Reports on your phone — filled in by `npm run telegram` ([details](#telegram-pl-on-your-phone)). Empty = off. |
| `TELEGRAM_REPORT_HOURS` | How often a Telegram report arrives. Default `3`; `0` = only when you ask and when the bot stops. |
| `TELEGRAM_TRADE_ALERTS` | A Telegram message per trade: `sells` (default), `all` (buys too) or `off`. |
| `NOTIFICATIONS` | macOS desktop alerts on every buy, sell, and failed sell. Default `true`; set `false` to silence. |
| `SOUNDS` | macOS chime on every filled buy, completed sell, and failed sell — each one different, so you can tell them apart without looking. Plays even if notifications are muted. Default `true`. |
| `SOUND_BUY` / `SOUND_SELL` / `SOUND_FAIL` | Which chime for each event: a macOS system sound name (`Glass`, `Hero`, `Basso`, `Ping`, `Pop`, `Submarine`…) or the full path to your own audio file. Defaults `Glass` / `Hero` / `Basso`. |
| `SPEECH` | Your Mac **says** what happened after the chime — "Order filled", "Order sold". Default `true`; `false` for chimes only. |
| `SPEECH_BUY` / `SPEECH_SELL` / `SPEECH_FAIL` | What it says for each event. Defaults `Order filled` / `Order sold` / `Sell failed. Position stuck.` |
| `SPEECH_VOICE` / `SPEECH_RATE` | Optional voice name (Mac: list them with `say -v "?"`; Windows: `male`, `female`, or an exact name like `Microsoft David Desktop`) and, on Mac only, speed in words per minute (80–500, normal ≈175). Empty = the default voice. |
| `SUMMARY_INTERVAL_SECONDS` | How often the bot checks whether to print its status. It prints when something changed (a trade, a wallet swapped, a transaction examined) and at least every 10 minutes. Default `30`. |
| `PROBATION_TRADES` | A wallet found by discovery trades on paper until this many of its copies have closed with a net profit; only then with real money. Default `6`; `0` = no trial (real money from its first copy). |

### 5. Run the bot (dry-run)

```zsh
npm start
```

You should see: the mode banner (`🟢 MODE: DRY RUN`), your wallet address and
balance, then a `👀 Watching wallet …` line per tracked wallet. When a tracked
wallet trades, you'll see lines like:

```
🔔 9xQe…WeR4 BOUGHT 1,234,567 of Ab3d…9kQz (~0.5000 SOL)
   ↳ copying: buying 0.01 SOL of Ab3d…9kQz…
   ✅ [DRY RUN] SIMULATED buy: 1,234 Ab3d…9kQz for 0.01 SOL (position pos-…)
```

On a Mac you'll also *hear* it: a chime, then your Mac says what happened —
**"Order filled"** on a buy, **"Order sold"** on a sell, **"Sell failed,
position stuck"** when an exit fails. Dry-run trades are spoken as
**"Simulated. Order filled"**, so paper can never be mistaken for real money.
Hear them all right now, without waiting for a trade:

```zsh
npm run alerts
```

(`SOUNDS`, `SPEECH` and the `SOUND_*` / `SPEECH_*` settings in `.env` change
or silence them.)

The status and P&L summary print whenever something changes — a trade, a
wallet swapped, a transaction examined — at least every 10 minutes, and on
shutdown. Positions survive restarts — they're saved in
`data/positions.json`.

### 6. Stopping the bot

Press **Ctrl+C once**. The bot immediately stops copying new trades, tries to
close every open position (in dry-run, simulated; stuck ones get one more try),
prints the final P&L summary, and exits. If you don't want to wait, press
**Ctrl+C a second time** to force-quit — nothing is ever sold twice.

### 7. Going live (only when you're ready)

After you've watched dry-run behave correctly for a while (at least a few
days and 30 closed paper trades, with a positive total):

1. Open `.env` again: `open -e .env`
2. Change `DRY_RUN=true` to `DRY_RUN=false`, save, close.
3. Run `npm run doctor` — it now warns if your balance can't cover your settings.
4. Start again: `npm start` — the banner will now say `🔴 MODE: REAL TRADING`.

Start with the small defaults. Simulated positions from dry-run stay in the
history as SIMULATED; real trades are tracked separately.

### Useful extras

Print the P&L summary any time without starting the bot:

```zsh
npm run summary          # the latest run on its own (the current one, if the bot is running)
npm run summary -- all   # every run together
```

**Every start gets a fresh P&L sheet.** The terminal summaries, `/pnl` on
Telegram and the final report when you stop all cover *this run* only, with
one line underneath for all runs together. Nothing is deleted: the history
stays in `data/positions.json`, because the wallet rules (drops, mutes,
probation for discovered wallets) are judged over every run.

Open positions are **marked to market** here: each one is priced with a
quote-only Jupiter order (no taker, so nothing is balance-checked), showing
what it's worth right now rather than only what you paid. That lets you judge
a wallet that buys and holds without waiting for it to sell — useful when you
can't leave the bot running for days. Costs one Jupiter call per open position,
about 1.1s each.

A position Jupiter can't route is flagged `NO ROUTE — nothing will buy this
right now` instead of being valued at cost. That's usually a dead token.

The 15-minute summary printed *while the bot runs* is deliberately not marked
to market — during a run, the 1 request/second budget belongs to trading.

Hear every alert without waiting for a trade (reads your `.env`, so what you
hear is exactly what you'll hear live):

```zsh
npm run alerts
```

Check that the bot's logic is working (offline — no wallet, no network, no
trades; uses a throwaway keypair and a temp folder):

```zsh
npm test
```

It should end with `All logic tests passed.` This verifies buy/sell detection,
the Jupiter rate limiter spacing, stuck-position handling, the exit rules, the
double-Ctrl+C guard, and that P&L never invents numbers.

The suite pins every setting itself (`test/test-env.ts`), so it reads the same
on every machine and ignores your `.env` entirely — your own buy size or stop-
loss can never turn a working build red. It also stays silent: no chimes, no
speech, no notifications while it runs.

Write off a position that's genuinely stuck for good — e.g. a token that
rugged (lost all liquidity) and will never find a route to sell. Unlike the
automatic "abandoned" handling above (which only fires when your wallet
balance for that token reads zero), this is for a token you're still
*holding* but have decided is worthless. It stops the position occupying
one of your `MAX_OPEN_POSITIONS` slots; no P&L is recorded either way,
since you're declaring it unrecoverable rather than reporting a sale:

```zsh
npm run writeoff
```

Run with no arguments first — it lists every real position still occupying
a slot, with its id, status, and mint. Then write off the specific one:

```zsh
npm run writeoff -- <position-id>
```

Only ever touches real positions that are still open or stuck. Simulated
(dry-run) and already-closed positions are never listed or touchable by it.

Start completely fresh (forgets all recorded positions — it does **not** sell
anything, and any real tokens stay in your wallet):

```zsh
rm -rf data
```

## Getting your rent back (`npm run reclaim`)

Every new coin the bot buys with real money gets its own token account, and
Solana makes your wallet lock **~0.002 SOL of rent** in it. At 0.03 SOL a
trade that's ~7% of every trade — and it doesn't show in your balance.
Selling empties the account but doesn't close it, so before version 1.10 the
rent just stayed locked: a night of ~30 new coins locked ~$7 while the P&L
sheet (which counted only the swap) showed a profit.

Since 1.10 the bot:

- **closes the emptied account right after each sale** (in the background —
  trading never waits on it), so the rent comes straight back
  (`♻️ Closed the emptied token account — 0.0020 SOL of rent is back`);
- **records what a real buy actually cost** — the swap plus network fees plus
  that rent — and adds the rent back when it returns, so the sheet matches
  your wallet. Take-profit and stop-loss still measure against the swap itself.

For accounts left behind by earlier versions (or by coins you sold yourself
in Phantom), run this once, with the bot stopped:

```zsh
npm run reclaim
```

It lists how many empty accounts it found and how much SOL they hold, asks
before doing anything, and closes them. Accounts that still hold tokens are
never touched — Solana itself refuses to close those. `npm run doctor` tells
you whenever there's rent waiting to come back.

---

## Telegram: P&L on your phone

Leave the bot running overnight and check it from your phone in the morning,
without scrolling back through the terminal.

**Set it up once (about 3 minutes):**

```zsh
npm run telegram
```

It walks you through it: in Telegram, message **@BotFather** → `/newbot` →
pick a name and a username ending in `bot` → paste the token it gives you
(typed hidden). Then open your new bot, press **Start**, send it `hi`, and
confirm it's you. That's all — restart the bot (`Ctrl+C`, `npm start`) and
it's on. `npm run doctor` sends a test message to check it any time.

**What you get:**

| On your phone | When |
|---|---|
| `/pnl` | Profit and loss: won/lost, total in SOL and $, best and worst trade, what open trades are worth now |
| `/open` | What it's holding right now, each with a chart link |
| `/wallets` | Who it's copying, how each is doing, the bench, and who was dropped |
| `/status` | Running? How long? When did it last see a trade? Did the laptop sleep? |
| A report | Every `TELEGRAM_REPORT_HOURS` (default 3) and a final one when the bot stops |
| A message per sell | With the result, e.g. `✅ Sold WIF… +42% (+0.0042 SOL) · paper · trailing stop` |

Everything arrives **silently** (no buzz at night). Only two things make the
phone ring: a **real-money** sell that failed, and the bot crashing.

**Safety.** It's read-only: there is no command that buys, sells or changes a
setting, so someone holding your phone can look but never trade. It only
answers your own Telegram account; anyone else who finds your bot gets no
reply. Your wallet key never goes near it. The bot token lives in `.env` only.
**One Telegram bot per computer** — a friend makes their own with
`npm run telegram` on their machine (two computers sharing one token fight
over its messages, and the bot will tell you so).

Settings (in `.env`): `TELEGRAM_REPORT_HOURS` (`0` = only when you ask and
when it stops) and `TELEGRAM_TRADE_ALERTS` (`sells`, `all` for buys too, or
`off`).

**Keep the computer awake.** A sleeping computer runs nothing — no trades are
watched. The bot notices afterwards and tells you (`😴 The computer was asleep
01:12–06:40`), but the trades in that window are gone. On a Mac, keep it
plugged in with the lid open and start it like this:

```zsh
caffeinate -is npm start
```

On Windows: Settings → System → Power → "When plugged in, put my device to
sleep after" → **Never**.

---

## Installing for a friend (fresh Mac)

(On Windows? Same idea — see [Windows (PowerShell)](#windows-powershell).)

Send them the code (the `.tar.gz` you were given, or the GitHub branch above)
and these steps. They need their **own** wallet, Helius key and Jupiter key —
never share yours: a shared Jupiter key starves both bots (1 request/second
between them), and a shared wallet key is a shared wallet.

Have ready before starting:

1. A Phantom wallet holding **only** the SOL they are prepared to lose.
2. A free Helius account → <https://dashboard.helius.dev> → the API key.
3. A free Jupiter key → <https://portal.jup.ag>.
4. The addresses of the wallets to copy (at most 6).

Then, in Terminal (Cmd+Space, type `Terminal`, Return):

```zsh
node --version      # v18 or newer. If not: install the LTS from nodejs.org, then reopen Terminal.
mkdir -p ~/copybot
tar -xzf "$(ls -t ~/Downloads/*copybot*.tar.gz | head -1)" -C ~/copybot
cd ~/copybot
npm install
npm test            # ends with "All logic tests passed."
npm run setup       # the four questions above — each answer is checked before it's saved
npm run doctor      # keys, network, wallets — fix any ❌ before going on
npm start           # DRY RUN (paper trading). Ctrl+C once to stop.
```

Leave that Terminal window open while the bot runs. Watch it on paper for a
few days before even thinking about `DRY_RUN=false`, and read the risk note at
the top of this file first.

## Windows (PowerShell)

Everything works on Windows too — the commands are just different. Open
**PowerShell** (Start menu → type `PowerShell` → Enter).

**1. Node.js** — check it's installed:

```powershell
node --version
```

Needs v18 or newer. If not, install the LTS from <https://nodejs.org>, then
close and reopen PowerShell.

**2. Get the code into a `copybot` folder** (picks the newest copybot file in
Downloads):

```powershell
New-Item -ItemType Directory -Force "$HOME\copybot" | Out-Null
$f = Get-ChildItem "$HOME\Downloads\*copybot*.tar.gz" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
tar -xzf $f.FullName -C "$HOME\copybot"
cd "$HOME\copybot"
```

**3. Install, test, set up, check, run:**

```powershell
npm install
npm test
npm run setup
npm run doctor
npm start
```

`npm test` should end with `All logic tests passed.`

**If `npm` says "running scripts is disabled on this system"** — a Windows
default, not a problem with the bot — run this once, answer `Y`, and try again:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

**Every time after that**, starting the bot is:

```powershell
cd "$HOME\copybot"
npm start
```

**Differences from Mac:**

- Edit settings with `notepad .env` instead of `open -e .env`.
- Chimes use Windows' own sounds and the speech uses Windows voices. For a
  **male voice**, set `SPEECH_VOICE=male` (or an exact name such as
  `Microsoft David Desktop`). `SPEECH_RATE` and the Mac chime names (`Glass`,
  `Hero`…) don't apply on Windows; a `SOUND_BUY` etc. can be a full path to
  your own `.wav`. Hear them with `npm run alerts`.
- No pop-up banners — Windows gets the sound and the voice.
- Only put your wallet key on a computer you trust. For paper trading
  (`DRY_RUN=true`) the wallet doesn't need any SOL in it at all.

## How it decides what is a "buy" or "sell"

For every confirmed transaction from a tracked wallet, the bot compares the
wallet's balances before and after:

- exactly one non-quote token went **up** while SOL/USDC/USDT went **down** → a **buy**;
- exactly one non-quote token went **down** while SOL/USDC/USDT went **up** → a **sell**;
- anything else (plain transfers, airdrops, LP moves, multi-token swaps) is skipped.

Extra rules, to keep things predictable:

- One position per token. If a tracked wallet buys a token you already hold
  (or buys it again), the bot skips it.
- Sells are only mirrored from the **same wallet** whose buy was copied.
- If the tracked wallet sells more than 90% of their bag, the bot treats it as a
  full exit and sells 100% of yours.

## What it refuses to copy (quality gates)

The bot copies 5–15 seconds behind the tracked wallet — that is the free-tier
reality (one Helius read at a time, one Jupiter request per second). Fresh,
thin tokens move more than that in ten seconds, so copying them late means
buying the top and selling into nothing. Every real loss in this bot's
history was exactly that. Two gates refuse those trades before any money
moves:

- **Token gate.** Before copying a buy, the token is looked up on Dexscreener
  (free, no key, doesn't touch the Jupiter budget). It must be at least
  `MIN_TOKEN_AGE_MINUTES` old and have at least `MIN_LIQUIDITY_USD` in its
  deepest pool. A token with no listing yet is treated as too new; a lookup
  that fails is treated as unknown. Both are **skipped, never guessed**, and
  the log says exactly why (`↳ skip: token is 4 min old, need 30 min`).
- **Wallet gate.** A tracked wallet whose copied positions close at a loss
  `WALLET_MAX_CONSECUTIVE_LOSSES` times in a row is **muted** for
  `WALLET_MUTE_HOURS`: its new buys are skipped, its open positions are still
  mirrored on sell. Muted wallets show as 🔇 in the summary's per-wallet
  table — which is also where you see which wallets actually make money.

Both gates make the bot slower and pickier. That is the point: the trades
they refuse are the ones that lost.

## Wallet rotation

Give the bot more candidates than it copies at once, and it keeps the good
ones and swaps out the rest by itself:

```
TRACKED_WALLETS=<the 3 to start with>
BENCH_WALLETS=<substitutes, best first>
```

It copies `ACTIVE_WALLETS` wallets at a time (default 4 — never fewer than
you list in `TRACKED_WALLETS`, never more than `MAX_TRACKED_WALLETS`). Empty
slots are filled from the bench straight away, including wallets that
[discovery](#automatic-wallet-discovery-discoverytrue) finds. And it:

- **Drops a wallet for good** when copying it loses: 3 losses in a row
  (`WALLET_MAX_CONSECUTIVE_LOSSES`), or a net loss once 6 of its copies have
  closed (`WALLET_DROP_AFTER_TRADES`). The next bench wallet takes its slot.
- **Benches a quiet wallet** after 90 minutes without a buy while you're
  running (`WALLET_IDLE_MINUTES`; `npm run recommended` sets 30). Quiet isn't
  bad — it may trade while you sleep — so it waits on the bench (💤) and gets
  a slot again when it trades.
- **Copies whoever trades at this hour.** Each found wallet's usual hours are
  learned from its last two weeks of transaction times (one cheap lookup, when
  it's vetted). A free slot goes, in order, to: a benched wallet **seen trading
  right now**; then one not benched yet (your own, then new finds); then the
  benched wallet that **usually trades at this hour**
  (`🔄 Now copying … — it usually trades at this hour`). While a copied wallet
  is quiet, the bot checks one benched wallet at a time — the likeliest for
  this hour, each at most every 15 minutes — and when one is trading, it takes
  the slot of a copied wallet that has done nothing at all on-chain for 15+
  minutes, instead of waiting out the full half hour. A wallet just benched for
  being quiet waits an hour before its usual hours count again (unless it's
  seen trading), so nothing flips back and forth. `npm run summary` shows each
  wallet's usual hours in your time. In a simulated three days (30 wallets
  with 6-hour trading days, 10 slots) this copied ~95% of their buys, against
  ~33% the old way — which got stuck once every waiting wallet was known to
  be quiet — at about 85 swaps a day. Real wallets are less regular than that
  simulation; expect less, but the direction is the same.
- **Puts proven winners first** (⭐): a wallet whose copies have made money
  — at least 2 closed, net profit — gets a slot ahead of untried ones. When
  one goes quiet it's benched like any other, but the bot checks on it every
  5 minutes and brings it straight back the moment it trades again
  (`🔄 … ⭐ is trading again`); the lowest-ranked wallet makes room and is first
  in line for the next free slot. (Before, the best wallet could sit at the
  back of a long bench while untried ones got its turns.)
- **Drops robots at once**: a wallet making more than 150 transactions in 10
  minutes (`WALLET_MAX_TX_PER_10MIN`) is a trading machine, not a person. It
  floods the watcher, so everyone else's trades wait behind it, and it uses up
  the free Helius allowance, one lookup per transaction. It's dropped for good
  and no longer watched; any open copy from it is closed by your exit rules or
  when you stop the bot.
- **Never adds a wallet you didn't list** — unless you turn on
  [discovery](#automatic-wallet-discovery-discoverytrue).

A wallet that loses its slot stops being copied at once, but the bot keeps
watching it until any position copied from it has closed, so its sells are
still mirrored. Swaps are announced in the terminal as they happen
(`🔄 Dropped …`, `🔄 Now copying …`); drops, a ⭐ winner coming back and new
finds also go to Telegram, if set up (routine swaps don't — there are dozens a
day). The `📊` line shows who's active, and `npm run summary` lists the whole
roster: the reason for every drop, who's 💤, and each wallet's usual hours.
It's saved in `data/wallets.json`. Deleting that file (with the bot stopped)
starts the roster over — but it also forgets every drop, so robots and losing
wallets come back; it's rarely what you want.

Six copies is a small sample, so rotation will sometimes drop a wallet that
was just unlucky. It's a trade-off in favour of not spending your limited
hours on wallets that aren't working.

### Automatic wallet discovery (`DISCOVERY=true`)

A fixed list goes stale: wallets that made money last month stop, and good
traders move to new addresses once people copy them. With `DISCOVERY=true`
the bot finds new wallets by itself whenever the bench runs low (fewer than
3 waiting, at most every 45 minutes, in the background — trading carries on).

**Where it looks — deliberately not a leaderboard.** Leaderboards are
dominated by launch snipers, whose whole edge is being first — exactly what a
copy 10 seconds late can't have. Instead it takes tokens trending right now
(GeckoTerminal's free public API; no key, and it doesn't use your Helius
budget), reads their recent trades, and keeps wallets that:

- bought **after the launch rush** (15+ minutes after the pool opened),
- held **5 minutes to 6 hours**, then **sold at a profit** (+5% or more),
- did it on **two or more** trending tokens (or +20% on one),
- aren't bots (20+ trades in one window) and aren't dust.

These are deliberately loose — discovery only nominates.

**Then each nominee is vetted on its own trades** (🧪). A profitable round
trip or two on trending tokens can be luck, and live runs showed what it
missed: most picks hardly bought anything, so their slots sat idle, and some
flipped coins in and out within a couple of minutes — faster than a copy can
follow (their +3%, the copy −15%). So the bot reads each nominee's history
from Helius — its last 1,000 transaction times in one lookup, and its last 40
transactions in full (about 40 lookups) — and keeps it only if it:

- has done **anything in the last 3 days** (otherwise it's gone, not asleep),
- makes **at least 4 buys** in those 40 transactions, and **a buy every two hours it's active** — counting only the hours it does anything, so a daytime trader checked at night isn't called quiet,
- makes buys **at least `MIN_TRACKED_BUY_SOL`** in size (smaller ones are skipped as dust, so the slot would do nothing),
- **holds for 3+ minutes** typically (quicker flips are over before a copy lands),
- **won at least half** of 3+ finished trades, and **made money** over them,
- isn't a machine (60+ transactions an hour).

A wallet that passes all that but **hasn't bought in 3 hours is asleep, not
bad** (💤): it's kept, waits on the bench, and is copied when it trades again.
(The first version turned those away for a week — 12 of 33 rejections in a
live run were wallets checked overnight.)

Each verdict is printed (`✅ … 9 buys in 4.0h · 5 trades 4W/1L · net +0.300 SOL
· holds ~12 min`, `💤 … asleep — last bought 6.0h ago; record: …` or
`❌ … flips coins in ~1 min — over before a copy lands`). A turned-away wallet
isn't suggested again for a week. Wallets found before vetting existed — or
before it learned usual hours — are checked the same way, one at a time,
copied ones first; one that fails leaves the roster and its slot goes to the
next wallet (`🧪 Removed …`). Passed wallets are re-checked every 3 days.
Proven winners (⭐) and wallets you listed yourself are never vetted: your own
copies of a winner are better evidence than its history, and your picks are
yours. On the first start after updating to v1.13, wallets the first version
turned away only for being quiet are put back on the bench to be checked
again.

Past results don't promise future ones; vetting only turns away wallets that
clearly can't work for a copy bot. What your copies actually earn still
decides after that.

**Discovery nominates; the paper record decides.** The free feed only covers
each token's recent trades, so "profitable" means "over the last few hours" —
a noisy signal. So every discovered wallet is copied **on paper** until it has
6 closed copies with a net profit (`PROBATION_TRADES`), **even when `DRY_RUN=false`** — and its
paper positions never take up your real-money slots. Only then is it copied
with real SOL. Real copies count too: a wallet that already made money with
real copies (while the trial was off, say) has passed, so turning the trial
back on never sends a proven wallet back to paper. Wallets you listed
yourself are never on probation, and a wallet dropped for losing is never
re-discovered.

Run it by hand to see what it finds and why, before turning it on:

```zsh
npm run discover
```

It prints each candidate with the evidence (e.g. `WIF: +34%, held 1.8h, bought
2.1h after launch`) and adds new ones to the bench. If it finds nothing, the
report says how far it got (pools read, trades read) and where it broke.
`npm run summary` marks discovered wallets with `*` and says why each was picked.

## Exiting without them

By default a copy-trading bot sells only when the wallet it copied sells. That
chains your exit to theirs — *plus* the 5–15 seconds it takes to see and act on
it. It is how the `ARJh` position ended at **−78%**: the tracked wallet got out
at their price, and the bot followed them down.

So the bot prices its own open positions every `EXIT_CHECK_SECONDS` and acts on
its own P&L:

- **Stop-loss** (`STOP_LOSS_PERCENT`, default 30) — sell if the position falls
  that far below what you paid. This is the one that caps a disaster.
- **Trailing stop** (`TRAILING_STOP_PERCENT`, default 30) — once a position has
  actually been in profit, sell if it gives back that much from its own peak. A
  10× that fades to 7× is banked at 7×; a position that was never in profit is
  left to the stop-loss, so the two rules never double up.
- **Take-profit** (`TAKE_PROFIT_PERCENT`, default **0 = off**).

> ⚠️ **Why take-profit is off by default.** This strategy's returns come from
> rare outliers. In dry-run, eight of nine positions lost and a single **+984%**
> winner carried the entire set. A take-profit at +50% would have sold that
> winner early and turned a profitable set into a losing one. Capping the upside
> of an outlier-driven strategy is how you guarantee it loses. The trailing stop
> does the job properly — it protects gains without putting a ceiling on them.

Two details that keep this honest:

- A position Jupiter **can't price** is left alone, never guessed at — an
  invented value could fire a stop-loss on a number the bot made up.
- After a rule sells a token, the bot **won't buy back into it** for
  `EXIT_REBUY_COOLDOWN_HOURS` (default 24). Otherwise the tracked wallet's next
  buy would put you straight back into what you just escaped.

Exits show up in the P&L summary tagged with the rule that closed them, e.g.
`[stop-loss]`, so you can tell your own exits from mirrored ones.

Set all three to `0` to go back to only selling when the tracked wallet does —
the periodic pricing is then skipped entirely and costs nothing.

## What "STUCK" means

If a **real** sell fails 3 times in a row (for example the token lost its
Jupiter route), the position is marked `stuck` — the tokens are still in your
wallet and **no fake P&L is recorded**. Stuck positions:

- are flagged with 🔴 in every summary and at startup,
- still count toward `MAX_OPEN_POSITIONS`,
- get one more sell attempt each time you shut the bot down with Ctrl+C,
- can always be sold manually in Phantom or on jup.ag.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Config error: …` on startup | The message names the exact `.env` variable to fix — or just run `npm run setup` again. |
| `npm run doctor` shows ❌ | The `→` line under it is the fix. Run it again after fixing. |
| `npm run setup` doesn't show what I paste for the key/phrase | Intentional — secrets are typed hidden. It tells you what it received ("a 24-word phrase") and the wallet address it derives. |
| `Wallet error: …` | Private key/mnemonic is malformed — re-export from Phantom and paste carefully. |
| `Could not reach Helius RPC` | Check `HELIUS_HTTPS_URL` (and that your Helius plan is active). |
| Lots of `Jupiter 429` lines | Something else is using the same Jupiter key at the same time. The bot backs off automatically, but avoid running two bots on one free key. |
| Summary reports `RPC rate-limit retries` | You're exceeding your Helius plan. Lower `RPC_REQUESTS_PER_SECOND` or watch fewer wallets — every retry is a delayed or dropped trade. |
| Summary reports transactions `skipped as stale` | The watcher fell behind and discarded trades too old to copy (>45s). Same fix as above. |
| `no route for …` when buying | Token too new/illiquid for Jupiter — the bot just skips it. |
| `Config error: TRACKED_WALLETS has N addresses` | More wallets than `MAX_TRACKED_WALLETS` (default 10). Keep your best few — past that the watcher drops trades and nothing can be judged. |
| `⚠️ Trades are being missed — too much to watch` | The wallets being copied make more transactions than the free Helius plan can look up in time. Lower `ACTIVE_WALLETS` in `.env` (e.g. to 6) and restart. |
| Everything is `skip: token is … old` or `not listed on any DEX yet` | Working as intended — those are the trades that lost before. Lower `MIN_TOKEN_AGE_MINUTES` / `MIN_LIQUIDITY_USD` only knowing why they're there. |
| `token lookup failed` on every buy | Dexscreener unreachable (network/firewall). The bot skips rather than buys blind. Test it: `curl -s https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112 \| head -c 200` |
| The P&L sheet shows a profit but the wallet went down | Rent: each new coin locks ~0.002 SOL in a token account (~7% of a 0.03 SOL trade), and versions before 1.10 neither counted it nor got it back. Run `npm run reclaim` (bot stopped) to close the empty accounts and get that SOL back; from 1.10 the bot does it after every sale and the sheet counts real costs. |
| Bot runs but never buys (`0 transactions examined`) | Read the `Last on-chain activity:` line under each `📊 Watcher` summary (or send `/status` on Telegram). Wallets that last did something hours ago are simply **quiet** — nothing to copy. Fix: `npm run recommended` (wallet scanner on, 10 wallets at a time, quiet ones swapped after 30 minutes, token check off), then restart. If a wallet shows recent activity but nothing was examined, the live feed broke — the bot notices within 5 minutes (`📡 The live feed missed …`) and reconnects it by itself. |
| Every copy is `skip: token is … old` | The token check is on. For paper testing, `npm run recommended` turns it off. |
| `🚨 … transaction format … can't read` | Solana introduced a newer transaction format than this build understands, so trades in it are **missed** — the bot will look idle while wallets are trading. Update the bot. (This happened once already: version 1 arrived in 2026 and needed `@solana/web3.js` 1.99.) |
| `npm run discover` finds nothing | Read its report line: `0 trending pools` or a ⚠️ line means GeckoTerminal couldn't be reached or read (network, or they changed their format — send the output to whoever maintains the bot). Pools and trades read but `0 candidates` just means nobody passed the filter this hour; try again later. |
| `could not price … for exit rules` | Jupiter can't quote that token right now, so the exit rules skip it rather than act on a made-up value. If it persists the token is probably dead — see STUCK below. |
| Positions keep selling at a small loss | `STOP_LOSS_PERCENT` is tighter than the token's normal swings. Memecoins routinely move 30–50%; raise it, or set it to `0` while you watch. |
| No sound on buys/sells | Run `npm run alerts` — it plays every alert and prints what it's using. `SOUNDS`/`SPEECH` must not be `false`, and the Mac can't be muted. Test directly: `afplay /System/Library/Sounds/Glass.aiff` and `say "Order filled"`. Your own sound file needs a full path starting with `/`. |
| Chimes play but nothing is spoken | The voice in `SPEECH_VOICE` probably isn't installed — `npm run doctor` says so. List the ones you have with `say -v "?"`, or leave `SPEECH_VOICE` empty for the default. |
