// Turns detected swaps into our own (copied) trades.
//
// Sizing is deliberately fixed and small: every copied buy spends exactly
// COPY_BUY_AMOUNT_SOL, regardless of how big the tracked wallet's trade was.
// Sells mirror the tracked wallet proportionally (they sold 50% -> we sell 50%).

import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { Config, SOL_MINT } from './config';
import { JupiterClient, JupiterError } from './jupiter';
import { notify } from './notify';
import { PositionStore } from './positions';
import { sleep } from './rateLimiter';
import { decideExit, exitRulesEnabled } from './exitRules';
import { evaluateToken, fetchDexscreenerMarket, MarketSource, tokenGateEnabled } from './tokenMarket';
import { Position, SwapEvent } from './types';
import { walletMute } from './walletGate';
import { closeAccounts, findEmptyAccounts } from './tokenAccounts';
import { shortAddress } from './watcher';

const SELL_ATTEMPTS = 3; // thin tokens can lose their route in seconds — retry, but don't loop forever
const SELL_RETRY_DELAY_MS = 2_000;
const BALANCE_SETTLE_ATTEMPTS = 4;
const BALANCE_SETTLE_DELAY_MS = 1_500;
const BALANCE_CHECK_ATTEMPTS = 3;
const BALANCE_CHECK_RETRY_DELAY_MS = 1_500;
// Their sells are attributed to our position on the same token only within
// this window, so a months-old position can't absorb an unrelated trade.
const SOURCE_ATTRIBUTION_MS = 48 * 3_600_000;
// A real buy costs the swap plus network fees plus, for a coin the wallet
// hasn't held before, ~0.002 SOL of token-account rent. A balance change
// larger than this over the swap means something else moved the wallet at the
// same moment, so it isn't trusted as the buy's cost.
const MAX_BUY_OVERHEAD_SOL = 0.02;

export class Trader {
  private shuttingDown = false;
  private closeAllStarted = false;
  // Events are processed one at a time so two near-simultaneous trades can't
  // race past the position-count checks.
  private queue: Promise<void> = Promise.resolve();
  // Trades waiting in (or running on) the queue. An exit sweep checks this
  // between positions and stops early, so a copy never waits behind a long
  // sweep — with 10 paper positions a full sweep is ~11s of Jupiter calls.
  private pendingEvents = 0;
  private exitSweepQueued = false;
  // When each position was last priced, so a sweep cut short picks up where
  // it stopped instead of re-checking the same ones first.
  private lastExitCheck = new Map<string, number>();
  // Emptied token accounts waiting to be closed for their rent (see
  // reclaimRent). Closing runs on the trade queue, but only when no trade is
  // waiting: copies stay fast, and no trade's SOL measurement can overlap a
  // rent refund landing (which would count that refund twice).
  private reclaimQueue: Position[] = [];
  private reclaimScheduled = false;
  // What each open position was worth at its last exit check, so reports can
  // show where things stand without spending Jupiter calls of their own.
  private marks = new Map<string, { valueSol: number; at: number }>();
  // With rotation on: the only wallets whose BUYS we copy. Sells are mirrored
  // from any wallet we hold a position from. null = copy every watched wallet.
  private activeWallets: Set<string> | null = null;
  // Wallets whose copies must stay on paper even when DRY_RUN=false: ones the
  // bot discovered itself that haven't proven themselves yet.
  private paperOnly: (wallet: string) => boolean = () => false;

  constructor(
    private readonly config: Config,
    private readonly connection: Connection,
    private readonly keypair: Keypair,
    private readonly jupiter: JupiterClient,
    private readonly store: PositionStore,
    // Where the token gate gets age/liquidity from. Injectable so tests never
    // touch the network.
    private readonly marketSource: MarketSource = fetchDexscreenerMarket
  ) {}

  // Latest known value of an open position, in SOL (undefined until priced).
  currentValue(positionId: string): { valueSol: number; at: number } | undefined {
    return this.marks.get(positionId);
  }

