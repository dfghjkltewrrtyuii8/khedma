# Graph Report - khedma  (2026-09-23)

## Corpus Check
- 27 files · ~28,742 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 291 nodes · 845 edges · 10 communities
- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS · INFERRED: 82 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `fa315e91`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- package.json
- RateLimiter
- logic-test.ts
- PositionStore
- trader.ts
- doctor.ts
- compilerOptions
- Solana Copy-Trading Bot
- watcher.ts
- index.ts

## God Nodes (most connected - your core abstractions)
1. `PositionStore` - 37 edges
2. `main()` - 28 edges
3. `main()` - 26 edges
4. `Trader` - 25 edges
5. `main()` - 22 edges
6. `Position` - 21 edges
7. `loadConfig()` - 18 edges
8. `RateLimiter` - 18 edges
9. `shortAddress()` - 16 edges
10. `JupiterClient` - 14 edges

## Surprising Connections (you probably didn't know these)
- `testAbandonedFreesSlot()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testBalanceCheckRetriesTransientFailure()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testExitsInTrader()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testGatesInTrader()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testSellUsesOnChainBalance()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts

## Import Cycles
- None detected.

## Communities (10 total, 0 thin omitted)

### Community 0 - "package.json"
Cohesion: 0.07
Nodes (28): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js, description, devDependencies (+20 more)

### Community 1 - "RateLimiter"
Cohesion: 0.17
Nodes (9): JupiterClient, JupiterError, JupiterErrorKind, JupiterOrder, looksLikeNoRoute(), OrderParams, RateLimiter, sleep() (+1 more)

### Community 2 - "logic-test.ts"
Cohesion: 0.11
Nodes (35): bip39, bs58, @solana/web3.js, ask(), askHidden(), askYesNo(), bail(), deriveAddress() (+27 more)

### Community 4 - "PositionStore"
Cohesion: 0.14
Nodes (17): PositionStore, Trader, Position, SwapEvent, shortAddress(), main(), main(), okMarket() (+9 more)

### Community 5 - "trader.ts"
Cohesion: 0.12
Nodes (22): Config, decideExit(), ExitCandidate, ExitConfig, ExitDecision, pct(), cache, describeAge() (+14 more)

### Community 6 - "doctor.ts"
Cohesion: 0.13
Nodes (32): main(), SEQUENCE, ago(), bad(), checkWebSocket(), finish(), main(), ok() (+24 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Solana Copy-Trading Bot"
Cohesion: 0.10
Nodes (19): 1. Check that Node.js is installed, 2. Get the code, 3. Run the setup wizard, 4. Check everything before it runs, 5. Run the bot (dry-run), 6. Stopping the bot, 7. Going live (only when you're ready), Every setting (reference) (+11 more)

### Community 9 - "watcher.ts"
Cohesion: 0.12
Nodes (28): fail(), loadConfig(), numberEnv(), QUOTE_MINTS, requireEnv(), SOL_MINT, USDC_MINT, USDT_MINT (+20 more)

### Community 10 - "index.ts"
Cohesion: 0.19
Nodes (15): describeExitRules(), exitRulesEnabled(), main(), quietenRpcRetryLogs(), reportWatcherHealth(), decideShutdown(), ShutdownDecision, loadKeypair() (+7 more)

## Knowledge Gaps
- **81 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+76 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 87 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@solana/web3.js` connect `logic-test.ts` to `package.json`, `trader.ts`, `doctor.ts`, `watcher.ts`, `index.ts`?**
  _High betweenness centrality (0.078) - this node is a cross-community bridge._
- **Why does `PositionStore` connect `PositionStore` to `watcher.ts`, `index.ts`, `logic-test.ts`, `trader.ts`?**
  _High betweenness centrality (0.055) - this node is a cross-community bridge._
- **Are the 9 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 9 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _81 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.06896551724137931 - nodes in this community are weakly interconnected._
- **Should `logic-test.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.10512820512820513 - nodes in this community are weakly interconnected._
- **Should `PositionStore` be split into smaller, more focused modules?**
  _Cohesion score 0.13918439716312056 - nodes in this community are weakly interconnected._