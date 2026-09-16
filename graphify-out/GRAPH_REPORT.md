# Graph Report - khedma  (2026-09-16)

## Corpus Check
- 21 files · ~17,471 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 205 nodes · 557 edges · 10 communities
- Extraction: 88% EXTRACTED · 12% INFERRED · 0% AMBIGUOUS · INFERRED: 66 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `36ce8bb3`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- package.json
- RateLimiter
- logic-test.ts
- index.ts
- PositionStore
- trader.ts
- notify.ts
- compilerOptions
- Setup (Mac, Terminal, step by step)
- pnl.ts

## God Nodes (most connected - your core abstractions)
1. `PositionStore` - 33 edges
2. `main()` - 23 edges
3. `Trader` - 22 edges
4. `Position` - 18 edges
5. `RateLimiter` - 15 edges
6. `main()` - 15 edges
7. `loadConfig()` - 14 edges
8. `printSummary()` - 13 edges
9. `WalletWatcher` - 13 edges
10. `JupiterClient` - 12 edges

## Surprising Connections (you probably didn't know these)
- `testAbandonedFreesSlot()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testBalanceCheckRetriesTransientFailure()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testGatesInTrader()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testSellUsesOnChainBalance()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testTrader()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts

## Import Cycles
- None detected.

## Communities (10 total, 0 thin omitted)

### Community 0 - "package.json"
Cohesion: 0.07
Nodes (28): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js, description, devDependencies (+20 more)

### Community 1 - "RateLimiter"
Cohesion: 0.16
Nodes (12): JupiterClient, JupiterError, JupiterErrorKind, JupiterOrder, looksLikeNoRoute(), OrderParams, markToMarket(), printSummary() (+4 more)

### Community 2 - "logic-test.ts"
Cohesion: 0.20
Nodes (16): fail(), loadConfig(), numberEnv(), QUOTE_MINTS, requireEnv(), SOL_MINT, USDC_MINT, USDT_MINT (+8 more)

### Community 3 - "index.ts"
Cohesion: 0.22
Nodes (9): main(), quietenRpcRetryLogs(), reportWatcherHealth(), decideShutdown(), ShutdownDecision, loadKeypair(), WalletWatcher, testShutdownDebounce() (+1 more)

### Community 4 - "PositionStore"
Cohesion: 0.16
Nodes (15): PositionStore, Trader, Position, SwapEvent, main(), main(), okMarket(), testAbandonedFreesSlot() (+7 more)

### Community 5 - "trader.ts"
Cohesion: 0.20
Nodes (14): Config, cache, describeAge(), DexPair, evaluateToken(), fetchDexscreenerMarket(), MarketSource, summarizePairs() (+6 more)

### Community 6 - "notify.ts"
Cohesion: 0.29
Nodes (10): DEFAULT_SOUNDS, ENV_KEYS, flagOff(), notify(), NotifyKind, playSound(), sanitize(), showBanner() (+2 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Setup (Mac, Terminal, step by step)"
Cohesion: 0.13
Nodes (14): 1. Check that Node.js is installed, 2. Get the code and install dependencies, 3. Create your .env file, 4. Run the bot (dry-run), 5. Stopping the bot, 6. Going live (only when you're ready), How it decides what is a "buy" or "sell", Safety features (on by default) (+6 more)

### Community 9 - "pnl.ts"
Cohesion: 0.23
Nodes (12): formatSol(), heldPercent(), Mark, printGroup(), PositionStatus, isLoss(), WalletGateConfig, walletMute (+4 more)

## Knowledge Gaps
- **58 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+53 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 64 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@solana/web3.js` connect `package.json` to `logic-test.ts`, `index.ts`, `trader.ts`?**
  _High betweenness centrality (0.136) - this node is a cross-community bridge._
- **Why does `PositionStore` connect `PositionStore` to `RateLimiter`, `logic-test.ts`, `index.ts`, `trader.ts`, `pnl.ts`?**
  _High betweenness centrality (0.071) - this node is a cross-community bridge._
- **Why does `bs58` connect `package.json` to `logic-test.ts`?**
  _High betweenness centrality (0.045) - this node is a cross-community bridge._
- **Are the 8 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 8 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _58 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.0735632183908046 - nodes in this community are weakly interconnected._
- **Should `Setup (Mac, Terminal, step by step)` be split into smaller, more focused modules?**
  _Cohesion score 0.13333333333333333 - nodes in this community are weakly interconnected._