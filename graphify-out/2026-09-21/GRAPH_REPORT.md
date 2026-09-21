# Graph Report - khedma  (2026-09-21)

## Corpus Check
- 24 files · ~21,832 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 247 nodes · 687 edges · 10 communities
- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS · INFERRED: 68 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `981e84f1`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- package.json
- doctor.ts
- setup.ts
- logic-test.ts
- PositionStore
- trader.ts
- notify.ts
- compilerOptions
- Setup (Mac, Terminal, step by step)
- index.ts

## God Nodes (most connected - your core abstractions)
1. `PositionStore` - 33 edges
2. `main()` - 23 edges
3. `Trader` - 22 edges
4. `main()` - 19 edges
5. `Position` - 18 edges
6. `RateLimiter` - 17 edges
7. `loadConfig()` - 16 edges
8. `main()` - 16 edges
9. `shortAddress()` - 15 edges
10. `JupiterClient` - 14 edges

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
Nodes (27): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js, description, devDependencies (+19 more)

### Community 1 - "doctor.ts"
Cohesion: 0.14
Nodes (19): ago(), bad(), checkWebSocket(), finish(), main(), ok(), warn(), withTimeout() (+11 more)

### Community 2 - "setup.ts"
Cohesion: 0.12
Nodes (28): bip39, bs58, @solana/web3.js, ask(), askHidden(), askYesNo(), bail(), deriveAddress() (+20 more)

### Community 3 - "logic-test.ts"
Cohesion: 0.18
Nodes (12): reportWatcherHealth(), decideShutdown(), ShutdownDecision, analyzeSwap(), WalletWatcher, main(), makeTx(), testAnalyzeSwap() (+4 more)

### Community 4 - "PositionStore"
Cohesion: 0.16
Nodes (15): main(), PositionStore, Trader, Position, SwapEvent, main(), okMarket(), testAbandonedFreesSlot() (+7 more)

### Community 5 - "trader.ts"
Cohesion: 0.19
Nodes (14): Config, cache, describeAge(), DexPair, evaluateToken(), fetchDexscreenerMarket(), MarketSource, summarizePairs() (+6 more)

### Community 6 - "notify.ts"
Cohesion: 0.33
Nodes (9): DEFAULT_SOUNDS, ENV_KEYS, flagOff(), notify(), NotifyKind, playSound(), sanitize(), showBanner() (+1 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Setup (Mac, Terminal, step by step)"
Cohesion: 0.11
Nodes (17): 1. Check that Node.js is installed, 2. Get the code, 3. Run the setup wizard, 4. Check everything before it runs, 5. Run the bot (dry-run), 6. Stopping the bot, 7. Going live (only when you're ready), Every setting (reference) (+9 more)

### Community 9 - "index.ts"
Cohesion: 0.13
Nodes (28): fail(), loadConfig(), numberEnv(), QUOTE_MINTS, requireEnv(), SOL_MINT, USDC_MINT, USDT_MINT (+20 more)

## Knowledge Gaps
- **70 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+65 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 76 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@solana/web3.js` connect `setup.ts` to `package.json`, `doctor.ts`, `logic-test.ts`, `trader.ts`, `index.ts`?**
  _High betweenness centrality (0.086) - this node is a cross-community bridge._
- **Why does `PositionStore` connect `PositionStore` to `index.ts`, `logic-test.ts`, `trader.ts`?**
  _High betweenness centrality (0.055) - this node is a cross-community bridge._
- **Are the 8 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 8 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _70 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.07142857142857142 - nodes in this community are weakly interconnected._
- **Should `doctor.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.13978494623655913 - nodes in this community are weakly interconnected._
- **Should `setup.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.12473118279569892 - nodes in this community are weakly interconnected._