# Graph Report - khedma  (2026-09-24)

## Corpus Check
- 35 files · ~55,835 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 508 nodes · 1647 edges · 18 communities (17 shown, 1 thin omitted)
- Extraction: 87% EXTRACTED · 13% INFERRED · 0% AMBIGUOUS · INFERRED: 221 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1ce2c2c5`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- scripts
- shortAddress
- setup.ts
- index.ts
- main
- copyGap.ts
- logic-test.ts
- compilerOptions
- Solana Copy-Trading Bot
- discovery.ts
- WalletWatcher
- telegram.ts
- Prompter
- package.json
- setupChecks.ts
- dependencies
- createPrompter
- bs58

## God Nodes (most connected - your core abstractions)
1. `main()` - 64 edges
2. `PositionStore` - 58 edges
3. `Trader` - 37 edges
4. `main()` - 37 edges
5. `main()` - 35 edges
6. `shortAddress()` - 35 edges
7. `Position` - 31 edges
8. `loadConfig()` - 29 edges
9. `WalletWatcher` - 29 edges
10. `WalletRoster` - 28 edges

## Surprising Connections (you probably didn't know these)
- `testActiveWalletFilter()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testEmptySlotsFill()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testSourceTracking()` --calls--> `compareToSource()`  [EXTRACTED]
  test/logic-test.ts → src/copyGap.ts
- `testExitDecisions()` --calls--> `decideExit()`  [EXTRACTED]
  test/logic-test.ts → src/exitRules.ts
- `testMarkToMarket()` --calls--> `printSummary()`  [EXTRACTED]
  test/logic-test.ts → src/pnl.ts

## Import Cycles
- None detected.

## Communities (18 total, 1 thin omitted)

### Community 0 - "scripts"
Cohesion: 0.17
Nodes (12): scripts, alerts, discover, doctor, recommended, setup, start, summary (+4 more)

### Community 1 - "shortAddress"
Cohesion: 0.14
Nodes (12): main(), BuyControl, dropReason(), printRoster(), Rotation, WalletRoster, WatchControl, shortAddress() (+4 more)

### Community 2 - "setup.ts"
Cohesion: 0.22
Nodes (16): dotenv, { ask, askHidden, askYesNo, done }, bail(), deriveAddress(), ENV_PATH, main(), say(), stamp() (+8 more)

### Community 3 - "index.ts"
Cohesion: 0.07
Nodes (46): @solana/web3.js, Config, fail(), numberEnv(), requireEnv(), SOL_MINT, tradeAlertsEnv(), USDC_MINT (+38 more)

### Community 4 - "main"
Cohesion: 0.10
Nodes (27): loadConfig(), main(), quietenRpcRetryLogs(), PositionStore, main(), Trader, Position, SwapEvent (+19 more)

### Community 5 - "copyGap.ts"
Cohesion: 0.25
Nodes (13): avg(), compareToSource(), CopyComparison, entryPhrase(), pct(), priceOf(), summarizeComparisons(), WalletComparison (+5 more)

### Community 6 - "logic-test.ts"
Cohesion: 0.07
Nodes (63): main(), SEQUENCE, fetchGeckoTerminal(), ago(), bad(), checkWebSocket(), finish(), main() (+55 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Solana Copy-Trading Bot"
Cohesion: 0.09
Nodes (22): 1. Check that Node.js is installed, 2. Get the code, 3. Run the setup wizard, 4. Check everything before it runs, 5. Run the bot (dry-run), 6. Stopping the bot, 7. Going live (only when you're ready), Automatic wallet discovery (`DISCOVERY=true`) (+14 more)

### Community 9 - "discovery.ts"
Cohesion: 0.14
Nodes (23): QUOTE_MINTS, bump(), Candidate, discoverWallets(), DISCOVERY_RULES, DiscoveryReport, FetchJson, fetchPolitely() (+15 more)

### Community 10 - "WalletWatcher"
Cohesion: 0.15
Nodes (8): RateLimiter, analyzeSwap(), WalletWatcher, testActiveWalletFilter(), testActivityCheck(), testRateLimiter(), testTransactionVersions(), testWatcherQueue()

### Community 11 - "telegram.ts"
Cohesion: 0.06
Nodes (54): TradeAlerts, reportWatcherHealth(), allRunsLine(), formatSol(), TOKEN_ACCOUNT_RENT_SOL, sleep(), isTelegramToken(), upsertEnv() (+46 more)

### Community 13 - "package.json"
Cohesion: 0.14
Nodes (13): description, devDependencies, tsx, @types/node, typescript, name, private, version (+5 more)

### Community 14 - "setupChecks.ts"
Cohesion: 0.22
Nodes (9): ENV_PATH, main(), applyRecommended(), EnvValues, PLACEHOLDER_MARKERS, RECOMMENDED_SETTINGS, REQUIRED_KEYS, SettingChange (+1 more)

### Community 15 - "dependencies"
Cohesion: 0.33
Nodes (6): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js

### Community 16 - "createPrompter"
Cohesion: 0.70
Nodes (5): createPrompter(), ask(), askHidden(), askYesNo(), nextLine()

### Community 17 - "bs58"
Cohesion: 0.50
Nodes (3): bs58, TEST_ENV, TEST_WALLET

## Knowledge Gaps
- **108 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+103 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 122 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `shortAddress()` connect `shortAddress` to `setup.ts`, `index.ts`, `main`, `copyGap.ts`, `logic-test.ts`, `WalletWatcher`, `telegram.ts`?**
  _High betweenness centrality (0.059) - this node is a cross-community bridge._
- **Why does `main()` connect `main` to `shortAddress`, `setup.ts`, `index.ts`, `logic-test.ts`, `discovery.ts`, `WalletWatcher`, `telegram.ts`?**
  _High betweenness centrality (0.055) - this node is a cross-community bridge._
- **Why does `@solana/web3.js` connect `index.ts` to `logic-test.ts`, `discovery.ts`, `package.json`, `setupChecks.ts`, `bs58`?**
  _High betweenness centrality (0.054) - this node is a cross-community bridge._
- **Are the 25 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 25 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `main()` (e.g. with `.getOrder()` and `.getMe()`) actually correct?**
  _`main()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _108 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `shortAddress` be split into smaller, more focused modules?**
  _Cohesion score 0.1406423034330011 - nodes in this community are weakly interconnected._