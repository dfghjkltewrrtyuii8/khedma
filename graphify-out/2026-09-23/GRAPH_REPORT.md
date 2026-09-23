# Graph Report - khedma  (2026-09-23)

## Corpus Check
- 31 files · ~39,527 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 384 nodes · 1181 edges · 11 communities
- Extraction: 87% EXTRACTED · 13% INFERRED · 0% AMBIGUOUS · INFERRED: 155 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1a1a3f33`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- package.json
- walletRoster.ts
- logic-test.ts
- pnl.ts
- PositionStore
- doctor.ts
- notify.ts
- compilerOptions
- Solana Copy-Trading Bot
- discovery.ts
- RateLimiter

## God Nodes (most connected - your core abstractions)
1. `PositionStore` - 47 edges
2. `main()` - 36 edges
3. `Trader` - 35 edges
4. `main()` - 30 edges
5. `main()` - 28 edges
6. `Position` - 25 edges
7. `loadConfig()` - 24 edges
8. `WalletRoster` - 24 edges
9. `shortAddress()` - 23 edges
10. `RateLimiter` - 19 edges

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
Nodes (29): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js, description, devDependencies (+21 more)

### Community 1 - "walletRoster.ts"
Cohesion: 0.12
Nodes (16): main(), Candidate, main(), BuyControl, DiscoveryHook, dropReason(), printRoster(), PROBATION_TRADES (+8 more)

### Community 2 - "logic-test.ts"
Cohesion: 0.10
Nodes (35): bip39, bs58, ask(), askHidden(), askYesNo(), bail(), deriveAddress(), ENV_PATH (+27 more)

### Community 3 - "pnl.ts"
Cohesion: 0.13
Nodes (26): avg(), compareToSource(), CopyComparison, entryPhrase(), pct(), priceOf(), summarizeComparisons(), WalletComparison (+18 more)

### Community 4 - "PositionStore"
Cohesion: 0.11
Nodes (22): main(), quietenRpcRetryLogs(), reportWatcherHealth(), PositionStore, Trader, Position, SwapEvent, main() (+14 more)

### Community 5 - "doctor.ts"
Cohesion: 0.07
Nodes (56): @solana/web3.js, Config, fail(), loadConfig(), numberEnv(), requireEnv(), SOL_MINT, USDC_MINT (+48 more)

### Community 6 - "notify.ts"
Cohesion: 0.14
Nodes (25): main(), SEQUENCE, DEFAULT_PHRASES, DEFAULT_SOUNDS, flagOff(), notify(), NotifyKind, playAlert() (+17 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Solana Copy-Trading Bot"
Cohesion: 0.09
Nodes (21): 1. Check that Node.js is installed, 2. Get the code, 3. Run the setup wizard, 4. Check everything before it runs, 5. Run the bot (dry-run), 6. Stopping the bot, 7. Going live (only when you're ready), Automatic wallet discovery (`DISCOVERY=true`) (+13 more)

### Community 9 - "discovery.ts"
Cohesion: 0.19
Nodes (17): QUOTE_MINTS, discoverWallets(), DISCOVERY_RULES, DiscoveryReport, FetchJson, findCandidates(), isPersonalWallet(), median() (+9 more)

### Community 10 - "RateLimiter"
Cohesion: 0.18
Nodes (7): RateLimiter, analyzeSwap(), WalletWatcher, testActiveWalletFilter(), testRateLimiter(), testTransactionVersions(), testWatcherQueue()

## Knowledge Gaps
- **92 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+87 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 99 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@solana/web3.js` connect `doctor.ts` to `package.json`, `discovery.ts`, `logic-test.ts`?**
  _High betweenness centrality (0.067) - this node is a cross-community bridge._
- **Why does `shortAddress()` connect `walletRoster.ts` to `logic-test.ts`, `pnl.ts`, `PositionStore`, `doctor.ts`, `RateLimiter`?**
  _High betweenness centrality (0.056) - this node is a cross-community bridge._
- **Why does `PositionStore` connect `PositionStore` to `walletRoster.ts`, `logic-test.ts`, `pnl.ts`, `doctor.ts`, `RateLimiter`?**
  _High betweenness centrality (0.055) - this node is a cross-community bridge._
- **Are the 13 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 13 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _92 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.06666666666666667 - nodes in this community are weakly interconnected._
- **Should `walletRoster.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11616161616161616 - nodes in this community are weakly interconnected._