# Graph Report - khedma  (2026-09-23)

## Corpus Check
- 27 files · ~27,655 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 286 nodes · 817 edges · 11 communities
- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS · INFERRED: 79 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `aca0dd74`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- package.json
- trader.ts
- setup.ts
- exitRules.ts
- PositionStore
- tokenMarket.ts
- logic-test.ts
- compilerOptions
- Solana Copy-Trading Bot
- doctor.ts
- main

## God Nodes (most connected - your core abstractions)
1. `PositionStore` - 37 edges
2. `main()` - 26 edges
3. `Trader` - 25 edges
4. `main()` - 24 edges
5. `Position` - 21 edges
6. `main()` - 21 edges
7. `loadConfig()` - 18 edges
8. `RateLimiter` - 17 edges
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

## Communities (11 total, 0 thin omitted)

### Community 0 - "package.json"
Cohesion: 0.07
Nodes (27): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js, description, devDependencies (+19 more)

### Community 1 - "trader.ts"
Cohesion: 0.12
Nodes (25): JupiterClient, JupiterError, JupiterErrorKind, looksLikeNoRoute(), formatSol(), heldPercent(), Mark, markToMarket() (+17 more)

### Community 2 - "setup.ts"
Cohesion: 0.15
Nodes (25): ask(), askHidden(), askYesNo(), bail(), deriveAddress(), ENV_PATH, main(), nextLine() (+17 more)

### Community 3 - "exitRules.ts"
Cohesion: 0.33
Nodes (8): decideExit(), describeExitRules(), ExitCandidate, ExitConfig, ExitDecision, exitRulesEnabled(), pct(), testExitDecisions()

### Community 4 - "PositionStore"
Cohesion: 0.14
Nodes (16): PositionStore, Trader, Position, SwapEvent, main(), main(), okMarket(), testAbandonedFreesSlot() (+8 more)

### Community 5 - "tokenMarket.ts"
Cohesion: 0.19
Nodes (12): Config, cache, describeAge(), DexPair, evaluateToken(), MarketSource, summarizePairs(), TokenGateConfig (+4 more)

### Community 6 - "logic-test.ts"
Cohesion: 0.11
Nodes (33): bs58, main(), SEQUENCE, JupiterOrder, OrderParams, DEFAULT_PHRASES, DEFAULT_SOUNDS, flagOff() (+25 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Solana Copy-Trading Bot"
Cohesion: 0.10
Nodes (19): 1. Check that Node.js is installed, 2. Get the code, 3. Run the setup wizard, 4. Check everything before it runs, 5. Run the bot (dry-run), 6. Stopping the bot, 7. Going live (only when you're ready), Every setting (reference) (+11 more)

### Community 9 - "doctor.ts"
Cohesion: 0.14
Nodes (27): bip39, ed25519-hd-key, @solana/web3.js, fail(), loadConfig(), numberEnv(), QUOTE_MINTS, requireEnv() (+19 more)

### Community 10 - "main"
Cohesion: 0.19
Nodes (8): main(), quietenRpcRetryLogs(), reportWatcherHealth(), decideShutdown(), ShutdownDecision, WalletWatcher, testShutdownDebounce(), testWatcherQueue()

## Knowledge Gaps
- **81 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+76 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 87 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@solana/web3.js` connect `doctor.ts` to `package.json`, `trader.ts`, `setup.ts`, `logic-test.ts`?**
  _High betweenness centrality (0.080) - this node is a cross-community bridge._
- **Why does `PositionStore` connect `PositionStore` to `trader.ts`, `main`, `tokenMarket.ts`, `logic-test.ts`?**
  _High betweenness centrality (0.056) - this node is a cross-community bridge._
- **Are the 9 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 9 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _81 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.07142857142857142 - nodes in this community are weakly interconnected._
- **Should `trader.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1207897793263647 - nodes in this community are weakly interconnected._
- **Should `setup.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1452991452991453 - nodes in this community are weakly interconnected._