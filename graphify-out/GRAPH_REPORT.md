# Graph Report - khedma  (2026-09-25)

## Corpus Check
- 38 files · ~67,237 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 568 nodes · 1938 edges · 12 communities
- Extraction: 85% EXTRACTED · 15% INFERRED · 0% AMBIGUOUS · INFERRED: 287 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b06bc9a9`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- package.json
- shortAddress
- setupChecks.ts
- tokenMarket.ts
- PositionStore
- pnl.ts
- doctor.ts
- compilerOptions
- Solana Copy-Trading Bot
- logic-test.ts
- WalletWatcher
- main

## God Nodes (most connected - your core abstractions)
1. `main()` - 67 edges
2. `PositionStore` - 65 edges
3. `Trader` - 45 edges
4. `shortAddress()` - 43 edges
5. `main()` - 41 edges
6. `WalletRoster` - 39 edges
7. `main()` - 37 edges
8. `Position` - 35 edges
9. `loadConfig()` - 33 edges
10. `WalletWatcher` - 32 edges

## Surprising Connections (you probably didn't know these)
- `testEmptySlotsFill()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testStaleBenchAndTrial()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testSourceTracking()` --calls--> `compareToSource()`  [EXTRACTED]
  test/logic-test.ts → src/copyGap.ts
- `testWinnersFirst()` --calls--> `compareToSource()`  [EXTRACTED]
  test/logic-test.ts → src/copyGap.ts
- `testMarkToMarket()` --calls--> `printSummary()`  [EXTRACTED]
  test/logic-test.ts → src/pnl.ts

## Import Cycles
- None detected.

## Communities (12 total, 0 thin omitted)

### Community 0 - "package.json"
Cohesion: 0.06
Nodes (31): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js, description, devDependencies (+23 more)

### Community 1 - "shortAddress"
Cohesion: 0.09
Nodes (24): main(), Candidate, BuyControl, DiscoveryHook, dropReason(), printRoster(), PROBATION_TRADES, PROVEN_MIN_TRADES (+16 more)

### Community 2 - "setupChecks.ts"
Cohesion: 0.09
Nodes (29): createPrompter(), ask(), askHidden(), askYesNo(), nextLine(), Prompter, ENV_PATH, main() (+21 more)

### Community 3 - "tokenMarket.ts"
Cohesion: 0.24
Nodes (10): cache, describeAge(), DexPair, evaluateToken(), summarizePairs(), TokenGateConfig, TokenMarket, TokenVerdict (+2 more)

### Community 4 - "PositionStore"
Cohesion: 0.09
Nodes (27): loadConfig(), PositionStore, main(), Trader, Position, SwapEvent, main(), main() (+19 more)

### Community 5 - "pnl.ts"
Cohesion: 0.09
Nodes (38): Config, avg(), compareToSource(), CopyComparison, entryPhrase(), pct(), priceOf(), summarizeComparisons() (+30 more)

### Community 6 - "doctor.ts"
Cohesion: 0.08
Nodes (50): main(), SEQUENCE, fetchGeckoTerminal(), ago(), bad(), checkWebSocket(), finish(), main() (+42 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Solana Copy-Trading Bot"
Cohesion: 0.08
Nodes (23): 1. Check that Node.js is installed, 2. Get the code, 3. Run the setup wizard, 4. Check everything before it runs, 5. Run the bot (dry-run), 6. Stopping the bot, 7. Going live (only when you're ready), Automatic wallet discovery (`DISCOVERY=true`) (+15 more)

### Community 9 - "logic-test.ts"
Cohesion: 0.05
Nodes (70): bip39, bs58, ed25519-hd-key, @solana/web3.js, fail(), numberEnv(), QUOTE_MINTS, requireEnv() (+62 more)

### Community 10 - "WalletWatcher"
Cohesion: 0.15
Nodes (6): RateLimiter, WalletWatcher, testActivityCheck(), testRateLimiter(), testTransactionVersions(), testWatcherQueue()

### Community 11 - "main"
Cohesion: 0.06
Nodes (56): main(), quietenRpcRetryLogs(), reportWatcherHealth(), TOKEN_ACCOUNT_RENT_SOL, isTelegramToken(), upsertEnv(), decideShutdown(), ShutdownDecision (+48 more)

## Knowledge Gaps
- **117 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+112 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 131 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `shortAddress()` connect `shortAddress` to `setupChecks.ts`, `PositionStore`, `pnl.ts`, `doctor.ts`, `logic-test.ts`, `WalletWatcher`, `main`?**
  _High betweenness centrality (0.059) - this node is a cross-community bridge._
- **Why does `@solana/web3.js` connect `logic-test.ts` to `package.json`, `setupChecks.ts`, `pnl.ts`, `doctor.ts`, `main`?**
  _High betweenness centrality (0.056) - this node is a cross-community bridge._
- **Why does `PositionStore` connect `PositionStore` to `shortAddress`, `pnl.ts`, `logic-test.ts`, `WalletWatcher`, `main`?**
  _High betweenness centrality (0.055) - this node is a cross-community bridge._
- **Are the 26 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 26 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `shortAddress()` (e.g. with `main()` and `.maybeDiscover()`) actually correct?**
  _`shortAddress()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _117 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.0625 - nodes in this community are weakly interconnected._