  setPaperOnly(check: (wallet: string) => boolean): void {
    this.paperOnly = check;
  }

  setActiveWallets(wallets: string[] | null): void {
    this.activeWallets = wallets ? new Set(wallets) : null;
  }

  beginShutdown(): void {
    this.shuttingDown = true;
  }

  // Simulated trades ask Jupiter for a price-only quote (no taker), so the
  // wallet is never balance-checked for a swap it will not make. Real trades
  // pass the taker so Jupiter builds a transaction we can sign.
  private orderTaker(simulated: boolean): string | null {
    return simulated ? null : this.keypair.publicKey.toBase58();
  }

  // What the wallet ACTUALLY holds of a mint, summed across its token accounts.
  // Returns null if the chain could not be read (never treat that as zero).
  private async tokenBalanceRaw(mint: string): Promise<bigint | null> {
    try {
      const accounts = await this.connection.getParsedTokenAccountsByOwner(this.keypair.publicKey, {
        mint: new PublicKey(mint),
      });
      let total = 0n;
      for (const account of accounts.value) {
        total += BigInt(account.account.data.parsed.info.tokenAmount.amount);
      }
      return total;
    } catch {
      return null;
    }
  }

  // A filled swap delivers slightly less than the quote promised (that is what
  // slippage IS), and tokens take a moment to appear. Recording the quoted
  // figure made every later sell ask for more than the wallet held, which
  // Jupiter rejects as "Insufficient funds" — stranding the position. So we
  // measure the real delta instead, and only fall back to the quote if the
  // chain cannot be read.
  private async settledDeltaRaw(mint: string, before: bigint, quoted: bigint): Promise<bigint> {
    for (let attempt = 1; attempt <= BALANCE_SETTLE_ATTEMPTS; attempt++) {
      const after = await this.tokenBalanceRaw(mint);
      if (after !== null && after > before) return after - before;
      await sleep(BALANCE_SETTLE_DELAY_MS);
    }
    console.log('   ⚠️ Could not read the delivered token amount; falling back to the quoted figure.');
    return quoted;
  }

  // What a real buy actually took out of the wallet: the swap plus network
  // fees plus token-account rent. Recording only the swap amount made every
  // real trade look ~7% better than it was — the sheet showed a profit while
  // the wallet shrank.
  private async settledSolSpent(beforeLamports: number | null, swapSol: number): Promise<number> {
    if (beforeLamports === null) return swapSol;
    for (let attempt = 1; attempt <= BALANCE_SETTLE_ATTEMPTS; attempt++) {
      const after = await this.solBalanceLamports();
      if (after !== null && after < beforeLamports) {
        const spent = (beforeLamports - after) / 1e9;
        if (spent >= swapSol * 0.5 && spent <= swapSol + MAX_BUY_OVERHEAD_SOL) return spent;
        console.log(`   ⚠️ The wallet balance moved by ${spent.toFixed(4)} SOL during the buy — something else changed it; recording ${swapSol} SOL.`);
        return swapSol;
      }
      await sleep(BALANCE_SETTLE_DELAY_MS);
    }
    return swapSol;
  }

  private queueReclaim(position: Position): void {
    this.reclaimQueue.push(position);
    this.scheduleReclaims();
  }

  private scheduleReclaims(): void {
    // At shutdown the sells run outside the queue; flushReclaims() closes
    // everything once they're all done instead.
    if (this.reclaimScheduled || this.reclaimQueue.length === 0 || this.shuttingDown) return;
    this.reclaimScheduled = true;
    this.queue = this.queue
      .then(async () => {
        this.reclaimScheduled = false;
        await this.runReclaims(false);
      })
      .catch(() => {});
  }

  private async runReclaims(evenIfTradesWait: boolean): Promise<void> {
    while (this.reclaimQueue.length > 0) {
      if (!evenIfTradesWait && this.pendingEvents > 0) return; // trades first; picked up again once they're done
      await this.reclaimRent(this.reclaimQueue.shift()!);
    }
  }

