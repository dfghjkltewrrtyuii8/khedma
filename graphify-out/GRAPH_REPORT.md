# Graph Report - khedma  (2026-10-03)

## Corpus Check
- 39 files · ~77,383 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 619 nodes · 2186 edges · 17 communities
- Extraction: 84% EXTRACTED · 16% INFERRED · 0% AMBIGUOUS · INFERRED: 349 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `49c5e001`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- trader.ts
- WalletRoster
- setup.ts
- testSessionLossLimit
- PositionStore
- pnl.ts
- logic-test.ts
- compilerOptions
- Solana Copy-Trading Bot
- walletRoster.ts
- WalletWatcher
- main
- scripts
- package.json
- setupChecks.ts
- dependencies
- devDependencies

## God Nodes (most connected - your core abstractions)
1. `main()` - 72 edges
2. `PositionStore` - 68 edges
3. `WalletRoster` - 50 edges
4. `Trader` - 49 edges
5. `shortAddress()` - 47 edges
6. `main()` - 44 edges
7. `Rotation` - 41 edges
8. `main()` - 38 edges
9. `Position` - 38 edges
10. `loadConfig()` - 34 edges

## Surprising Connections (you probably didn't know these)
- `testActiveWalletFilter()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testEmptySlotsFill()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testSessionLossLimit()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testStaleBenchAndTrial()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testSourceTracking()` --calls--> `compareToSource()`  [EXTRACTED]
  test/logic-test.ts → src/copyGap.ts

## Import Cycles
- None detected.

## Communities (17 total, 0 thin omitted)

### Community 0 - "trader.ts"
Cohesion: 0.07
Nodes (31): Config, createPrompter(), ask(), askHidden(), askYesNo(), nextLine(), Prompter, main() (+23 more)

### Community 1 - "WalletRoster"
Cohesion: 0.09
Nodes (21): main(), dropReason(), printRoster(), provenWinners(), Rotation, WalletRoster, WatchControl, describeHours() (+13 more)

### Community 2 - "setup.ts"
Cohesion: 0.29
Nodes (13): { ask, askHidden, askYesNo, done }, bail(), deriveAddress(), ENV_PATH, main(), say(), stamp(), classifyWalletSecret() (+5 more)

### Community 3 - "testSessionLossLimit"
Cohesion: 0.19
Nodes (8): describeLossLimit(), LossLimit, lossLimitReached(), sessionResultSol(), inRun(), RunInfo, PositionStatus, testSessionLossLimit()

### Community 4 - "PositionStore"
Cohesion: 0.08
Nodes (27): loadConfig(), PositionStore, main(), ReportInput, TradeEvent, WalletsInput, Trader, ExitRule (+19 more)

### Community 5 - "pnl.ts"
Cohesion: 0.10
Nodes (30): avg(), compareToSource(), CopyComparison, entryPhrase(), pct(), priceOf(), summarizeComparisons(), WalletComparison (+22 more)

### Community 6 - "logic-test.ts"
Cohesion: 0.08
Nodes (54): main(), SEQUENCE, fetchGeckoTerminal(), ago(), bad(), checkWebSocket(), finish(), main() (+46 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Solana Copy-Trading Bot"
Cohesion: 0.08
Nodes (24): 1. Check that Node.js is installed, 2. Get the code, 3. Run the setup wizard, 4. Check everything before it runs, 5. Run the bot (dry-run), 6. Stopping the bot, 7. Going live (only when you're ready), Automatic wallet discovery (`DISCOVERY=true`) (+16 more)

### Community 9 - "walletRoster.ts"
Cohesion: 0.05
Nodes (59): @solana/web3.js, fail(), numberEnv(), QUOTE_MINTS, requireEnv(), SOL_MINT, TradeAlerts, tradeAlertsEnv() (+51 more)

### Community 10 - "WalletWatcher"
Cohesion: 0.15
Nodes (8): RateLimiter, WalletWatcher, testActiveWalletFilter(), testActivityCheck(), testRateLimiter(), testRobotWallets(), testTransactionVersions(), testWatcherQueue()

### Community 11 - "main"
Cohesion: 0.07
Nodes (56): printDiscoveryReport(), main(), quietenRpcRetryLogs(), reportWatcherHealth(), TOKEN_ACCOUNT_RENT_SOL, sleep(), isTelegramToken(), upsertEnv() (+48 more)

### Community 12 - "scripts"
Cohesion: 0.15
Nodes (13): scripts, alerts, discover, doctor, reclaim, recommended, setup, start (+5 more)

### Community 13 - "package.json"
Cohesion: 0.14
Nodes (13): description, name, private, version, bip39, bs58, dotenv, ed25519-hd-key (+5 more)

### Community 14 - "setupChecks.ts"
Cohesion: 0.18
Nodes (10): ENV_PATH, main(), applyRecommended(), ENV_DEFAULTS, EnvValues, PLACEHOLDER_MARKERS, RECOMMENDED_SETTINGS, REQUIRED_KEYS (+2 more)

### Community 15 - "dependencies"
Cohesion: 0.33
Nodes (6): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js

### Community 16 - "devDependencies"
Cohesion: 0.50
Nodes (4): devDependencies, tsx, @types/node, typescript

## Knowledge Gaps
- **118 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+113 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 137 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `shortAddress()` connect `WalletRoster` to `trader.ts`, `setup.ts`, `PositionStore`, `pnl.ts`, `logic-test.ts`, `walletRoster.ts`, `WalletWatcher`, `main`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **Why does `main()` connect `main` to `trader.ts`, `WalletRoster`, `testSessionLossLimit`, `PositionStore`, `pnl.ts`, `logic-test.ts`, `walletRoster.ts`, `WalletWatcher`?**
  _High betweenness centrality (0.054) - this node is a cross-community bridge._
- **Why does `WalletRoster` connect `WalletRoster` to `PositionStore`, `pnl.ts`, `logic-test.ts`, `walletRoster.ts`, `WalletWatcher`, `main`?**
  _High betweenness centrality (0.054) - this node is a cross-community bridge._
- **Are the 29 inferred relationships involving `main()` (e.g. with `.statusLine()` and `.all()`) actually correct?**
  _`main()` has 29 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `shortAddress()` (e.g. with `main()` and `.maybeDiscover()`) actually correct?**
  _`shortAddress()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _118 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `trader.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06956521739130435 - nodes in this community are weakly interconnected._