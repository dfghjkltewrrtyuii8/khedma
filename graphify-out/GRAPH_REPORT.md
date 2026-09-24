# Graph Report - khedma  (2026-09-24)

## Corpus Check
- 35 files · ~54,398 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 499 nodes · 1610 edges · 17 communities
- Extraction: 87% EXTRACTED · 13% INFERRED · 0% AMBIGUOUS · INFERRED: 207 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `3ea2758d`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- scripts
- walletRoster.ts
- setup.ts
- pnl.ts
- PositionStore
- trader.ts
- logic-test.ts
- compilerOptions
- Solana Copy-Trading Bot
- discovery.ts
- WalletWatcher
- telegramSetup.ts
- main
- package.json
- setupChecks.ts
- dependencies
- devDependencies

## God Nodes (most connected - your core abstractions)
1. `main()` - 63 edges
2. `PositionStore` - 57 edges
3. `Trader` - 37 edges
4. `main()` - 36 edges
5. `main()` - 35 edges
6. `shortAddress()` - 34 edges
7. `Position` - 31 edges
8. `loadConfig()` - 29 edges
9. `WalletRoster` - 26 edges
10. `WalletWatcher` - 26 edges

## Surprising Connections (you probably didn't know these)
- `testEmptySlotsFill()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testSourceTracking()` --calls--> `compareToSource()`  [EXTRACTED]
  test/logic-test.ts → src/copyGap.ts
- `testMarkToMarket()` --calls--> `printSummary()`  [EXTRACTED]
  test/logic-test.ts → src/pnl.ts
- `testRunSheets()` --calls--> `printSummary()`  [EXTRACTED]
  test/logic-test.ts → src/pnl.ts
- `testSummary()` --calls--> `printSummary()`  [EXTRACTED]
  test/logic-test.ts → src/pnl.ts

## Import Cycles
- None detected.

## Communities (17 total, 0 thin omitted)

### Community 0 - "scripts"
Cohesion: 0.17
Nodes (12): scripts, alerts, discover, doctor, recommended, setup, start, summary (+4 more)

### Community 1 - "walletRoster.ts"
Cohesion: 0.10
Nodes (15): main(), Candidate, printDiscoveryReport(), BuyControl, copySlots(), DiscoveryHook, dropReason(), printRoster() (+7 more)

### Community 2 - "setup.ts"
Cohesion: 0.22
Nodes (16): dotenv, { ask, askHidden, askYesNo, done }, bail(), deriveAddress(), ENV_PATH, main(), say(), stamp() (+8 more)

### Community 3 - "pnl.ts"
Cohesion: 0.12
Nodes (29): avg(), compareToSource(), CopyComparison, entryPhrase(), pct(), priceOf(), summarizeComparisons(), WalletComparison (+21 more)

### Community 4 - "PositionStore"
Cohesion: 0.09
Nodes (29): loadConfig(), PositionStore, ReportInput, TradeEvent, WalletsInput, Trader, Position, main() (+21 more)

### Community 5 - "trader.ts"
Cohesion: 0.11
Nodes (22): Config, fail(), numberEnv(), requireEnv(), TradeAlerts, tradeAlertsEnv(), notify(), cache (+14 more)

### Community 6 - "logic-test.ts"
Cohesion: 0.07
Nodes (59): main(), SEQUENCE, SOL_MINT, USDC_MINT, USDT_MINT, fetchGeckoTerminal(), ago(), bad() (+51 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Solana Copy-Trading Bot"
Cohesion: 0.09
Nodes (22): 1. Check that Node.js is installed, 2. Get the code, 3. Run the setup wizard, 4. Check everything before it runs, 5. Run the bot (dry-run), 6. Stopping the bot, 7. Going live (only when you're ready), Automatic wallet discovery (`DISCOVERY=true`) (+14 more)

### Community 9 - "discovery.ts"
Cohesion: 0.17
Nodes (21): QUOTE_MINTS, bump(), discoverWallets(), DISCOVERY_RULES, DiscoveryReport, FetchJson, fetchPolitely(), findCandidates() (+13 more)

### Community 10 - "WalletWatcher"
Cohesion: 0.11
Nodes (13): JupiterClient, JupiterError, JupiterErrorKind, JupiterOrder, looksLikeNoRoute(), OrderParams, RateLimiter, main() (+5 more)

### Community 11 - "telegramSetup.ts"
Cohesion: 0.09
Nodes (23): createPrompter(), ask(), askHidden(), askYesNo(), nextLine(), Prompter, sleep(), isTelegramToken() (+15 more)

### Community 12 - "main"
Cohesion: 0.12
Nodes (37): main(), quietenRpcRetryLogs(), reportWatcherHealth(), decideShutdown(), ShutdownDecision, allQuiet(), ApiReply, clock() (+29 more)

### Community 13 - "package.json"
Cohesion: 0.16
Nodes (13): description, name, private, version, bip39, bs58, ed25519-hd-key, @solana/web3.js (+5 more)

### Community 14 - "setupChecks.ts"
Cohesion: 0.22
Nodes (9): ENV_PATH, main(), applyRecommended(), EnvValues, PLACEHOLDER_MARKERS, RECOMMENDED_SETTINGS, REQUIRED_KEYS, SettingChange (+1 more)

### Community 15 - "dependencies"
Cohesion: 0.33
Nodes (6): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js

### Community 16 - "devDependencies"
Cohesion: 0.50
Nodes (4): devDependencies, tsx, @types/node, typescript

## Knowledge Gaps
- **107 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+102 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 121 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `shortAddress()` connect `main` to `walletRoster.ts`, `setup.ts`, `pnl.ts`, `PositionStore`, `trader.ts`, `logic-test.ts`, `WalletWatcher`?**
  _High betweenness centrality (0.056) - this node is a cross-community bridge._
- **Why does `@solana/web3.js` connect `package.json` to `trader.ts`, `logic-test.ts`, `discovery.ts`, `main`, `setupChecks.ts`?**
  _High betweenness centrality (0.055) - this node is a cross-community bridge._
- **Why does `main()` connect `main` to `walletRoster.ts`, `setup.ts`, `pnl.ts`, `PositionStore`, `trader.ts`, `logic-test.ts`, `discovery.ts`, `WalletWatcher`, `telegramSetup.ts`?**
  _High betweenness centrality (0.055) - this node is a cross-community bridge._
- **Are the 24 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 24 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `main()` (e.g. with `.getOrder()` and `.getMe()`) actually correct?**
  _`main()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _107 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `walletRoster.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.10404040404040404 - nodes in this community are weakly interconnected._