  // Close whatever is still waiting — at shutdown (after the last sells), and in tests.
  async flushReclaims(): Promise<void> {
    await this.queue;
    await this.runReclaims(true);
  }

  // After a real position closes, close its now-empty token account so the
  // ~0.002 SOL of rent returns to the wallet. Never fatal: if it can't be done
  // now, `npm run reclaim` sweeps it up later.
  private async reclaimRent(position: Position): Promise<void> {
    try {
      const empty = await findEmptyAccounts(this.connection, this.keypair.publicKey, { mint: position.mint });
      if (empty.length === 0) return;
      const result = await closeAccounts(this.connection, this.keypair, empty, undefined, { confirmTimeoutMs: 8_000 });
      if (result.reclaimedSol > 0) {
        this.store.addRentBack(position, result.reclaimedSol);
        console.log(`   ♻️  Closed the emptied token account — ${result.reclaimedSol.toFixed(4)} SOL of rent is back in your wallet`);
      }
      if (result.failed.length > 0) {
        console.log(`   (couldn't close ${result.failed.length} empty token account(s): ${result.failed[0].error.slice(0, 80)} — npm run reclaim can retry)`);
      }
    } catch (error) {
      console.log(`   (couldn't close the emptied token account just now: ${(error as Error).message.slice(0, 80)} — npm run reclaim can do it later)`);
    }
  }

  // What the tracked wallet paid on the buy we're copying. Omitted when its
  // trade size couldn't be estimated, rather than recorded as a guess.
  private sourceBuyFields(event: SwapEvent): { sourceBuySol?: number; sourceBuyTokensRaw?: string } {
    if (event.quoteSolEquivalent === null || !(event.quoteSolEquivalent > 0) || event.tokenDeltaRaw <= 0n) return {};
    return { sourceBuySol: event.quoteSolEquivalent, sourceBuyTokensRaw: event.tokenDeltaRaw.toString() };
  }

  private async solBalanceLamports(): Promise<number | null> {
    try {
      return await this.connection.getBalance(this.keypair.publicKey);
    } catch {
      return null;
    }
  }

  // The SOL a real sell actually put back in the wallet — proceeds minus the
  // network fee, after real slippage — instead of the quote. Recording the
  // quote made every real sell look slightly better than it was.
  private async settledSolReceived(beforeLamports: number | null, quotedSol: number): Promise<number> {
    if (beforeLamports === null) return quotedSol;
    for (let attempt = 1; attempt <= BALANCE_SETTLE_ATTEMPTS; attempt++) {
      const after = await this.solBalanceLamports();
      if (after !== null && after > beforeLamports) return (after - beforeLamports) / 1e9;
      await sleep(BALANCE_SETTLE_DELAY_MS);
    }
    console.log('   ⚠️ Could not read the SOL this sell returned; recording the quoted figure.');
    return quotedSol;
  }

  handleSwapEvent(event: SwapEvent): Promise<void> {
    this.pendingEvents++;
    this.queue = this.queue
      .then(() => this.processEvent(event))
      .catch(() => {})
      .finally(() => {
        this.pendingEvents--;
        if (this.pendingEvents === 0) this.scheduleReclaims(); // any closes that waited on trades
      });
    return this.queue;
  }

  private async processEvent(event: SwapEvent): Promise<void> {
    if (this.shuttingDown) {
      console.log('   (shutting down — ignoring new activity)');
      return;
    }
    if (event.side === 'buy') {
      await this.maybeCopyBuy(event);
    } else {
      await this.maybeCopySell(event);
    }
  }

  // ---------------------------------------------------------------- buys ---

