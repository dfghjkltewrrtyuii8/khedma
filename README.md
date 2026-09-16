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
  your Jupiter request budget), always split into SIMULATED vs REAL.
- **Hard caps:** fixed SOL per buy, max simultaneous positions (stuck ones count),
  a minimum SOL reserve that real trades will never dip below, and a dust filter
  that ignores tiny tracked buys.
- **Quality gates** refuse the trades that lost before: tokens too new or too
  thin to exit, and wallets on a losing streak. See
  [What it refuses to copy](#what-it-refuses-to-copy-quality-gates).

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

### 2. Get the code and install dependencies

If you haven't cloned this repository yet:

```zsh
cd ~
git clone https://github.com/dfghjkltewrrtyuii8/khedma.git
cd khedma
```

If you already have it, just go into the folder:

```zsh
cd ~/khedma
```

Then install the dependencies (takes a minute):

```zsh
npm install
```

### 3. Create your .env file

```zsh
cp .env.example .env
open -e .env
```

That opens the file in TextEdit. Fill in each value (details below), then save
with **Cmd+S** and close TextEdit.

| Variable | What to put there |
|---|---|
| `PRIVATE_KEY_BASE58` | Your Phantom private key (Phantom → Settings → Manage Accounts → your account → Show Private Key). **Or** leave empty and use the mnemonic instead. |
| `WALLET_MNEMONIC` | Your 12/24-word recovery phrase (only if not using the private key). Uses the standard path `m/44'/501'/0'/0'`. |
| `HELIUS_HTTPS_URL` | Your Helius HTTPS endpoint (starts with `https://`). |
| `HELIUS_WSS_URL` | Your Helius WebSocket endpoint (starts with `wss://`). |
| `JUPITER_API_KEY` | Your key from portal.jup.ag (free tier is fine — the bot rate-limits itself). |
| `TRACKED_WALLETS` | The wallet addresses to copy, separated by commas, no spaces needed. Example: `9xQe...WeR4,7dHb...pQr2` |
| `DRY_RUN` | Leave as `true` for now. |
| `COPY_BUY_AMOUNT_SOL` | SOL spent per copied buy. Default `0.01`. |
| `MAX_OPEN_POSITIONS` | Max positions at once (stuck ones count). Default `3`. |
| `MIN_TRACKED_BUY_SOL` | Ignore tracked buys smaller than this (dust filter). Default `0.05`. |
| `MIN_SOL_RESERVE` | Real trades never spend below this balance. Default `0.05`. |
| `SLIPPAGE_BPS` | Max slippage in basis points (`300` = 3%). |
| `MIN_TOKEN_AGE_MINUTES` | Don't copy a token younger than this (checked on Dexscreener). Default `30`. Set this **and** `MIN_LIQUIDITY_USD` to `0` to turn the token check off. |
| `MIN_LIQUIDITY_USD` | Don't copy a token with less than this much liquidity in its deepest pool. Default `20000`. |
| `WALLET_MAX_CONSECUTIVE_LOSSES` | Mute a tracked wallet after this many copied losses in a row. Default `3`; `0` = never mute. |
| `WALLET_MUTE_HOURS` | How long a muted wallet stays muted. Default `24`; `0` = until you remove it. |
| `MAX_TRACKED_WALLETS` | The bot refuses to start with more tracked wallets than this. Default `6`. |
| `RPC_REQUESTS_PER_SECOND` | How fast the watcher may read from Helius. Default `8`. Lower it if you see rate-limit retries. |
| `NOTIFICATIONS` | macOS desktop alerts on every buy, sell, and failed sell. Default `true`; set `false` to silence. |
| `SOUNDS` | macOS sound on every filled buy, completed sell, and failed sell — each one different, so you can tell them apart without looking. Plays even if notifications are muted. Default `true`. |
| `SOUND_BUY` / `SOUND_SELL` / `SOUND_FAIL` | Which sound for each event: a macOS system sound name (`Glass`, `Hero`, `Basso`, `Ping`, `Pop`, `Submarine`…) or the full path to your own audio file. Defaults `Glass` / `Hero` / `Basso`. |
| `SUMMARY_INTERVAL_SECONDS` | How often the P&L summary prints while running, in both DRY_RUN and real mode. Default `30`. |

> 🔒 Your `.env` holds your private key. It is listed in `.gitignore`, so `git`
> will never upload it. Don't paste it anywhere else, and don't screenshot it.

### 4. Run the bot (dry-run)

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

On a Mac you'll also *hear* it: **Glass** when a buy fills, **Hero** when a
sell completes, **Basso** when a sell fails and the position is stuck — so
you know what happened without looking at the screen. (`SOUNDS` and
`SOUND_*` in `.env` change or silence them.)

A P&L summary prints every 30 seconds (`SUMMARY_INTERVAL_SECONDS` in `.env`)
and on shutdown. Positions survive restarts — they're saved in
`data/positions.json`.

### 5. Stopping the bot

Press **Ctrl+C once**. The bot immediately stops copying new trades, tries to
close every open position (in dry-run, simulated; stuck ones get one more try),
prints the final P&L summary, and exits. If you don't want to wait, press
**Ctrl+C a second time** to force-quit — nothing is ever sold twice.

### 6. Going live (only when you're ready)

After you've watched dry-run behave correctly for a while:

1. Open `.env` again: `open -e .env`
2. Change `DRY_RUN=true` to `DRY_RUN=false`, save, close.
3. Start again: `npm start` — the banner will now say `🔴 MODE: REAL TRADING`.

Start with the small defaults. Simulated positions from dry-run stay in the
history as SIMULATED; real trades are tracked separately.

### Useful extras

Print the P&L summary any time without starting the bot:

```zsh
npm run summary
```

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

Check that the bot's logic is working (offline — no wallet, no network, no
trades; uses a throwaway keypair and a temp folder):

