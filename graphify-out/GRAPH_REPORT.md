# Graph Report - khedma  (2026-09-23)

## Corpus Check
- 29 files · ~34,289 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 348 nodes · 1049 edges · 11 communities
- Extraction: 88% EXTRACTED · 12% INFERRED · 0% AMBIGUOUS · INFERRED: 129 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `2e4e08eb`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- package.json
- shortAddress
- logic-test.ts
- pnl.ts
- PositionStore
- trader.ts
- doctor.ts
- compilerOptions
- Solana Copy-Trading Bot
- index.ts
- RateLimiter

## God Nodes (most connected - your core abstractions)
1. `PositionStore` - 45 edges
2. `main()` - 33 edges
3. `Trader` - 32 edges
4. `main()` - 27 edges
5. `main()` - 26 edges
6. `Position` - 25 edges
7. `shortAddress()` - 22 edges
8. `loadConfig()` - 21 edges
9. `RateLimiter` - 19 edges
10. `WalletWatcher` - 19 edges

## Surprising Connections (you probably didn't know these)
- `testAbandonedFreesSlot()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testActiveWalletFilter()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testBalanceCheckRetriesTransientFailure()` --calls--> `loadConfig()`  [EXTRACTED]
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

### Community 1 - "shortAddress"
Cohesion: 0.14
Nodes (11): main(), BuyControl, dropReason(), printRoster(), RosterFile, Rotation, RotationConfig, WalletRoster (+3 more)

### Community 2 - "logic-test.ts"
Cohesion: 0.09
Nodes (38): bip39, bs58, ed25519-hd-key, ask(), askHidden(), askYesNo(), bail(), deriveAddress() (+30 more)

### Community 3 - "pnl.ts"
Cohesion: 0.15
Nodes (24): avg(), compareToSource(), CopyComparison, entryPhrase(), pct(), priceOf(), summarizeComparisons(), WalletComparison (+16 more)

### Community 4 - "PositionStore"
Cohesion: 0.12
Nodes (19): main(), PositionStore, Trader, Position, SwapEvent, main(), main(), okMarket() (+11 more)

### Community 5 - "trader.ts"
Cohesion: 0.09
Nodes (28): Config, decideExit(), ExitCandidate, ExitConfig, ExitDecision, pct(), JupiterClient, JupiterError (+20 more)

### Community 6 - "doctor.ts"
Cohesion: 0.11
Nodes (38): main(), SEQUENCE, ago(), bad(), checkWebSocket(), finish(), main(), ok() (+30 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Solana Copy-Trading Bot"
Cohesion: 0.10
Nodes (20): 1. Check that Node.js is installed, 2. Get the code, 3. Run the setup wizard, 4. Check everything before it runs, 5. Run the bot (dry-run), 6. Stopping the bot, 7. Going live (only when you're ready), Every setting (reference) (+12 more)

### Community 9 - "index.ts"
Cohesion: 0.17
Nodes (17): @solana/web3.js, fail(), loadConfig(), numberEnv(), QUOTE_MINTS, requireEnv(), SOL_MINT, USDC_MINT (+9 more)

### Community 10 - "RateLimiter"
Cohesion: 0.18
Nodes (7): RateLimiter, analyzeSwap(), WalletWatcher, testActiveWalletFilter(), testRateLimiter(), testTransactionVersions(), testWatcherQueue()

## Knowledge Gaps
- **86 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+81 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 93 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@solana/web3.js` connect `index.ts` to `package.json`, `logic-test.ts`, `trader.ts`, `doctor.ts`?**
  _High betweenness centrality (0.067) - this node is a cross-community bridge._
- **Why does `PositionStore` connect `PositionStore` to `shortAddress`, `logic-test.ts`, `pnl.ts`, `trader.ts`, `index.ts`, `RateLimiter`?**
  _High betweenness centrality (0.059) - this node is a cross-community bridge._
- **Why does `shortAddress()` connect `shortAddress` to `logic-test.ts`, `pnl.ts`, `PositionStore`, `trader.ts`, `doctor.ts`, `index.ts`, `RateLimiter`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **Are the 12 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 12 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _86 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.07142857142857142 - nodes in this community are weakly interconnected._
- **Should `shortAddress` be split into smaller, more focused modules?**
  _Cohesion score 0.13725490196078433 - nodes in this community are weakly interconnected._