  private async maybeCopyBuy(event: SwapEvent): Promise<void> {
    if (this.activeWallets && !this.activeWallets.has(event.sourceWallet)) {
      console.log(`   ↳ skip: ${shortAddress(event.sourceWallet)} is off the active list (benched or dropped) — only its sells are still mirrored`);
      return;
    }
    // Paper for this trade? Always in dry-run; in real mode, still paper for a
    // discovered wallet on probation.
    const simulate = this.config.dryRun || this.paperOnly(event.sourceWallet);
    const onProbation = simulate && !this.config.dryRun;
    const existing = this.store.findOpenByMint(event.mint);
    if (existing) {
      console.log(`   ↳ skip: we already hold a position in ${shortAddress(event.mint)} (${existing.status})`);
      return;
    }
    // Paper and real money have separate caps (and separate counts), so paper
    // copies never crowd out a real one and a low real cap doesn't starve the
    // paper test of data.
    const [cap, capName] = simulate
      ? [this.config.paperMaxOpenPositions, 'PAPER_MAX_OPEN_POSITIONS']
      : [this.config.maxOpenPositions, 'MAX_OPEN_POSITIONS'];
    if (this.store.atRiskCount(simulate) >= cap) {
      console.log(`   ↳ skip: already at ${capName} (${cap}, stuck ones count too)`);
      return;
    }
    if (event.quoteSolEquivalent !== null && event.quoteSolEquivalent < this.config.minTrackedBuySol) {
      console.log(
        `   ↳ skip: tracked buy (~${event.quoteSolEquivalent.toFixed(4)} SOL) is below MIN_TRACKED_BUY_SOL (${this.config.minTrackedBuySol})`
      );
      return;
    }

    // ---- quality gates: the cheap refusals happen BEFORE any Jupiter call ----
    if (this.config.exitRebuyCooldownHours > 0) {
      const since = Date.now() - this.config.exitRebuyCooldownHours * 3_600_000;
      const stoppedOut = this.store.ruleExitSince(event.mint, since);
      if (stoppedOut) {
        console.log(
          `   ↳ skip: we exited ${shortAddress(event.mint)} on our own ${stoppedOut.exitRule} within the last ` +
            `${this.config.exitRebuyCooldownHours}h — not buying straight back in`
        );
        return;
      }
    }
    const mute = walletMute(this.store.all(), event.sourceWallet, Date.now(), this.config);
    if (mute.muted) {
      console.log(`   ↳ skip: 🔇 ${shortAddress(event.sourceWallet)} is muted — ${mute.reason}`);
      return;
    }
    if (tokenGateEnabled(this.config)) {
      const verdict = evaluateToken(await this.marketSource(event.mint), this.config);
      if (!verdict.ok) {
        console.log(`   ↳ skip: ${verdict.reason}`);
        return;
      }
      console.log(`   ↳ token check passed: ${verdict.note}`);
    }

    const spendLamports = BigInt(Math.round(this.config.copyBuyAmountSol * 1e9));

    if (!simulate) {
      const balance = await this.connection.getBalance(this.keypair.publicKey);
      const reserveLamports = Math.round(this.config.minSolReserve * 1e9);
      if (BigInt(balance) < spendLamports + BigInt(reserveLamports)) {
        console.log(
          `   ↳ skip: wallet balance ${(balance / 1e9).toFixed(4)} SOL is too low ` +
            `(need ${this.config.copyBuyAmountSol} + ${this.config.minSolReserve} reserve)`
        );
        return;
      }
    }

    console.log(`   ↳ copying: buying ${this.config.copyBuyAmountSol} SOL of ${shortAddress(event.mint)}…`);

    let order;
    try {
      order = await this.jupiter.getOrder({
        inputMint: SOL_MINT,
        outputMint: event.mint,
        amountRaw: spendLamports,
        takerPubkey: this.orderTaker(simulate),
        slippageBps: this.config.slippageBps,
      });
    } catch (error) {
      const jupError = error as JupiterError;
      if (jupError.kind === 'no-route') {
        console.log(`   ↳ skip: Jupiter has no route for ${shortAddress(event.mint)} (token too new/illiquid)`);
      } else {
        console.error(`   ↳ buy failed while getting order: ${jupError.message}`);
      }
      return;
    }

    const expectedTokens = Number(order.outAmountRaw) / 10 ** event.decimals;

    if (simulate) {
      if (onProbation) {
        console.log(`   ↳ ${shortAddress(event.sourceWallet)} was found by discovery and is still on probation — PAPER trade, no real SOL`);
      }
      const position = this.store.openPosition({
        mint: event.mint,
        decimals: event.decimals,
        sourceWallet: event.sourceWallet,
        ...this.sourceBuyFields(event),
        dryRun: true,
        spentSol: this.config.copyBuyAmountSol,
        tokenAmountRaw: order.outAmountRaw.toString(),
      });
      console.log(
        `   ✅ [DRY RUN] SIMULATED buy: ${expectedTokens.toLocaleString()} ${shortAddress(event.mint)} ` +
          `for ${this.config.copyBuyAmountSol} SOL (position ${position.id})`
      );
      notify('Simulated buy', `${this.config.copyBuyAmountSol} SOL of ${shortAddress(event.mint)} (dry run)`, 'buy', true);
      return;
    }

    if (!order.transactionBase64) {
      console.error('   ↳ buy failed: Jupiter order came back without a transaction to sign');
      return;
    }
    // Read the balance BEFORE signing so the delta is unambiguous even if the
    // wallet already held some of this mint.
    const balanceBefore = (await this.tokenBalanceRaw(event.mint)) ?? 0n;
    const solBefore = await this.solBalanceLamports();
    try {
      const signature = await this.signAndExecute(order.transactionBase64, order.requestId);
      const receivedRaw = await this.settledDeltaRaw(event.mint, balanceBefore, order.outAmountRaw);
      const spentSol = await this.settledSolSpent(solBefore, this.config.copyBuyAmountSol);
      const receivedTokens = Number(receivedRaw) / 10 ** event.decimals;
      const position = this.store.openPosition({
        mint: event.mint,
        decimals: event.decimals,
        sourceWallet: event.sourceWallet,
        ...this.sourceBuyFields(event),
        dryRun: false,
        spentSol,
        swapSol: this.config.copyBuyAmountSol,
        tokenAmountRaw: receivedRaw.toString(),
        buyTx: signature,
      });
      const slippedPct = ((Number(receivedRaw) / Number(order.outAmountRaw) - 1) * 100).toFixed(2);
      const overhead = spentSol - this.config.copyBuyAmountSol;
      console.log(
        `   ✅ REAL buy confirmed: ${receivedTokens.toLocaleString()} ${shortAddress(event.mint)} ` +
          `for ${this.config.copyBuyAmountSol} SOL` +
          (overhead > 0.00001 ? ` + ${overhead.toFixed(4)} fees/rent (rent comes back after selling)` : '') +
          ` (quoted ${expectedTokens.toLocaleString()}, ${slippedPct}%)\n` +
          `      position ${position.id}\n` +
          `      https://solscan.io/tx/${signature}`
      );
      notify(
        '🟢 BOUGHT',
        `${this.config.copyBuyAmountSol} SOL of ${shortAddress(event.mint)} — copied from ${shortAddress(event.sourceWallet)}`,
        'buy',
        false
      );
    } catch (error) {
      console.error(`   ↳ REAL buy failed (no position opened): ${(error as Error).message}`);
    }
  }

