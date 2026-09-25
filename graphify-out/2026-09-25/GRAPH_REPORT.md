# Graph Report - khedma  (2026-09-25)

## Corpus Check
- 37 files · ~61,445 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 538 nodes · 1781 edges · 13 communities
- Extraction: 86% EXTRACTED · 14% INFERRED · 0% AMBIGUOUS · INFERRED: 243 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `bf0e8d03`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- package.json
- shortAddress
- setupChecks.ts
- index.ts
- PositionStore
- pnl.ts
- notify.ts
- compilerOptions
- Solana Copy-Trading Bot
- discovery.ts
- main
- logic-test.ts
- telegramSetup.ts

## God Nodes (most connected - your core abstractions)
1. `main()` - 66 edges
2. `PositionStore` - 63 edges
3. `Trader` - 45 edges
4. `main()` - 39 edges
5. `main()` - 37 edges
6. `shortAddress()` - 36 edges
7. `Position` - 35 edges
8. `loadConfig()` - 33 edges
9. `WalletWatcher` - 30 edges
10. `WalletRoster` - 29 edges

## Surprising Connections (you probably didn't know these)
- `testActiveWalletFilter()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testEmptySlotsFill()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testStaleBenchAndTrial()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testSourceTracking()` --calls--> `compareToSource()`  [EXTRACTED]
  test/logic-test.ts → src/copyGap.ts
- `testMarkToMarket()` --calls--> `printSummary()`  [EXTRACTED]
  test/logic-test.ts → src/pnl.ts

## Import Cycles
- None detected.

## Communities (13 total, 0 thin omitted)

### Community 0 - "package.json"
Cohesion: 0.06
Nodes (33): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js, description, devDependencies (+25 more)

### Community 1 - "shortAddress"
Cohesion: 0.10
Nodes (20): main(), Candidate, printDiscoveryReport(), main(), BuyControl, copySlots(), DiscoveryHook, dropReason() (+12 more)

### Community 2 - "setupChecks.ts"
Cohesion: 0.09
Nodes (30): createPrompter(), ask(), askHidden(), askYesNo(), nextLine(), Prompter, ENV_PATH, main() (+22 more)

### Community 3 - "index.ts"
Cohesion: 0.05
Nodes (72): @solana/web3.js, Config, fail(), numberEnv(), requireEnv(), SOL_MINT, TradeAlerts, tradeAlertsEnv() (+64 more)

### Community 4 - "PositionStore"
Cohesion: 0.10
Nodes (25): loadConfig(), notify(), PositionStore, Trader, Position, SwapEvent, main(), main() (+17 more)

### Community 5 - "pnl.ts"
Cohesion: 0.11
Nodes (30): avg(), compareToSource(), CopyComparison, entryPhrase(), pct(), priceOf(), summarizeComparisons(), WalletComparison (+22 more)

### Community 6 - "notify.ts"
Cohesion: 0.14
Nodes (24): main(), SEQUENCE, DEFAULT_PHRASES, DEFAULT_SOUNDS, flagOff(), NotifyKind, playAlert(), previewAlert() (+16 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Solana Copy-Trading Bot"
Cohesion: 0.08
Nodes (23): 1. Check that Node.js is installed, 2. Get the code, 3. Run the setup wizard, 4. Check everything before it runs, 5. Run the bot (dry-run), 6. Stopping the bot, 7. Going live (only when you're ready), Automatic wallet discovery (`DISCOVERY=true`) (+15 more)

### Community 9 - "discovery.ts"
Cohesion: 0.16
Nodes (22): QUOTE_MINTS, bump(), discoverWallets(), DISCOVERY_RULES, DiscoveryReport, fetchGeckoTerminal(), FetchJson, fetchPolitely() (+14 more)

### Community 10 - "main"
Cohesion: 0.14
Nodes (13): main(), quietenRpcRetryLogs(), reportWatcherHealth(), RateLimiter, analyzeSwap(), WalletWatcher, testActiveWalletFilter(), testActivityCheck() (+5 more)

### Community 11 - "logic-test.ts"
Cohesion: 0.08
Nodes (43): bs58, decideShutdown(), ShutdownDecision, allQuiet(), ApiReply, clock(), closedAt(), CommandHandlers (+35 more)

### Community 12 - "telegramSetup.ts"
Cohesion: 0.13
Nodes (16): sleep(), isTelegramToken(), upsertEnv(), errorKind(), explainTelegramError(), helpText(), TelegramBot, TelegramClient (+8 more)

## Knowledge Gaps
- **113 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+108 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 127 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `PositionStore` connect `PositionStore` to `shortAddress`, `index.ts`, `pnl.ts`, `main`, `logic-test.ts`?**
  _High betweenness centrality (0.058) - this node is a cross-community bridge._
- **Why does `@solana/web3.js` connect `index.ts` to `package.json`, `discovery.ts`, `setupChecks.ts`, `logic-test.ts`?**
  _High betweenness centrality (0.056) - this node is a cross-community bridge._
- **Why does `main()` connect `main` to `shortAddress`, `index.ts`, `PositionStore`, `pnl.ts`, `discovery.ts`, `logic-test.ts`, `telegramSetup.ts`?**
  _High betweenness centrality (0.053) - this node is a cross-community bridge._
- **Are the 26 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 26 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `main()` (e.g. with `.getOrder()` and `.getMe()`) actually correct?**
  _`main()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _113 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.058823529411764705 - nodes in this community are weakly interconnected._