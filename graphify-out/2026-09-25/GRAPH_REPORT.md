# Graph Report - khedma  (2026-09-25)

## Corpus Check
- 37 files · ~63,235 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: .example 1, (none) 1)

## Summary
- 550 nodes · 1844 edges · 17 communities
- Extraction: 86% EXTRACTED · 14% INFERRED · 0% AMBIGUOUS · INFERRED: 266 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `941f0e09`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- package.json
- shortAddress
- setupChecks.ts
- trader.ts
- PositionStore
- pnl.ts
- notify.ts
- compilerOptions
- Solana Copy-Trading Bot
- discovery.ts
- main
- telegram.ts
- index.ts
- doctor.ts
- logic-test.ts
- tokenAccounts.ts
- exitRules.ts

## God Nodes (most connected - your core abstractions)
1. `main()` - 66 edges
2. `PositionStore` - 64 edges
3. `Trader` - 45 edges
4. `main()` - 40 edges
5. `shortAddress()` - 38 edges
6. `main()` - 37 edges
7. `Position` - 35 edges
8. `WalletRoster` - 34 edges
9. `loadConfig()` - 33 edges
10. `WalletWatcher` - 32 edges

## Surprising Connections (you probably didn't know these)
- `testAbandonedFreesSlot()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testActiveWalletFilter()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testBalanceCheckRetriesTransientFailure()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testEmptySlotsFill()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts
- `testExitsInTrader()` --calls--> `loadConfig()`  [EXTRACTED]
  test/logic-test.ts → src/config.ts

## Import Cycles
- None detected.

## Communities (17 total, 0 thin omitted)

### Community 0 - "package.json"
Cohesion: 0.06
Nodes (32): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js, description, devDependencies (+24 more)

### Community 1 - "shortAddress"
Cohesion: 0.09
Nodes (22): main(), Candidate, BuyControl, DiscoveryHook, dropReason(), printRoster(), PROBATION_TRADES, PROVEN_MIN_TRADES (+14 more)

### Community 2 - "setupChecks.ts"
Cohesion: 0.09
Nodes (29): createPrompter(), ask(), askHidden(), askYesNo(), nextLine(), Prompter, ENV_PATH, main() (+21 more)

### Community 3 - "trader.ts"
Cohesion: 0.16
Nodes (15): Config, SOL_MINT, cache, describeAge(), DexPair, evaluateToken(), MarketSource, summarizePairs() (+7 more)

### Community 4 - "PositionStore"
Cohesion: 0.10
Nodes (24): PositionStore, sleep(), formatPnl(), Trader, Position, SwapEvent, main(), main() (+16 more)

### Community 5 - "pnl.ts"
Cohesion: 0.08
Nodes (43): fail(), loadConfig(), numberEnv(), requireEnv(), tradeAlertsEnv(), avg(), compareToSource(), CopyComparison (+35 more)

### Community 6 - "notify.ts"
Cohesion: 0.14
Nodes (25): main(), SEQUENCE, DEFAULT_PHRASES, DEFAULT_SOUNDS, flagOff(), notify(), NotifyKind, playAlert() (+17 more)

### Community 7 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

### Community 8 - "Solana Copy-Trading Bot"
Cohesion: 0.08
Nodes (23): 1. Check that Node.js is installed, 2. Get the code, 3. Run the setup wizard, 4. Check everything before it runs, 5. Run the bot (dry-run), 6. Stopping the bot, 7. Going live (only when you're ready), Automatic wallet discovery (`DISCOVERY=true`) (+15 more)

### Community 9 - "discovery.ts"
Cohesion: 0.17
Nodes (21): bump(), discoverWallets(), DISCOVERY_RULES, DiscoveryReport, FetchJson, fetchPolitely(), findCandidates(), holdText() (+13 more)

### Community 10 - "main"
Cohesion: 0.12
Nodes (11): main(), quietenRpcRetryLogs(), reportWatcherHealth(), RateLimiter, analyzeSwap(), WalletWatcher, testActiveWalletFilter(), testActivityCheck() (+3 more)

### Community 11 - "telegram.ts"
Cohesion: 0.06
Nodes (49): TradeAlerts, TOKEN_ACCOUNT_RENT_SOL, isTelegramToken(), upsertEnv(), allQuiet(), ApiReply, clock(), closedAt() (+41 more)

### Community 12 - "index.ts"
Cohesion: 0.18
Nodes (14): @solana/web3.js, QUOTE_MINTS, USDC_MINT, USDT_MINT, main(), getSolPriceUsd(), loadKeypair(), MAX_TX_VERSION (+6 more)

### Community 13 - "doctor.ts"
Cohesion: 0.26
Nodes (16): fetchGeckoTerminal(), ago(), bad(), checkWebSocket(), finish(), main(), ok(), warn() (+8 more)

### Community 14 - "logic-test.ts"
Cohesion: 0.22
Nodes (10): bip39, bs58, decideShutdown(), ShutdownDecision, makeTx(), testAnalyzeSwap(), testRecommendedSettings(), testShutdownDebounce() (+2 more)

### Community 15 - "tokenAccounts.ts"
Cohesion: 0.22
Nodes (12): closeAccountInstruction(), closeAccounts(), CloseResult, EmptyAccount, findEmptyAccounts(), goneFromChain(), ParsedTokenAccount, selectEmpty() (+4 more)

### Community 16 - "exitRules.ts"
Cohesion: 0.33
Nodes (8): decideExit(), describeExitRules(), ExitCandidate, ExitConfig, ExitDecision, exitRulesEnabled(), pct(), testExitDecisions()

## Knowledge Gaps
- **114 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+109 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 128 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `PositionStore` connect `PositionStore` to `shortAddress`, `trader.ts`, `pnl.ts`, `main`, `index.ts`, `logic-test.ts`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **Why does `@solana/web3.js` connect `index.ts` to `package.json`, `setupChecks.ts`, `trader.ts`, `pnl.ts`, `discovery.ts`, `doctor.ts`, `logic-test.ts`, `tokenAccounts.ts`?**
  _High betweenness centrality (0.055) - this node is a cross-community bridge._
- **Why does `shortAddress()` connect `shortAddress` to `setupChecks.ts`, `trader.ts`, `PositionStore`, `pnl.ts`, `main`, `telegram.ts`, `index.ts`, `doctor.ts`, `logic-test.ts`?**
  _High betweenness centrality (0.053) - this node is a cross-community bridge._
- **Are the 26 inferred relationships involving `main()` (e.g. with `.all()` and `.byStatus()`) actually correct?**
  _`main()` has 26 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `shortAddress()` (e.g. with `main()` and `.maybeDiscover()`) actually correct?**
  _`shortAddress()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _114 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.06060606060606061 - nodes in this community are weakly interconnected._