  // --------------------------------------------------------------- sells ---

  private async maybeCopySell(event: SwapEvent): Promise<void> {
    // Record what THEY got for it first — even if we've already exited on our
    // own stop-loss. That's how the summary learns whether our exit helped.
    const copied = this.store.latestByMintAndSource(event.mint, event.sourceWallet, Date.now() - SOURCE_ATTRIBUTION_MS);
    if (copied && event.quoteSolEquivalent !== null && event.quoteSolEquivalent > 0) {
      this.store.recordSourceSell(copied, event.quoteSolEquivalent, event.tokenDeltaRaw);
    }

    const position = this.store.findOpenByMintAndSource(event.mint, event.sourceWallet);
    if (!position) {
      console.log(`   ↳ no open position from this wallet in ${shortAddress(event.mint)} — nothing to mirror`);
      return;
    }

    // Mirror the fraction they sold. Selling >90% of their bag counts as a full exit.
    let fraction = 1;
    if (event.ownerPreTokenRaw > 0n) {
      fraction = Number(event.tokenDeltaRaw) / Number(event.ownerPreTokenRaw);
    }
    if (!Number.isFinite(fraction) || fraction > 0.9) fraction = 1;
    if (fraction <= 0) return;

    const percent = Math.round(fraction * 100);
    await this.sellPosition(position, fraction, `tracked wallet sold ~${percent}%`);
  }

