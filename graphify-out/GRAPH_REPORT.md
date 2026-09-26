# Graph Report - khedma  (2026-09-26)

## Corpus Check
- 38 files · ~74,353 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 594 nodes · 2089 edges · 17 communities
- Extraction: 84% EXTRACTED · 16% INFERRED · 0% AMBIGUOUS · INFERRED: 337 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `d55103ab`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- scripts
- WalletRoster
- setupChecks.ts
- discovery.ts
- logic-test.ts
- pnl.ts
- notify.ts
- compilerOptions
- Solana Copy-Trading Bot
- doctor.ts
- main
- index.ts
- package.json
- tokenAccounts.ts
- createPrompter
- dependencies
- applyRecommended

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

## Communities (17 total, 0 thin omitted)

### Community 0 - "scripts"
Cohesion: 0.15
Nodes (13): scripts, alerts, discover, doctor, reclaim, recommended, setup, start (+5 more)

### Community 1 - "WalletRoster"
Cohesion: 0.07
Nodes (32): main(), Candidate, printDiscoveryReport(), main(), BuyControl, copySlots(), DiscoveryHook, dropReason() (+24 more)

### Community 2 - "setupChecks.ts"
Cohesion: 0.17
Nodes (21): dotenv, { ask, askHidden, askYesNo, done }, bail(), deriveAddress(), ENV_PATH, main(), say(), stamp() (+13 more)

### Community 3 - "discovery.ts"
Cohesion: 0.19
Nodes (20): bump(), discoverWallets(), DISCOVERY_RULES, DiscoveryReport, FetchJson, fetchPolitely(), findCandidates(), holdText() (+12 more)

### Community 4 - "logic-test.ts"
Cohesion: 0.08
Nodes (33): loadConfig(), PositionStore, sleep(), decideShutdown(), ShutdownDecision, selectEmpty(), Trader, Position (+25 more)

### Community 5 - "pnl.ts"
Cohesion: 0.13
Nodes (28): avg(), compareToSource(), CopyComparison, entryPhrase(), pct(), priceOf(), summarizeComparisons(), WalletComparison (+20 more)

### Community 6 - "notify.ts"
Cohesion: 0.15
Nodes (24): main(), SEQUENCE, DEFAULT_PHRASES, DEFAULT_SOUNDS, flagOff(), notify(), NotifyKind, playAlert() (+16 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Solana Copy-Trading Bot"
Cohesion: 0.08
Nodes (23): 1. Check that Node.js is installed, 2. Get the code, 3. Run the setup wizard, 4. Check everything before it runs, 5. Run the bot (dry-run), 6. Stopping the bot, 7. Going live (only when you're ready), Automatic wallet discovery (`DISCOVERY=true`) (+15 more)

### Community 9 - "doctor.ts"
Cohesion: 0.06
Nodes (60): Config, fail(), numberEnv(), QUOTE_MINTS, requireEnv(), SOL_MINT, TradeAlerts, tradeAlertsEnv() (+52 more)

### Community 10 - "main"
Cohesion: 0.11
Nodes (20): main(), RateLimiter, HistoryTrade, judgeHistory(), median(), minutesText(), VET_RULES, VetConnection (+12 more)

### Community 11 - "index.ts"
Cohesion: 0.06
Nodes (52): quietenRpcRetryLogs(), reportWatcherHealth(), TOKEN_ACCOUNT_RENT_SOL, isTelegramToken(), upsertEnv(), allQuiet(), ApiReply, clock() (+44 more)

### Community 12 - "package.json"
Cohesion: 0.12
Nodes (17): description, devDependencies, tsx, @types/node, typescript, name, private, version (+9 more)

### Community 13 - "tokenAccounts.ts"
Cohesion: 0.19
Nodes (14): main(), getSolPriceUsd(), closeAccountInstruction(), closeAccounts(), CloseResult, EmptyAccount, findEmptyAccounts(), goneFromChain() (+6 more)

### Community 14 - "createPrompter"
Cohesion: 0.24
Nodes (6): createPrompter(), ask(), askHidden(), askYesNo(), nextLine(), Prompter

### Community 15 - "dependencies"
Cohesion: 0.33
Nodes (6): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js

### Community 16 - "applyRecommended"
Cohesion: 0.67
Nodes (3): ENV_PATH, main(), applyRecommended()

## Knowledge Gaps
- **118 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+113 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 132 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `shortAddress()` connect `WalletRoster` to `setupChecks.ts`, `logic-test.ts`, `pnl.ts`, `doctor.ts`, `main`, `index.ts`?**
  _High betweenness centrality (0.061) - this node is a cross-community bridge._
- **Why does `WalletRoster` connect `WalletRoster` to `main`, `index.ts`, `logic-test.ts`?**
  _High betweenness centrality (0.056) - this node is a cross-community bridge._
- **Why does `PositionStore` connect `logic-test.ts` to `WalletRoster`, `pnl.ts`, `doctor.ts`, `main`, `index.ts`, `tokenAccounts.ts`?**
  _High betweenness centrality (0.054) - this node is a cross-community bridge._
- **Are the 27 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 27 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `shortAddress()` (e.g. with `main()` and `.maybeDiscover()`) actually correct?**
  _`shortAddress()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _118 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `WalletRoster` be split into smaller, more focused modules?**
  _Cohesion score 0.07277628032345014 - nodes in this community are weakly interconnected._