```zsh
npm test
```

It should end with `All logic tests passed.` This verifies buy/sell detection,
the Jupiter rate limiter spacing, stuck-position handling, the double-Ctrl+C
guard, and that P&L never invents numbers.

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

---

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
| `Config error: …` on startup | The message names the exact `.env` variable to fix. |
| `Wallet error: …` | Private key/mnemonic is malformed — re-export from Phantom and paste carefully. |
| `Could not reach Helius RPC` | Check `HELIUS_HTTPS_URL` (and that your Helius plan is active). |
| Lots of `Jupiter 429` lines | Something else is using the same Jupiter key at the same time. The bot backs off automatically, but avoid running two bots on one free key. |
| Summary reports `RPC rate-limit retries` | You're exceeding your Helius plan. Lower `RPC_REQUESTS_PER_SECOND` or watch fewer wallets — every retry is a delayed or dropped trade. |
| Summary reports transactions `skipped as stale` | The watcher fell behind and discarded trades too old to copy (>45s). Same fix as above. |
| `no route for …` when buying | Token too new/illiquid for Jupiter — the bot just skips it. |
| `Config error: TRACKED_WALLETS has N addresses` | More wallets than `MAX_TRACKED_WALLETS` (default 6). Keep your best few — past that the watcher drops trades and nothing can be judged. |
| Everything is `skip: token is … old` or `not listed on any DEX yet` | Working as intended — those are the trades that lost before. Lower `MIN_TOKEN_AGE_MINUTES` / `MIN_LIQUIDITY_USD` only knowing why they're there. |
| `token lookup failed` on every buy | Dexscreener unreachable (network/firewall). The bot skips rather than buys blind. Test it: `curl -s https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112 \| head -c 200` |
| Bot seems idle | Normal — it only acts when a tracked wallet trades. The periodic summaries confirm it's alive. |
| No sound on buys/sells | `SOUNDS` must not be `false` in `.env`, and the Mac can't be muted. Test a sound directly: `afplay /System/Library/Sounds/Glass.aiff`. Your own file needs a full path starting with `/`. |
