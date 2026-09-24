# Graph Report - khedma  (2026-09-23)

## Corpus Check
- 34 files · ~50,476 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 469 nodes · 1496 edges · 12 communities
- Extraction: 88% EXTRACTED · 12% INFERRED · 0% AMBIGUOUS · INFERRED: 186 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `f41b3912`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- scripts
- walletRoster.ts
- setup.ts
- pnl.ts
- PositionStore
- doctor.ts
- logic-test.ts
- compilerOptions
- Solana Copy-Trading Bot
- discovery.ts
- RateLimiter
- main

## God Nodes (most connected - your core abstractions)
1. `main()` - 56 edges
2. `PositionStore` - 51 edges
3. `Trader` - 37 edges
4. `main()` - 34 edges
5. `main()` - 33 edges
6. `shortAddress()` - 32 edges
7. `Position` - 31 edges
8. `loadConfig()` - 28 edges
9. `WalletRoster` - 25 edges
10. `sleep()` - 20 edges

## Surprising Connections (you probably didn't know these)
- `testActiveWalletFilter()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testEmptySlotsFill()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testSourceTracking()` --calls--> `compareToSource()`  [EXTRACTED]
  test/logic-test.ts → src/copyGap.ts
- `testMarkToMarket()` --calls--> `printSummary()`  [EXTRACTED]
  test/logic-test.ts → src/pnl.ts
- `testSummary()` --calls--> `printSummary()`  [EXTRACTED]
  test/logic-test.ts → src/pnl.ts

## Import Cycles
- None detected.

## Communities (12 total, 0 thin omitted)

### Community 0 - "scripts"
Cohesion: 0.18
Nodes (11): scripts, alerts, discover, doctor, setup, start, summary, telegram (+3 more)

### Community 1 - "walletRoster.ts"
Cohesion: 0.12
Nodes (18): main(), Candidate, printDiscoveryReport(), main(), BuyControl, copySlots(), DiscoveryHook, dropReason() (+10 more)

### Community 2 - "setup.ts"
Cohesion: 0.05
Nodes (50): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js, description, devDependencies (+42 more)

### Community 3 - "pnl.ts"
Cohesion: 0.14
Nodes (26): avg(), compareToSource(), CopyComparison, entryPhrase(), pct(), priceOf(), summarizeComparisons(), WalletComparison (+18 more)

### Community 4 - "PositionStore"
Cohesion: 0.10
Nodes (25): loadConfig(), PositionStore, ReportInput, TradeEvent, WalletsInput, Trader, Position, SwapEvent (+17 more)

### Community 5 - "doctor.ts"
Cohesion: 0.06
Nodes (54): Config, fail(), numberEnv(), requireEnv(), SOL_MINT, TradeAlerts, tradeAlertsEnv(), USDC_MINT (+46 more)

### Community 6 - "logic-test.ts"
Cohesion: 0.12
Nodes (31): main(), SEQUENCE, DEFAULT_PHRASES, DEFAULT_SOUNDS, flagOff(), notify(), NotifyKind, playAlert() (+23 more)

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

### Community 12 - "main"
Cohesion: 0.08
Nodes (47): main(), quietenRpcRetryLogs(), reportWatcherHealth(), isTelegramToken(), upsertEnv(), decideShutdown(), ShutdownDecision, ApiReply (+39 more)

## Knowledge Gaps
- **100 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+95 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 114 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@solana/web3.js` connect `setup.ts` to `discovery.ts`, `main`, `doctor.ts`, `logic-test.ts`?**
  _High betweenness centrality (0.056) - this node is a cross-community bridge._
- **Why does `shortAddress()` connect `main` to `walletRoster.ts`, `setup.ts`, `pnl.ts`, `PositionStore`, `doctor.ts`, `logic-test.ts`, `RateLimiter`?**
  _High betweenness centrality (0.055) - this node is a cross-community bridge._
- **Why does `main()` connect `main` to `walletRoster.ts`, `setup.ts`, `pnl.ts`, `PositionStore`, `doctor.ts`, `discovery.ts`, `RateLimiter`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **Are the 19 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 19 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `main()` (e.g. with `.getOrder()` and `.getMe()`) actually correct?**
  _`main()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _100 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `walletRoster.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11564625850340136 - nodes in this community are weakly interconnected._