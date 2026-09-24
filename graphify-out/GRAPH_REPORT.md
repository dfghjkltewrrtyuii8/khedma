# Graph Report - khedma  (2026-09-24)

## Corpus Check
- 35 files · ~57,343 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 513 nodes · 1686 edges · 13 communities
- Extraction: 86% EXTRACTED · 14% INFERRED · 0% AMBIGUOUS · INFERRED: 233 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b77086bb`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- scripts
- shortAddress
- setupChecks.ts
- index.ts
- PositionStore
- copyGap.ts
- doctor.ts
- compilerOptions
- Solana Copy-Trading Bot
- discovery.ts
- main
- logic-test.ts
- telegramSetup.ts

## God Nodes (most connected - your core abstractions)
1. `main()` - 65 edges
2. `PositionStore` - 59 edges
3. `main()` - 38 edges
4. `Trader` - 37 edges
5. `main()` - 36 edges
6. `shortAddress()` - 36 edges
7. `Position` - 31 edges
8. `loadConfig()` - 30 edges
9. `WalletWatcher` - 30 edges
10. `WalletRoster` - 29 edges

## Surprising Connections (you probably didn't know these)
- `testEmptySlotsFill()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testStaleBenchAndTrial()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testSourceTracking()` --calls--> `compareToSource()`  [EXTRACTED]
  test/logic-test.ts → src/copyGap.ts
- `testExitDecisions()` --calls--> `decideExit()`  [EXTRACTED]
  test/logic-test.ts → src/exitRules.ts
- `testNotifySounds()` --calls--> `soundFor()`  [EXTRACTED]
  test/logic-test.ts → src/notify.ts

## Import Cycles
- None detected.

## Communities (13 total, 0 thin omitted)

### Community 0 - "scripts"
Cohesion: 0.17
Nodes (12): scripts, alerts, discover, doctor, recommended, setup, start, summary (+4 more)

### Community 1 - "shortAddress"
Cohesion: 0.12
Nodes (16): main(), printDiscoveryReport(), main(), BuyControl, copySlots(), dropReason(), printRoster(), Rotation (+8 more)

### Community 2 - "setupChecks.ts"
Cohesion: 0.05
Nodes (50): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js, description, devDependencies (+42 more)

### Community 3 - "index.ts"
Cohesion: 0.06
Nodes (59): @solana/web3.js, Config, fail(), numberEnv(), QUOTE_MINTS, requireEnv(), SOL_MINT, tradeAlertsEnv() (+51 more)

### Community 4 - "PositionStore"
Cohesion: 0.10
Nodes (25): loadConfig(), PositionStore, Trader, Position, SwapEvent, main(), main(), okMarket() (+17 more)

### Community 5 - "copyGap.ts"
Cohesion: 0.36
Nodes (9): avg(), compareToSource(), CopyComparison, entryPhrase(), pct(), priceOf(), summarizeComparisons(), WalletComparison (+1 more)

### Community 6 - "doctor.ts"
Cohesion: 0.11
Nodes (40): main(), SEQUENCE, fetchGeckoTerminal(), ago(), bad(), checkWebSocket(), finish(), main() (+32 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Solana Copy-Trading Bot"
Cohesion: 0.09
Nodes (22): 1. Check that Node.js is installed, 2. Get the code, 3. Run the setup wizard, 4. Check everything before it runs, 5. Run the bot (dry-run), 6. Stopping the bot, 7. Going live (only when you're ready), Automatic wallet discovery (`DISCOVERY=true`) (+14 more)

### Community 9 - "discovery.ts"
Cohesion: 0.15
Nodes (22): bump(), Candidate, discoverWallets(), DISCOVERY_RULES, DiscoveryReport, FetchJson, fetchPolitely(), findCandidates() (+14 more)

### Community 10 - "main"
Cohesion: 0.13
Nodes (11): main(), quietenRpcRetryLogs(), reportWatcherHealth(), RateLimiter, installedWeb3Version(), versionAtLeast(), WalletWatcher, testActivityCheck() (+3 more)

### Community 11 - "logic-test.ts"
Cohesion: 0.07
Nodes (51): bs58, TradeAlerts, JupiterOrder, OrderParams, WINDOWS_ALERT_SCRIPT, allRunsLine(), TOKEN_ACCOUNT_RENT_SOL, decideShutdown() (+43 more)

### Community 12 - "telegramSetup.ts"
Cohesion: 0.12
Nodes (18): sleep(), isTelegramToken(), upsertEnv(), errorKind(), explainTelegramError(), helpText(), TelegramBot, TelegramClient (+10 more)

## Knowledge Gaps
- **108 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+103 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 122 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `shortAddress()` connect `shortAddress` to `setupChecks.ts`, `index.ts`, `PositionStore`, `doctor.ts`, `main`, `logic-test.ts`?**
  _High betweenness centrality (0.060) - this node is a cross-community bridge._
- **Why does `main()` connect `main` to `shortAddress`, `setupChecks.ts`, `index.ts`, `PositionStore`, `doctor.ts`, `discovery.ts`, `logic-test.ts`, `telegramSetup.ts`?**
  _High betweenness centrality (0.055) - this node is a cross-community bridge._
- **Why does `@solana/web3.js` connect `index.ts` to `discovery.ts`, `setupChecks.ts`, `logic-test.ts`, `doctor.ts`?**
  _High betweenness centrality (0.053) - this node is a cross-community bridge._
- **Are the 25 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 25 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `main()` (e.g. with `.getOrder()` and `.getMe()`) actually correct?**
  _`main()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _108 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `shortAddress` be split into smaller, more focused modules?**
  _Cohesion score 0.11828737300435414 - nodes in this community are weakly interconnected._