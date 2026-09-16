# Graph Report - khedma  (2026-09-16)

## Corpus Check
- 19 files · ~14,060 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 180 nodes · 464 edges · 10 communities
- Extraction: 88% EXTRACTED · 12% INFERRED · 0% AMBIGUOUS · INFERRED: 56 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `6bef3a32`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- package.json
- jupiter.ts
- watcher.ts
- logic-test.ts
- PositionStore
- Trader
- notify.ts
- compilerOptions
- Setup (Mac, Terminal, step by step)
- pnl.ts

## God Nodes (most connected - your core abstractions)
1. `PositionStore` - 32 edges
2. `Trader` - 20 edges
3. `main()` - 19 edges
4. `RateLimiter` - 15 edges
5. `Position` - 15 edges
6. `loadConfig()` - 13 edges
7. `WalletWatcher` - 13 edges
8. `JupiterClient` - 12 edges
9. `printSummary()` - 12 edges
10. `main()` - 12 edges

## Surprising Connections (you probably didn't know these)
- `testAbandonedFreesSlot()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testBalanceCheckRetriesTransientFailure()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testSellUsesOnChainBalance()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testTrader()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testNotifySounds()` --calls--> `soundFor()`  [EXTRACTED]
  test/logic-test.ts → src/notify.ts

## Import Cycles
- None detected.

## Communities (10 total, 0 thin omitted)

### Community 0 - "package.json"
Cohesion: 0.08
Nodes (24): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js, description, devDependencies (+16 more)

### Community 1 - "jupiter.ts"
Cohesion: 0.27
Nodes (6): JupiterClient, JupiterError, JupiterErrorKind, JupiterOrder, looksLikeNoRoute(), OrderParams

### Community 2 - "watcher.ts"
Cohesion: 0.17
Nodes (19): bip39, bs58, ed25519-hd-key, @solana/web3.js, Config, fail(), loadConfig(), numberEnv() (+11 more)

### Community 3 - "logic-test.ts"
Cohesion: 0.14
Nodes (13): reportWatcherHealth(), RateLimiter, decideShutdown(), ShutdownDecision, analyzeSwap(), WalletWatcher, main(), makeTx() (+5 more)

### Community 4 - "PositionStore"
Cohesion: 0.26
Nodes (9): PositionStore, Position, main(), testAbandonedFreesSlot(), testBalanceCheckRetriesTransientFailure(), testMarkToMarket(), testSellUsesOnChainBalance(), testSummary() (+1 more)

### Community 5 - "Trader"
Cohesion: 0.25
Nodes (6): main(), quietenRpcRetryLogs(), main(), Trader, SwapEvent, testTrader()

### Community 6 - "notify.ts"
Cohesion: 0.33
Nodes (9): DEFAULT_SOUNDS, ENV_KEYS, flagOff(), notify(), NotifyKind, playSound(), sanitize(), showBanner() (+1 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Setup (Mac, Terminal, step by step)"
Cohesion: 0.14
Nodes (13): 1. Check that Node.js is installed, 2. Get the code and install dependencies, 3. Create your .env file, 4. Run the bot (dry-run), 5. Stopping the bot, 6. Going live (only when you're ready), How it decides what is a "buy" or "sell", Safety features (on by default) (+5 more)

### Community 9 - "pnl.ts"
Cohesion: 0.26
Nodes (9): formatSol(), heldPercent(), Mark, markToMarket(), printGroup(), printSummary(), getSolPriceUsd(), PositionStatus (+1 more)

## Knowledge Gaps
- **52 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+47 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 58 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@solana/web3.js` connect `watcher.ts` to `package.json`, `logic-test.ts`?**
  _High betweenness centrality (0.150) - this node is a cross-community bridge._
- **Why does `PositionStore` connect `PositionStore` to `jupiter.ts`, `watcher.ts`, `logic-test.ts`, `Trader`, `pnl.ts`?**
  _High betweenness centrality (0.088) - this node is a cross-community bridge._
- **Why does `Trader` connect `Trader` to `jupiter.ts`, `watcher.ts`, `logic-test.ts`, `PositionStore`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **Are the 7 inferred relationships involving `main()` (e.g. with `.byStatus()` and `.load()`) actually correct?**
  _`main()` has 7 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _52 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `logic-test.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1396011396011396 - nodes in this community are weakly interconnected._