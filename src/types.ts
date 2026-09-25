// Shared types used across the bot.

// A swap we detected in a tracked wallet's confirmed transaction.
export interface SwapEvent {
  signature: string;
  sourceWallet: string; // the tracked wallet that made the trade
  side: 'buy' | 'sell';
  mint: string; // the (non-SOL/stablecoin) token that was traded
  decimals: number;
  tokenDeltaRaw: bigint; // how many raw token units the wallet gained/lost (always positive)
  ownerPreTokenRaw: bigint; // wallet's token balance BEFORE the trade (raw units)
  // Roughly how much the tracked wallet spent/received, expressed in SOL.
  // null when we couldn't estimate it (e.g. USDC-quoted trade and no USD price).
  quoteSolEquivalent: number | null;
}

export type PositionStatus = 'open' | 'closed' | 'stuck' | 'abandoned';

// Which of OUR own rules closed a position, when it wasn't the tracked
// wallet's sell that triggered it. Absent = we mirrored their exit.
export type ExitRule = 'take-profit' | 'stop-loss' | 'trailing-stop';

export interface Position {
  id: string;
  mint: string;
  decimals: number;
  sourceWallet: string; // whose trade we copied; we only mirror sells from this wallet
  dryRun: boolean; // true = this position is simulated, no real tokens involved
  status: PositionStatus;
  openedAt: string; // ISO timestamp
  closedAt?: string;
  spentSol: number; // SOL we paid to open — for real buys, everything that left the wallet (swap + fees + token-account rent)
  swapSol?: number; // real buys: what went into the swap itself; the exit rules measure gains against this
  rentBackSol?: number; // token-account rent returned when the emptied account was closed (counted in receivedSol)
  tokenAmountRaw: string; // raw token units still held (stringified bigint)
  initialTokenAmountRaw: string; // raw token units at open (for % display)
  receivedSol: number; // SOL received back from sells so far
  buyTx?: string; // real buy signature (absent in dry-run)
  sellTxs: string[]; // real sell signatures
  stuckReason?: string; // why a sell permanently failed — tokens still in wallet!
  abandonedReason?: string; // why we stopped tracking it — wallet holds none of this token, so it was almost certainly sold outside the bot
  peakValueSol?: number; // highest total value seen while priced, for the trailing stop
  exitRule?: ExitRule; // set when one of our own exit rules closed it, not the tracked wallet
  // What the TRACKED wallet paid and got for this token: its buy that we
  // copied, and every sell of it we saw afterwards (including ones that came
  // after we had already exited). Lets the summary say whether a loss was
  // their pick or our timing. See copyGap.ts.
  sourceBuySol?: number;
  sourceBuyTokensRaw?: string;
  sourceSellSol?: number;
  sourceSellTokensRaw?: string;
}
