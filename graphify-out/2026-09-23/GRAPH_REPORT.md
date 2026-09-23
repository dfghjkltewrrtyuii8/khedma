# Graph Report - khedma  (2026-09-23)

## Corpus Check
- 34 files · ~49,676 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 466 nodes · 1463 edges · 13 communities
- Extraction: 88% EXTRACTED · 12% INFERRED · 0% AMBIGUOUS · INFERRED: 181 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `841dccea`
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
- RateLimiter
- telegramSetup.ts
- main

## God Nodes (most connected - your core abstractions)
1. `main()` - 54 edges
2. `PositionStore` - 50 edges
3. `Trader` - 37 edges
4. `main()` - 32 edges
5. `main()` - 32 edges
6. `Position` - 31 edges
7. `shortAddress()` - 31 edges
8. `loadConfig()` - 27 edges
9. `WalletRoster` - 24 edges
10. `sleep()` - 20 edges

## Surprising Connections (you probably didn't know these)
- `testActiveWalletFilter()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testSourceTracking()` --calls--> `compareToSource()`  [EXTRACTED]
  test/logic-test.ts → src/copyGap.ts
- `testMarkToMarket()` --calls--> `printSummary()`  [EXTRACTED]
  test/logic-test.ts → src/pnl.ts
- `testSummary()` --calls--> `printSummary()`  [EXTRACTED]
  test/logic-test.ts → src/pnl.ts
- `testActiveWalletFilter()` --calls--> `PositionStore`  [EXTRACTED]
  test/logic-test.ts → src/positions.ts

## Import Cycles
- None detected.

## Communities (13 total, 0 thin omitted)

### Community 0 - "scripts"
Cohesion: 0.18
Nodes (11): scripts, alerts, discover, doctor, setup, start, summary, telegram (+3 more)

### Community 1 - "walletRoster.ts"
Cohesion: 0.12
Nodes (15): main(), Candidate, main(), BuyControl, DiscoveryHook, dropReason(), printRoster(), PROBATION_TRADES (+7 more)

### Community 2 - "setup.ts"
Cohesion: 0.07
Nodes (44): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js, description, devDependencies (+36 more)

### Community 3 - "pnl.ts"
Cohesion: 0.13
Nodes (27): avg(), compareToSource(), CopyComparison, entryPhrase(), pct(), priceOf(), summarizeComparisons(), WalletComparison (+19 more)

### Community 4 - "PositionStore"
Cohesion: 0.11
Nodes (22): loadConfig(), PositionStore, Trader, Position, SwapEvent, main(), main(), okMarket() (+14 more)

### Community 5 - "trader.ts"
Cohesion: 0.10
Nodes (27): Config, fail(), numberEnv(), requireEnv(), TradeAlerts, tradeAlertsEnv(), USDT_MINT, JupiterClient (+19 more)

### Community 6 - "logic-test.ts"
Cohesion: 0.08
Nodes (54): main(), SEQUENCE, SOL_MINT, USDC_MINT, fetchGeckoTerminal(), ago(), bad(), checkWebSocket() (+46 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Solana Copy-Trading Bot"
Cohesion: 0.09
Nodes (22): 1. Check that Node.js is installed, 2. Get the code, 3. Run the setup wizard, 4. Check everything before it runs, 5. Run the bot (dry-run), 6. Stopping the bot, 7. Going live (only when you're ready), Automatic wallet discovery (`DISCOVERY=true`) (+14 more)

### Community 9 - "discovery.ts"
Cohesion: 0.17
Nodes (21): QUOTE_MINTS, bump(), discoverWallets(), DISCOVERY_RULES, DiscoveryReport, FetchJson, fetchPolitely(), findCandidates() (+13 more)

### Community 10 - "RateLimiter"
Cohesion: 0.17
Nodes (7): RateLimiter, analyzeSwap(), WalletWatcher, testActiveWalletFilter(), testRateLimiter(), testTransactionVersions(), testWatcherQueue()

### Community 11 - "telegramSetup.ts"
Cohesion: 0.09
Nodes (23): createPrompter(), ask(), askHidden(), askYesNo(), nextLine(), Prompter, sleep(), isTelegramToken() (+15 more)

### Community 12 - "main"
Cohesion: 0.12
Nodes (36): printDiscoveryReport(), main(), quietenRpcRetryLogs(), reportWatcherHealth(), decideShutdown(), ShutdownDecision, ApiReply, clock() (+28 more)

## Knowledge Gaps
- **100 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+95 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 114 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@solana/web3.js` connect `setup.ts` to `discovery.ts`, `main`, `trader.ts`, `logic-test.ts`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **Why does `shortAddress()` connect `main` to `walletRoster.ts`, `setup.ts`, `pnl.ts`, `PositionStore`, `trader.ts`, `logic-test.ts`, `RateLimiter`?**
  _High betweenness centrality (0.056) - this node is a cross-community bridge._
- **Why does `main()` connect `main` to `walletRoster.ts`, `setup.ts`, `pnl.ts`, `PositionStore`, `trader.ts`, `logic-test.ts`, `discovery.ts`, `RateLimiter`, `telegramSetup.ts`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **Are the 19 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 19 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `main()` (e.g. with `.getOrder()` and `.getMe()`) actually correct?**
  _`main()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _100 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `walletRoster.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1202020202020202 - nodes in this community are weakly interconnected._