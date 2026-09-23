# Graph Report - khedma  (2026-09-23)

## Corpus Check
- 31 files · ~42,035 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 390 nodes · 1209 edges · 12 communities
- Extraction: 87% EXTRACTED · 13% INFERRED · 0% AMBIGUOUS · INFERRED: 163 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `5e044500`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- scripts
- walletRoster.ts
- setup.ts
- pnl.ts
- PositionStore
- logic-test.ts
- doctor.ts
- compilerOptions
- Solana Copy-Trading Bot
- discovery.ts
- RateLimiter
- jupiter.ts

## God Nodes (most connected - your core abstractions)
1. `PositionStore` - 50 edges
2. `main()` - 36 edges
3. `Trader` - 36 edges
4. `main()` - 31 edges
5. `main()` - 28 edges
6. `loadConfig()` - 25 edges
7. `Position` - 25 edges
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

## Communities (12 total, 0 thin omitted)

### Community 0 - "scripts"
Cohesion: 0.20
Nodes (10): scripts, alerts, discover, doctor, setup, start, summary, test (+2 more)

### Community 1 - "walletRoster.ts"
Cohesion: 0.12
Nodes (15): main(), Candidate, main(), BuyControl, DiscoveryHook, dropReason(), printRoster(), RosterFile (+7 more)

### Community 2 - "setup.ts"
Cohesion: 0.06
Nodes (50): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js, description, devDependencies (+42 more)

### Community 3 - "pnl.ts"
Cohesion: 0.14
Nodes (25): avg(), compareToSource(), CopyComparison, entryPhrase(), pct(), priceOf(), summarizeComparisons(), WalletComparison (+17 more)

### Community 4 - "PositionStore"
Cohesion: 0.11
Nodes (21): PositionStore, sleep(), Trader, Position, SwapEvent, main(), main(), okMarket() (+13 more)

### Community 5 - "logic-test.ts"
Cohesion: 0.08
Nodes (53): @solana/web3.js, Config, fail(), loadConfig(), numberEnv(), requireEnv(), SOL_MINT, USDC_MINT (+45 more)

### Community 6 - "doctor.ts"
Cohesion: 0.13
Nodes (32): main(), SEQUENCE, fetchGeckoTerminal(), ago(), bad(), checkWebSocket(), finish(), main() (+24 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Solana Copy-Trading Bot"
Cohesion: 0.09
Nodes (21): 1. Check that Node.js is installed, 2. Get the code, 3. Run the setup wizard, 4. Check everything before it runs, 5. Run the bot (dry-run), 6. Stopping the bot, 7. Going live (only when you're ready), Automatic wallet discovery (`DISCOVERY=true`) (+13 more)

### Community 9 - "discovery.ts"
Cohesion: 0.17
Nodes (21): QUOTE_MINTS, bump(), discoverWallets(), DISCOVERY_RULES, DiscoveryReport, FetchJson, fetchPolitely(), findCandidates() (+13 more)

### Community 10 - "RateLimiter"
Cohesion: 0.17
Nodes (6): RateLimiter, WalletWatcher, testActiveWalletFilter(), testRateLimiter(), testTransactionVersions(), testWatcherQueue()

### Community 11 - "jupiter.ts"
Cohesion: 0.31
Nodes (6): JupiterClient, JupiterError, JupiterErrorKind, JupiterOrder, looksLikeNoRoute(), OrderParams

## Knowledge Gaps
- **93 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+88 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 100 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@solana/web3.js` connect `logic-test.ts` to `discovery.ts`, `setup.ts`, `doctor.ts`?**
  _High betweenness centrality (0.068) - this node is a cross-community bridge._
- **Why does `PositionStore` connect `PositionStore` to `walletRoster.ts`, `RateLimiter`, `pnl.ts`, `logic-test.ts`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **Why does `shortAddress()` connect `walletRoster.ts` to `setup.ts`, `pnl.ts`, `PositionStore`, `logic-test.ts`, `doctor.ts`, `RateLimiter`?**
  _High betweenness centrality (0.054) - this node is a cross-community bridge._
- **Are the 13 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 13 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _93 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `walletRoster.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.12367149758454106 - nodes in this community are weakly interconnected._
- **Should `setup.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05858585858585859 - nodes in this community are weakly interconnected._