  // Sell `fraction` (0..1] of a position, with retries. Returns true on success.
  async sellPosition(position: Position, fraction: number, reason: string): Promise<boolean> {
    if (position.status === 'stuck') this.store.reopenStuck(position);

    let held = BigInt(position.tokenAmountRaw);

    // For real positions the chain is the authority, not our record. Asking to
    // sell more than the wallet holds is rejected as "Insufficient funds" and
    // would strand a perfectly sellable position. A single RPC hiccup here
    // (network blip, rate limit) must not silently fall back to a stale
    // recorded amount — that reproduces the exact failure this check exists
    // to prevent — so retry a few times before giving up on reading it.
    if (!position.dryRun) {
      let onChain: bigint | null = null;
      for (let attempt = 1; attempt <= BALANCE_CHECK_ATTEMPTS; attempt++) {
        onChain = await this.tokenBalanceRaw(position.mint);
        if (onChain !== null) break;
        if (attempt < BALANCE_CHECK_ATTEMPTS) await sleep(BALANCE_CHECK_RETRY_DELAY_MS);
      }
      if (onChain === null) {
        console.log(`   ↳ could not read the wallet balance after ${BALANCE_CHECK_ATTEMPTS} attempts; using the recorded amount`);
      } else if (onChain === 0n) {
        // Nothing left to sell — most likely you sold it yourself outside the
        // bot. Not stuck (nothing is failing) and not closed (we don't know
        // what it sold for, so no P&L is recorded). Freed from the position
        // count either way, so it stops occupying a slot forever.
        this.store.markAbandoned(position, 'wallet holds none of this token — likely sold outside the bot');
        console.log(
          `\n   ℹ️  Position ${position.id} (${shortAddress(position.mint)}) holds ZERO tokens on-chain.\n` +
            '      Marked as abandoned (not stuck) — the slot is now free. If you sold this\n' +
            '      yourself, that\'s expected; P&L for it is not tracked since we don\'t know\n' +
            '      what it sold for.\n'
        );
        return true;
      } else {
        if (onChain !== held) {
          console.log(`   ↳ wallet holds ${onChain} raw units (record said ${held}) — trusting the chain`);
        }
        held = onChain;
        position.tokenAmountRaw = held.toString();
      }
    }

    const sellRaw = fraction >= 1 ? held : (held * BigInt(Math.round(fraction * 1_000_000))) / 1_000_000n;
    if (sellRaw <= 0n) return true;

    const uiAmount = Number(sellRaw) / 10 ** position.decimals;
    const mode = position.dryRun ? '[DRY RUN] ' : '';
    console.log(
      `   ↳ ${mode}selling ${Math.round(fraction * 100)}% of ${shortAddress(position.mint)} ` +
        `(${uiAmount.toLocaleString()} tokens) — ${reason}`
    );

    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= SELL_ATTEMPTS; attempt++) {
      try {
        const order = await this.jupiter.getOrder({
          inputMint: position.mint,
          outputMint: SOL_MINT,
          amountRaw: sellRaw,
          takerPubkey: this.orderTaker(position.dryRun),
          slippageBps: this.config.slippageBps,
        });
        const quotedSol = Number(order.outAmountRaw) / 1e9;

        if (position.dryRun) {
          const receivedSol = quotedSol;
          this.store.recordSell(position, sellRaw, receivedSol);
          this.announceMuteIfTriggered(position);
          console.log(
            `   ✅ [DRY RUN] SIMULATED sell: received ~${receivedSol.toFixed(4)} SOL` +
              (position.status === 'closed' ? ' — position CLOSED' : ' — position still partially open')
          );
          notify('Simulated sell', `${shortAddress(position.mint)} for ~${receivedSol.toFixed(4)} SOL (dry run)`, 'sell', true);
          return true;
        }

        if (!order.transactionBase64) throw new Error('Jupiter order came back without a transaction to sign');
        const solBefore = await this.solBalanceLamports();
        const signature = await this.signAndExecute(order.transactionBase64, order.requestId);
        const receivedSol = await this.settledSolReceived(solBefore, quotedSol);
        this.store.recordSell(position, sellRaw, receivedSol, signature);
        this.announceMuteIfTriggered(position);
        console.log(
          `   ✅ REAL sell confirmed: ${receivedSol.toFixed(4)} SOL received (quoted ${quotedSol.toFixed(4)})` +
            (position.status === 'closed' ? ' — position CLOSED' : ' — position still partially open') +
            `\n      https://solscan.io/tx/${signature}`
        );
        if (position.status === 'closed') this.queueReclaim(position);
        // A closed trade's result: everything it returned (earlier partial sells
        // and rent included) against everything it cost.
        const pnl = position.status === 'closed' ? position.receivedSol - position.spentSol : receivedSol - position.spentSol;
        notify(
          pnl >= 0 ? '🟢 SOLD (profit)' : '🔴 SOLD (loss)',
          `${shortAddress(position.mint)}: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`,
          'sell',
          false
        );
        return true;
      } catch (error) {
        lastError = (error as Error).message;
        console.error(`   ↳ sell attempt ${attempt}/${SELL_ATTEMPTS} failed: ${lastError}`);
        if (attempt < SELL_ATTEMPTS) await sleep(SELL_RETRY_DELAY_MS * attempt);
      }
    }

