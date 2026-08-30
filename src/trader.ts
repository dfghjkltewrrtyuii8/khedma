// Turns detected swaps into our own (copied) trades.
//
// Sizing is deliberately fixed and small: every copied buy spends exactly
// COPY_BUY_AMOUNT_SOL, regardless of how big the tracked wallet's trade was.
// Sells mirror the tracked wallet proportionally (they sold 50% -> we sell 50%).

import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { Config, SOL_MINT } from './config';
import { JupiterClient, JupiterError } from './jupiter';
import { PositionStore } from './positions';
import { sleep } from './rateLimiter';
import { Position, SwapEvent } from './types';
import { shortAddress } from './watcher';

const SELL_ATTEMPTS = 3; // thin tokens can lose their route in seconds — retry, but don't loop forever
const SELL_RETRY_DELAY_MS = 2_000;

export class Trader {
  private shuttingDown = false;
  private closeAllStarted = false;
  // Events are processed one at a time so two near-simultaneous trades can't
  // race past the position-count checks.
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: Config,
    private readonly connection: Connection,
    private readonly keypair: Keypair,
    private readonly jupiter: JupiterClient,
    private readonly store: PositionStore
  ) {}

  beginShutdown(): void {
    this.shuttingDown = true;
  }

  handleSwapEvent(event: SwapEvent): Promise<void> {
    this.queue = this.queue.then(() => this.processEvent(event)).catch(() => {});
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
    const existing = this.store.findOpenByMint(event.mint);
    if (existing) {
      console.log(`   ↳ skip: we already hold a position in ${shortAddress(event.mint)} (${existing.status})`);
      return;
    }
    if (this.store.atRiskCount() >= this.config.maxOpenPositions) {
      console.log(`   ↳ skip: already at MAX_OPEN_POSITIONS (${this.config.maxOpenPositions}, stuck ones count too)`);
      return;
    }
    if (event.quoteSolEquivalent !== null && event.quoteSolEquivalent < this.config.minTrackedBuySol) {
      console.log(
        `   ↳ skip: tracked buy (~${event.quoteSolEquivalent.toFixed(4)} SOL) is below MIN_TRACKED_BUY_SOL (${this.config.minTrackedBuySol})`
      );
      return;
    }

    const spendLamports = BigInt(Math.round(this.config.copyBuyAmountSol * 1e9));

    if (!this.config.dryRun) {
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
        takerPubkey: this.keypair.publicKey.toBase58(),
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

    if (this.config.dryRun) {
      const position = this.store.openPosition({
        mint: event.mint,
        decimals: event.decimals,
        sourceWallet: event.sourceWallet,
        dryRun: true,
        spentSol: this.config.copyBuyAmountSol,
        tokenAmountRaw: order.outAmountRaw.toString(),
      });
      console.log(
        `   ✅ [DRY RUN] SIMULATED buy: ${expectedTokens.toLocaleString()} ${shortAddress(event.mint)} ` +
          `for ${this.config.copyBuyAmountSol} SOL (position ${position.id})`
      );
      return;
    }

    if (!order.transactionBase64) {
      console.error('   ↳ buy failed: Jupiter order came back without a transaction to sign');
      return;
    }
    try {
      const signature = await this.signAndExecute(order.transactionBase64, order.requestId);
      const position = this.store.openPosition({
        mint: event.mint,
        decimals: event.decimals,
        sourceWallet: event.sourceWallet,
        dryRun: false,
        spentSol: this.config.copyBuyAmountSol,
        tokenAmountRaw: order.outAmountRaw.toString(),
        buyTx: signature,
      });
      console.log(
        `   ✅ REAL buy confirmed: ~${expectedTokens.toLocaleString()} ${shortAddress(event.mint)} ` +
          `for ${this.config.copyBuyAmountSol} SOL (position ${position.id})\n` +
          `      https://solscan.io/tx/${signature}`
      );
    } catch (error) {
      console.error(`   ↳ REAL buy failed (no position opened): ${(error as Error).message}`);
    }
  }

  // --------------------------------------------------------------- sells ---

  private async maybeCopySell(event: SwapEvent): Promise<void> {
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

    const held = BigInt(position.tokenAmountRaw);
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
          takerPubkey: this.keypair.publicKey.toBase58(),
          slippageBps: this.config.slippageBps,
        });
        const receivedSol = Number(order.outAmountRaw) / 1e9;

        if (position.dryRun) {
          this.store.recordSell(position, sellRaw, receivedSol);
          console.log(
            `   ✅ [DRY RUN] SIMULATED sell: received ~${receivedSol.toFixed(4)} SOL` +
              (position.status === 'closed' ? ' — position CLOSED' : ' — position still partially open')
          );
          return true;
        }

        if (!order.transactionBase64) throw new Error('Jupiter order came back without a transaction to sign');
        const signature = await this.signAndExecute(order.transactionBase64, order.requestId);
        this.store.recordSell(position, sellRaw, receivedSol, signature);
        console.log(
          `   ✅ REAL sell confirmed: ~${receivedSol.toFixed(4)} SOL` +
            (position.status === 'closed' ? ' — position CLOSED' : ' — position still partially open') +
            `\n      https://solscan.io/tx/${signature}`
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
