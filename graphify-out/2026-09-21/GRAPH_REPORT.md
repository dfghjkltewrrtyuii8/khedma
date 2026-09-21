# Graph Report - khedma  (2026-09-21)

## Corpus Check
- 26 files · ~25,973 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 275 nodes · 789 edges · 10 communities
- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS · INFERRED: 79 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `415e750d`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- package.json
- RateLimiter
- logic-test.ts
- PositionStore
- trader.ts
- notify.ts
- compilerOptions
- Setup (Mac, Terminal, step by step)
- doctor.ts
- index.ts

## God Nodes (most connected - your core abstractions)
1. `PositionStore` - 37 edges
2. `main()` - 26 edges
3. `Trader` - 25 edges
4. `main()` - 23 edges
5. `Position` - 21 edges
6. `main()` - 19 edges
7. `loadConfig()` - 17 edges
8. `RateLimiter` - 17 edges
9. `shortAddress()` - 16 edges
10. `JupiterClient` - 14 edges

## Surprising Connections (you probably didn't know these)
- `testMarkToMarket()` --calls--> `printSummary()`  [EXTRACTED]
  test/logic-test.ts → src/pnl.ts
- `testSummary()` --calls--> `printSummary()`  [EXTRACTED]
  test/logic-test.ts → src/pnl.ts
- `testWatcherQueue()` --calls--> `RateLimiter`  [EXTRACTED]
  test/logic-test.ts → src/rateLimiter.ts
- `testSummary()` --calls--> `getSolPriceUsd()`  [EXTRACTED]
  test/logic-test.ts → src/solPrice.ts
- `testAbandonedFreesSlot()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts

## Import Cycles
- None detected.

## Communities (10 total, 0 thin omitted)

### Community 0 - "package.json"
Cohesion: 0.07
Nodes (27): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js, description, devDependencies (+19 more)

### Community 1 - "RateLimiter"
Cohesion: 0.18
Nodes (9): JupiterClient, JupiterError, JupiterErrorKind, JupiterOrder, looksLikeNoRoute(), OrderParams, RateLimiter, sleep() (+1 more)

### Community 2 - "logic-test.ts"
Cohesion: 0.12
Nodes (32): bip39, bs58, ed25519-hd-key, ask(), askHidden(), askYesNo(), bail(), deriveAddress() (+24 more)

### Community 4 - "PositionStore"
Cohesion: 0.14
Nodes (18): loadConfig(), PositionStore, main(), Trader, Position, SwapEvent, main(), main() (+10 more)

### Community 5 - "trader.ts"
Cohesion: 0.11
Nodes (24): Config, decideExit(), describeExitRules(), ExitCandidate, ExitConfig, ExitDecision, exitRulesEnabled(), pct() (+16 more)

### Community 6 - "notify.ts"
Cohesion: 0.19
Nodes (19): main(), SEQUENCE, DEFAULT_PHRASES, DEFAULT_SOUNDS, flagOff(), notify(), NotifyKind, playAlert() (+11 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Setup (Mac, Terminal, step by step)"
Cohesion: 0.11
Nodes (18): 1. Check that Node.js is installed, 2. Get the code, 3. Run the setup wizard, 4. Check everything before it runs, 5. Run the bot (dry-run), 6. Stopping the bot, 7. Going live (only when you're ready), Every setting (reference) (+10 more)

### Community 9 - "doctor.ts"
Cohesion: 0.17
Nodes (21): @solana/web3.js, fail(), numberEnv(), QUOTE_MINTS, requireEnv(), SOL_MINT, USDC_MINT, USDT_MINT (+13 more)

### Community 10 - "index.ts"
Cohesion: 0.12
Nodes (22): main(), quietenRpcRetryLogs(), reportWatcherHealth(), formatSol(), heldPercent(), Mark, markToMarket(), printGroup() (+14 more)

## Knowledge Gaps
- **77 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+72 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 83 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@solana/web3.js` connect `doctor.ts` to `package.json`, `index.ts`, `logic-test.ts`, `trader.ts`?**
  _High betweenness centrality (0.082) - this node is a cross-community bridge._
- **Why does `PositionStore` connect `PositionStore` to `RateLimiter`, `index.ts`, `logic-test.ts`, `trader.ts`?**
  _High betweenness centrality (0.058) - this node is a cross-community bridge._
- **Are the 9 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 9 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _77 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.07142857142857142 - nodes in this community are weakly interconnected._
- **Should `logic-test.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11587301587301588 - nodes in this community are weakly interconnected._
- **Should `PositionStore` be split into smaller, more focused modules?**
  _Cohesion score 0.14184397163120568 - nodes in this community are weakly interconnected._