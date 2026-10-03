# Graph Report - khedma  (2026-09-30)

## Corpus Check
- 38 files · ~74,411 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 601 nodes · 2111 edges · 12 communities
- Extraction: 84% EXTRACTED · 16% INFERRED · 0% AMBIGUOUS · INFERRED: 337 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ef8df749`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- WalletRoster
- setupChecks.ts
- discovery.ts
- PositionStore
- pnl.ts
- logic-test.ts
- compilerOptions
- Solana Copy-Trading Bot
- index.ts
- main
- telegram.ts
- package.json

## God Nodes (most connected - your core abstractions)
1. `main()` - 68 edges
2. `PositionStore` - 67 edges
3. `WalletRoster` - 50 edges
4. `shortAddress()` - 47 edges
5. `Trader` - 45 edges
6. `main()` - 43 edges
7. `Rotation` - 41 edges
8. `main()` - 37 edges
9. `Position` - 35 edges
10. `loadConfig()` - 33 edges

## Surprising Connections (you probably didn't know these)
- `testActiveWalletFilter()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testEmptySlotsFill()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testStaleBenchAndTrial()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testSourceTracking()` --calls--> `compareToSource()`  [EXTRACTED]
  test/logic-test.ts → src/copyGap.ts
- `testWinnersFirst()` --calls--> `compareToSource()`  [EXTRACTED]
  test/logic-test.ts → src/copyGap.ts

## Import Cycles
- None detected.

## Communities (12 total, 0 thin omitted)

### Community 1 - "WalletRoster"
Cohesion: 0.08
Nodes (29): main(), Candidate, BuyControl, DiscoveryHook, dropReason(), NO_CONTEXT, printRoster(), PROBATION_TRADES (+21 more)

### Community 2 - "setupChecks.ts"
Cohesion: 0.08
Nodes (29): createPrompter(), ask(), askHidden(), askYesNo(), nextLine(), Prompter, ENV_PATH, main() (+21 more)

### Community 3 - "discovery.ts"
Cohesion: 0.17
Nodes (21): QUOTE_MINTS, bump(), discoverWallets(), DISCOVERY_RULES, DiscoveryReport, FetchJson, fetchPolitely(), findCandidates() (+13 more)

### Community 4 - "PositionStore"
Cohesion: 0.10
Nodes (24): loadConfig(), PositionStore, Trader, Position, SwapEvent, main(), main(), okMarket() (+16 more)

### Community 5 - "pnl.ts"
Cohesion: 0.11
Nodes (30): avg(), compareToSource(), CopyComparison, entryPhrase(), pct(), priceOf(), summarizeComparisons(), WalletComparison (+22 more)

### Community 6 - "logic-test.ts"
Cohesion: 0.07
Nodes (46): bs58, main(), SEQUENCE, DEFAULT_PHRASES, DEFAULT_SOUNDS, flagOff(), notify(), NotifyKind (+38 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Solana Copy-Trading Bot"
Cohesion: 0.08
Nodes (23): 1. Check that Node.js is installed, 2. Get the code, 3. Run the setup wizard, 4. Check everything before it runs, 5. Run the bot (dry-run), 6. Stopping the bot, 7. Going live (only when you're ready), Automatic wallet discovery (`DISCOVERY=true`) (+15 more)

### Community 9 - "index.ts"
Cohesion: 0.05
Nodes (78): @solana/web3.js, Config, fail(), numberEnv(), requireEnv(), SOL_MINT, TradeAlerts, tradeAlertsEnv() (+70 more)

### Community 10 - "main"
Cohesion: 0.17
Nodes (8): main(), quietenRpcRetryLogs(), WalletWatcher, testActiveWalletFilter(), testActivityCheck(), testRobotWallets(), testTransactionVersions(), testWatcherQueue()

### Community 11 - "telegram.ts"
Cohesion: 0.06
Nodes (50): reportWatcherHealth(), TOKEN_ACCOUNT_RENT_SOL, isTelegramToken(), upsertEnv(), allQuiet(), ApiReply, clock(), closedAt() (+42 more)

### Community 12 - "package.json"
Cohesion: 0.06
Nodes (33): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js, description, devDependencies (+25 more)

## Knowledge Gaps
- **118 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+113 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 136 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `shortAddress()` connect `WalletRoster` to `setupChecks.ts`, `PositionStore`, `pnl.ts`, `logic-test.ts`, `index.ts`, `main`, `telegram.ts`?**
  _High betweenness centrality (0.060) - this node is a cross-community bridge._
- **Why does `WalletRoster` connect `WalletRoster` to `index.ts`, `main`, `logic-test.ts`?**
  _High betweenness centrality (0.055) - this node is a cross-community bridge._
- **Why does `PositionStore` connect `PositionStore` to `WalletRoster`, `pnl.ts`, `logic-test.ts`, `index.ts`, `main`?**
  _High betweenness centrality (0.054) - this node is a cross-community bridge._
- **Are the 27 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 27 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `shortAddress()` (e.g. with `main()` and `.maybeDiscover()`) actually correct?**
  _`shortAddress()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _118 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `WalletRoster` be split into smaller, more focused modules?**
  _Cohesion score 0.07777777777777778 - nodes in this community are weakly interconnected._