# Graph Report - khedma  (2026-09-21)

## Corpus Check
- 25 files · ~23,078 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 258 nodes · 719 edges · 11 communities
- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS · INFERRED: 68 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ed4ecab2`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- package.json
- trader.ts
- setup.ts
- Trader
- PositionStore
- tokenMarket.ts
- doctor.ts
- compilerOptions
- Setup (Mac, Terminal, step by step)
- logic-test.ts
- pnl.ts

## God Nodes (most connected - your core abstractions)
1. `PositionStore` - 33 edges
2. `main()` - 23 edges
3. `Trader` - 22 edges
4. `main()` - 21 edges
5. `Position` - 18 edges
6. `RateLimiter` - 17 edges
7. `main()` - 17 edges
8. `loadConfig()` - 16 edges
9. `shortAddress()` - 15 edges
10. `JupiterClient` - 14 edges

## Surprising Connections (you probably didn't know these)
- `testAbandonedFreesSlot()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testGatesInTrader()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testTrader()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testNotifySounds()` --calls--> `soundFor()`  [EXTRACTED]
  test/logic-test.ts → src/notify.ts
- `testNotifySpeech()` --calls--> `speechFor()`  [EXTRACTED]
  test/logic-test.ts → src/notify.ts

## Import Cycles
- None detected.

## Communities (11 total, 0 thin omitted)

### Community 0 - "package.json"
Cohesion: 0.07
Nodes (30): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js, description, devDependencies (+22 more)

### Community 1 - "trader.ts"
Cohesion: 0.11
Nodes (20): main(), quietenRpcRetryLogs(), reportWatcherHealth(), JupiterClient, JupiterError, JupiterErrorKind, JupiterOrder, looksLikeNoRoute() (+12 more)

### Community 2 - "setup.ts"
Cohesion: 0.15
Nodes (25): ask(), askHidden(), askYesNo(), bail(), deriveAddress(), ENV_PATH, main(), nextLine() (+17 more)

### Community 3 - "Trader"
Cohesion: 0.32
Nodes (4): Trader, SwapEvent, shortAddress(), testTrader()

### Community 4 - "PositionStore"
Cohesion: 0.20
Nodes (11): printSummary(), PositionStore, main(), Position, PositionStatus, main(), testAbandonedFreesSlot(), testGatesInTrader() (+3 more)

### Community 5 - "tokenMarket.ts"
Cohesion: 0.21
Nodes (10): Config, cache, describeAge(), DexPair, evaluateToken(), MarketSource, TokenGateConfig, TokenMarket (+2 more)

### Community 6 - "doctor.ts"
Cohesion: 0.15
Nodes (27): main(), SEQUENCE, ago(), bad(), checkWebSocket(), finish(), main(), ok() (+19 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Setup (Mac, Terminal, step by step)"
Cohesion: 0.11
Nodes (17): 1. Check that Node.js is installed, 2. Get the code, 3. Run the setup wizard, 4. Check everything before it runs, 5. Run the bot (dry-run), 6. Stopping the bot, 7. Going live (only when you're ready), Every setting (reference) (+9 more)

### Community 9 - "logic-test.ts"
Cohesion: 0.14
Nodes (26): @solana/web3.js, fail(), loadConfig(), numberEnv(), QUOTE_MINTS, requireEnv(), SOL_MINT, USDC_MINT (+18 more)

### Community 10 - "pnl.ts"
Cohesion: 0.29
Nodes (9): formatSol(), heldPercent(), Mark, markToMarket(), printGroup(), isLoss(), WalletGateConfig, WalletRecord (+1 more)

## Knowledge Gaps
- **73 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+68 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 79 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@solana/web3.js` connect `logic-test.ts` to `package.json`, `trader.ts`, `setup.ts`, `doctor.ts`?**
  _High betweenness centrality (0.086) - this node is a cross-community bridge._
- **Why does `PositionStore` connect `PositionStore` to `trader.ts`, `Trader`, `tokenMarket.ts`, `logic-test.ts`, `pnl.ts`?**
  _High betweenness centrality (0.053) - this node is a cross-community bridge._
- **Are the 8 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 8 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _73 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.06653225806451613 - nodes in this community are weakly interconnected._
- **Should `trader.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1073170731707317 - nodes in this community are weakly interconnected._
- **Should `setup.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1452991452991453 - nodes in this community are weakly interconnected._