    // IMPORTANT: a failed sell is NOT a closed position. The tokens are still
    // in the wallet (or, in dry-run, would be). Track it as stuck and say so.
    this.store.markStuck(position, lastError);
    notify('⚠️ SELL FAILED — position stuck', `${shortAddress(position.mint)} — tokens still in your wallet`, 'fail', position.dryRun);
    console.error(
      `\n   🔴 SELL FAILED after ${SELL_ATTEMPTS} attempts — position ${position.id} is now STUCK.\n` +
        `      Token ${position.mint}\n` +
        (position.dryRun
          ? '      (dry-run: simulated tokens would still be in your wallet)\n'
          : '      ⚠️  These tokens are STILL IN YOUR WALLET. Not counted in realized P&L.\n' +
            '      You can retry later by restarting the bot and pressing Ctrl+C (shutdown retries stuck sells),\n' +
            '      or sell manually in Phantom/Jupiter.\n')
    );
    return false;
  }

  // After a position closes at a loss: if that loss completed a losing streak,
  // say so once, right here where the user is looking.
  private announceMuteIfTriggered(position: Position): void {
    if (position.status !== 'closed' || position.receivedSol >= position.spentSol) return;
    const mute = walletMute(this.store.all(), position.sourceWallet, Date.now(), this.config);
    if (mute.muted) {
      console.log(
        `   🔇 ${shortAddress(position.sourceWallet)}: ${mute.reason}.\n` +
          '      Its open positions are still mirrored; new buys from it are skipped.'
      );
    }
  }

  // ---------------------------------------------------------- own exits ---

  // Price every open position and act on our own exit rules. Queued behind
  // trade events on the same chain, so a stop-loss can never race a copied
  // sell on the same position.
  checkExits(): Promise<void> {
    // One sweep at a time: if the last one is still waiting, don't stack another.
    if (this.exitSweepQueued) return this.queue;
    this.exitSweepQueued = true;
    this.queue = this.queue
      .then(() => {
        this.exitSweepQueued = false;
        return this.runExitChecks();
      })
      .catch(() => {});
    return this.queue;
  }

  private async runExitChecks(): Promise<void> {
    if (this.shuttingDown || !exitRulesEnabled(this.config)) return;
    // Only 'open' positions: a stuck one cannot be sold anyway, and an
    // abandoned one holds nothing. Least recently checked first.
    const due = this.store
      .byStatus('open')
      .sort((a, b) => (this.lastExitCheck.get(a.id) ?? 0) - (this.lastExitCheck.get(b.id) ?? 0));
    const openIds = new Set(due.map((p) => p.id));
    for (const id of this.lastExitCheck.keys()) if (!openIds.has(id)) this.lastExitCheck.delete(id);
    for (const id of this.marks.keys()) if (!openIds.has(id)) this.marks.delete(id);
    for (const position of due) {
      if (this.shuttingDown) return;
      if (this.pendingEvents > 0) return; // a trade is waiting — it goes first; the rest are checked next sweep
      this.lastExitCheck.set(position.id, Date.now());
      const remaining = BigInt(position.tokenAmountRaw);
      if (remaining <= 0n) continue;

      let valueSol: number;
      try {
        const order = await this.jupiter.getOrder({
          inputMint: position.mint,
          outputMint: SOL_MINT,
          amountRaw: remaining,
          takerPubkey: null, // quote only — nothing is built, signed or balance-checked
          slippageBps: this.config.slippageBps,
        });
        valueSol = Number(order.outAmountRaw) / 1e9;
        this.marks.set(position.id, { valueSol, at: Date.now() });
      } catch (error) {
        // Unpriceable means unsellable too, so there is nothing to act on —
        // and guessing a value here could fire a stop-loss on a number we
        // made up. Say so and leave it alone.
        const kind = (error as JupiterError).kind;
        console.log(
          `   ⚠️ could not price ${shortAddress(position.mint)} for exit rules` +
            (kind === 'no-route' ? ' (no route — nothing will buy it right now)' : '')
        );
        continue;
      }

      // Gains are measured against the swap itself (swapSol), not the fees and
      // refundable rent on top, so a +30% take-profit means +30% on the trade.
      const decision = decideExit({ ...position, spentSol: position.swapSol ?? position.spentSol }, valueSol, this.config);
      this.store.updatePeak(position, decision.peakValueSol);
      if (decision.action === 'hold') continue;

      console.log(`\n   🎯 EXIT RULE on ${shortAddress(position.mint)} — ${decision.reason}`);
      this.store.noteExitRule(position, decision.rule);
      await this.sellPosition(position, 1, decision.reason);
    }
  }

  // Called on shutdown: try once to exit everything (open first, then stuck).
  // Guarded so a second Ctrl+C can never trigger a second round of sells.
  async closeAllPositions(reason: string): Promise<void> {
    if (this.closeAllStarted) return;
    this.closeAllStarted = true;

    const toClose = [...this.store.byStatus('open'), ...this.store.byStatus('stuck')];
    if (toClose.length === 0) {
      console.log('No open positions to close.');
      return;
    }
    console.log(`Attempting to close ${toClose.length} position(s)…`);
    for (const position of toClose) {
      await this.sellPosition(position, 1, reason);
    }
  }

  private async signAndExecute(transactionBase64: string, requestId: string): Promise<string> {
    const transaction = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
    transaction.sign([this.keypair]);
    const signedBase64 = Buffer.from(transaction.serialize()).toString('base64');
    const { signature } = await this.jupiter.execute(signedBase64, requestId);
    return signature;
  }
}
