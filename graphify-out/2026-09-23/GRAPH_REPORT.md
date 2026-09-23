# Graph Report - khedma  (2026-09-21)

## Corpus Check
- 27 files · ~26,448 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 279 nodes · 798 edges · 11 communities
- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS · INFERRED: 79 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `8424d441`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- package.json
- trader.ts
- setup.ts
- logic-test.ts
- PositionStore
- tokenMarket.ts
- notify.ts
- compilerOptions
- Setup (Mac, Terminal, step by step)
- doctor.ts
- WalletWatcher

## God Nodes (most connected - your core abstractions)
1. `PositionStore` - 37 edges
2. `main()` - 26 edges
3. `Trader` - 25 edges
4. `main()` - 23 edges
5. `Position` - 21 edges
6. `main()` - 20 edges
7. `loadConfig()` - 18 edges
8. `RateLimiter` - 17 edges
9. `shortAddress()` - 16 edges
10. `JupiterClient` - 14 edges

## Surprising Connections (you probably didn't know these)
- `testAbandonedFreesSlot()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testBalanceCheckRetriesTransientFailure()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testEnvIsolation()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testExitsInTrader()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testGatesInTrader()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts

## Import Cycles
- None detected.

## Communities (11 total, 0 thin omitted)

### Community 0 - "package.json"
Cohesion: 0.07
Nodes (27): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js, description, devDependencies (+19 more)

### Community 1 - "trader.ts"
Cohesion: 0.10
Nodes (34): @solana/web3.js, fail(), loadConfig(), numberEnv(), QUOTE_MINTS, requireEnv(), SOL_MINT, USDC_MINT (+26 more)

### Community 2 - "setup.ts"
Cohesion: 0.12
Nodes (28): bip39, ed25519-hd-key, ask(), askHidden(), askYesNo(), bail(), deriveAddress(), ENV_PATH (+20 more)

### Community 3 - "logic-test.ts"
Cohesion: 0.15
Nodes (21): bs58, JupiterOrder, OrderParams, decideShutdown(), ShutdownDecision, summarizePairs(), analyzeSwap(), main() (+13 more)

### Community 4 - "PositionStore"
Cohesion: 0.14
Nodes (16): main(), quietenRpcRetryLogs(), PositionStore, tokenGateEnabled(), Trader, Position, SwapEvent, shortAddress() (+8 more)

### Community 5 - "tokenMarket.ts"
Cohesion: 0.21
Nodes (10): Config, cache, describeAge(), DexPair, evaluateToken(), MarketSource, TokenGateConfig, TokenMarket (+2 more)

### Community 6 - "notify.ts"
Cohesion: 0.20
Nodes (18): main(), SEQUENCE, DEFAULT_PHRASES, DEFAULT_SOUNDS, flagOff(), notify(), NotifyKind, playAlert() (+10 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Setup (Mac, Terminal, step by step)"
Cohesion: 0.11
Nodes (18): 1. Check that Node.js is installed, 2. Get the code, 3. Run the setup wizard, 4. Check everything before it runs, 5. Run the bot (dry-run), 6. Stopping the bot, 7. Going live (only when you're ready), Every setting (reference) (+10 more)

### Community 9 - "doctor.ts"
Cohesion: 0.21
Nodes (18): ago(), bad(), checkWebSocket(), finish(), main(), ok(), warn(), withTimeout() (+10 more)

### Community 10 - "WalletWatcher"
Cohesion: 0.36
Nodes (3): reportWatcherHealth(), WalletWatcher, testWatcherQueue()

## Knowledge Gaps
- **78 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+73 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 84 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@solana/web3.js` connect `trader.ts` to `package.json`, `doctor.ts`, `setup.ts`, `logic-test.ts`?**
  _High betweenness centrality (0.082) - this node is a cross-community bridge._
- **Why does `PositionStore` connect `PositionStore` to `trader.ts`, `logic-test.ts`, `tokenMarket.ts`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **Are the 9 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 9 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _78 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.07142857142857142 - nodes in this community are weakly interconnected._
- **Should `trader.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.0962962962962963 - nodes in this community are weakly interconnected._
- **Should `setup.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.12473118279569892 - nodes in this community are weakly interconnected._