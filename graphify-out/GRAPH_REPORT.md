# Graph Report - khedma  (2026-09-15)

## Corpus Check
- Corpus is ~13,355 words - fits in a single context window. You may not need a graph.

## Summary
- 182 nodes · 520 edges · 8 communities
- Extraction: 79% EXTRACTED · 21% INFERRED · 0% AMBIGUOUS · INFERRED: 107 edges (avg confidence: 0.84)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Package Manifest & Dependencies
- Jupiter Swaps & P&L Reporting
- Config, Types & Module Wiring
- Wallet Watcher & Rate Limiting
- Position Store & Lifecycle
- Trader: Copy Buy/Sell
- README Concepts & Notifications
- TypeScript Compiler Config

## God Nodes (most connected - your core abstractions)
1. `PositionStore` - 32 edges
2. `main()` - 20 edges
3. `Trader` - 20 edges
4. `RateLimiter` - 16 edges
5. `loadConfig()` - 15 edges
6. `Position` - 15 edges
7. `JupiterClient` - 14 edges
8. `WalletWatcher` - 14 edges
9. `printSummary()` - 13 edges
10. `main()` - 12 edges

## Surprising Connections (you probably didn't know these)
- `IMPORTANT: a failed sell is NOT a closed position. The tokens are still` --semantically_similar_to--> `Stuck Position`  [INFERRED] [semantically similar]
  src/trader.ts → README.md
- `main()` --implements--> `Offline Logic Tests`  [INFERRED]
  test/logic-test.ts → README.md
- `QUOTE_MINTS` --implements--> `Buy/Sell Detection Rules`  [INFERRED]
  src/config.ts → README.md
- `Config` --implements--> `Hard Caps`  [INFERRED]
  src/config.ts → README.md
- `loadConfig()` --implements--> `DRY_RUN Mode`  [INFERRED]
  src/config.ts → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Failed-Sell Safety Net** — readme_stuck_position, readme_abandoned_position, readme_manual_writeoff, readme_sell_sizing_from_wallet, readme_graceful_shutdown, readme_thin_token_route_loss [INFERRED 0.85]
- **Jupiter Request Budget Discipline** — readme_shared_jupiter_rate_limiter, readme_mark_to_market, readme_coingecko_sol_price, readme_pnl_reporting [INFERRED 0.85]
- **External Services** — readme_helius_rpc, readme_jupiter_swap_api_v2, readme_coingecko_sol_price, readme_phantom_wallet [EXTRACTED 1.00]

## Communities (8 total, 0 thin omitted)

### Community 0 - "Package Manifest & Dependencies"
Cohesion: 0.07
Nodes (27): dependencies, bip39, bs58, dotenv, ed25519-hd-key, @solana/web3.js, description, devDependencies (+19 more)

### Community 1 - "Jupiter Swaps & P&L Reporting"
Cohesion: 0.14
Nodes (18): CoinGecko SOL Price, P&L in SOL and USD, Thin-Token Route Loss, JupiterClient, JupiterError, JupiterErrorKind, JupiterOrder, looksLikeNoRoute() (+10 more)

### Community 2 - "Config, Types & Module Wiring"
Cohesion: 0.18
Nodes (17): @solana/web3.js, Config, fail(), loadConfig(), numberEnv(), QUOTE_MINTS, requireEnv(), SOL_MINT (+9 more)

### Community 3 - "Wallet Watcher & Rate Limiting"
Cohesion: 0.14
Nodes (11): reportWatcherHealth(), RateLimiter, decideShutdown(), ShutdownDecision, analyzeSwap(), WalletWatcher, makeTx(), testAnalyzeSwap() (+3 more)

### Community 4 - "Position Store & Lifecycle"
Cohesion: 0.25
Nodes (13): Abandoned Position, Manual Write-off, Stuck Position, PositionStore, Position, main(), main(), testAbandonedFreesSlot() (+5 more)

### Community 5 - "Trader: Copy Buy/Sell"
Cohesion: 0.22
Nodes (7): Copy Rules, Graceful Shutdown, Real Sells Sized From Wallet, main(), Trader, SwapEvent, testTrader()

### Community 6 - "README Concepts & Notifications"
Cohesion: 0.16
Nodes (17): Buy/Sell Detection Rules, Copy Trading, macOS Desktop Notifications, DRY_RUN Mode, .env Configuration, Hard Caps, Helius RPC, Jupiter Swap API v2 (+9 more)

### Community 7 - "TypeScript Compiler Config"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noEmit, resolveJsonModule (+4 more)

## Knowledge Gaps
- **38 isolated node(s):** `name`, `version`, `private`, `description`, `start` (+33 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 42 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@solana/web3.js` connect `Config, Types & Module Wiring` to `Package Manifest & Dependencies`, `Wallet Watcher & Rate Limiting`?**
  _High betweenness centrality (0.168) - this node is a cross-community bridge._
- **Why does `PositionStore` connect `Position Store & Lifecycle` to `Jupiter Swaps & P&L Reporting`, `Config, Types & Module Wiring`, `Wallet Watcher & Rate Limiting`, `Trader: Copy Buy/Sell`?**
  _High betweenness centrality (0.097) - this node is a cross-community bridge._
- **Why does `WalletWatcher` connect `Wallet Watcher & Rate Limiting` to `Config, Types & Module Wiring`, `Trader: Copy Buy/Sell`, `README Concepts & Notifications`?**
  _High betweenness centrality (0.052) - this node is a cross-community bridge._
- **Are the 8 inferred relationships involving `main()` (e.g. with `Graceful Shutdown` and `.byStatus()`) actually correct?**
  _`main()` has 8 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `loadConfig()` (e.g. with `DRY_RUN Mode` and `.env Configuration`) actually correct?**
  _`loadConfig()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _38 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Package Manifest & Dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.07142857142857142 - nodes in this community are weakly interconnected._