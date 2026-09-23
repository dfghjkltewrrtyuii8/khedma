# Graph Report - khedma  (2026-09-23)

## Corpus Check
- 28 files · ~31,174 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 310 nodes · 916 edges · 11 communities
- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS · INFERRED: 92 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `2c045afd`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- package.json
- doctor.ts
- logic-test.ts
- pnl.ts
- PositionStore
- index.ts
- notify.ts
- compilerOptions
- Solana Copy-Trading Bot
- watcher.ts
- WalletWatcher

## God Nodes (most connected - your core abstractions)
1. `PositionStore` - 41 edges
2. `Trader` - 30 edges
3. `main()` - 28 edges
4. `main()` - 26 edges
5. `main()` - 25 edges
6. `Position` - 24 edges
7. `loadConfig()` - 20 edges
8. `RateLimiter` - 18 edges
9. `shortAddress()` - 16 edges
10. `JupiterClient` - 14 edges

## Surprising Connections (you probably didn't know these)
- `testSourceTracking()` --calls--> `compareToSource()`  [EXTRACTED]
  test/logic-test.ts → src/copyGap.ts
- `testMarkToMarket()` --calls--> `printSummary()`  [EXTRACTED]
  test/logic-test.ts → src/pnl.ts
- `testSummary()` --calls--> `printSummary()`  [EXTRACTED]
  test/logic-test.ts → src/pnl.ts
- `testTransactionVersions()` --calls--> `RateLimiter`  [EXTRACTED]
  test/logic-test.ts → src/rateLimiter.ts
- `testWatcherQueue()` --calls--> `RateLimiter`  [EXTRACTED]
  test/logic-test.ts → src/rateLimiter.ts

## Import Cycles
- None detected.

## Communities (11 total, 0 thin omitted)

### Community 0 - "package.json"
Cohesion: 0.07
Nodes (27): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js, description, devDependencies (+19 more)

### Community 1 - "doctor.ts"
Cohesion: 0.11
Nodes (25): ago(), bad(), checkWebSocket(), finish(), main(), ok(), warn(), withTimeout() (+17 more)

### Community 2 - "logic-test.ts"
Cohesion: 0.10
Nodes (34): bip39, bs58, ed25519-hd-key, ask(), askHidden(), askYesNo(), bail(), deriveAddress() (+26 more)

### Community 3 - "pnl.ts"
Cohesion: 0.23
Nodes (16): avg(), compareToSource(), CopyComparison, entryPhrase(), pct(), priceOf(), summarizeComparisons(), WalletComparison (+8 more)

### Community 4 - "PositionStore"
Cohesion: 0.13
Nodes (20): loadConfig(), PositionStore, Trader, Position, SwapEvent, shortAddress(), main(), okMarket() (+12 more)

### Community 5 - "index.ts"
Cohesion: 0.09
Nodes (35): Config, decideExit(), describeExitRules(), ExitCandidate, ExitConfig, ExitDecision, exitRulesEnabled(), pct() (+27 more)

### Community 6 - "notify.ts"
Cohesion: 0.14
Nodes (25): main(), SEQUENCE, DEFAULT_PHRASES, DEFAULT_SOUNDS, flagOff(), notify(), NotifyKind, playAlert() (+17 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Solana Copy-Trading Bot"
Cohesion: 0.10
Nodes (19): 1. Check that Node.js is installed, 2. Get the code, 3. Run the setup wizard, 4. Check everything before it runs, 5. Run the bot (dry-run), 6. Stopping the bot, 7. Going live (only when you're ready), Every setting (reference) (+11 more)

### Community 9 - "watcher.ts"
Cohesion: 0.20
Nodes (13): @solana/web3.js, fail(), numberEnv(), QUOTE_MINTS, requireEnv(), SOL_MINT, USDC_MINT, USDT_MINT (+5 more)

### Community 10 - "WalletWatcher"
Cohesion: 0.38
Nodes (4): analyzeSwap(), WalletWatcher, testTransactionVersions(), testWatcherQueue()

## Knowledge Gaps
- **83 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+78 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 89 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@solana/web3.js` connect `watcher.ts` to `package.json`, `doctor.ts`, `logic-test.ts`, `index.ts`?**
  _High betweenness centrality (0.074) - this node is a cross-community bridge._
- **Why does `PositionStore` connect `PositionStore` to `doctor.ts`, `logic-test.ts`, `pnl.ts`, `index.ts`?**
  _High betweenness centrality (0.058) - this node is a cross-community bridge._
- **Are the 9 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 9 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _83 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.07142857142857142 - nodes in this community are weakly interconnected._
- **Should `doctor.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11470985155195682 - nodes in this community are weakly interconnected._
- **Should `logic-test.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1039136302294197 - nodes in this community are weakly interconnected._