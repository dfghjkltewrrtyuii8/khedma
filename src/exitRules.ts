// Exits on OUR terms, not the tracked wallet's.
//
// Until now the bot only sold when the wallet it copied sold — so it rode
// their timing down, plus the 5-15s it takes us to see and act on it. The
// ARJh position closed at -78% that way. A stop-loss would have capped it
// without needing to know anything about the wallet or the token.
//
// These rules are pure functions over a position's current value, so every
// case below is decided identically in a test and in a live run.
//
// A note on TAKE_PROFIT, because it is the tempting one and it is a trap:
// this strategy's returns are carried by rare outliers. In the dry run, eight
// of nine positions lost and a single +984% winner carried the whole set. A
// take-profit at +50% would have sold that winner early and turned a positive
// set into a negative one. Capping the upside of an outlier-driven strategy
// is how you guarantee it loses. TRAILING_STOP does the job properly: it lets
// a runner run and only exits once it gives back ground from its own peak.

import { Config } from './config';
import { ExitRule } from './types';

export type ExitConfig = Pick<
  Config,
  'takeProfitPercent' | 'stopLossPercent' | 'trailingStopPercent'
>;

export interface ExitCandidate {
  spentSol: number;
  receivedSol: number; // proceeds already banked from partial sells
  peakValueSol?: number; // highest total value seen so far, if we've priced it before
}

export type ExitDecision =
  | { action: 'hold'; peakValueSol: number; pnlPercent: number }
  | { action: 'exit'; rule: ExitRule; reason: string; peakValueSol: number; pnlPercent: number };

export function exitRulesEnabled(config: ExitConfig): boolean {
  return config.takeProfitPercent > 0 || config.stopLossPercent > 0 || config.trailingStopPercent > 0;
}

function pct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

// `currentValueSol` is what the REMAINING tokens would fetch right now.
export function decideExit(
  position: ExitCandidate,
  currentValueSol: number,
  config: ExitConfig
): ExitDecision {
  // What the position is worth in total: what it would fetch now, plus
  // anything already banked from a partial sell.
  const total = currentValueSol + position.receivedSol;
  const peakValueSol = Math.max(position.peakValueSol ?? total, total);
  // A position that cost nothing has no percentage to measure against; hold
  // rather than divide by zero.
  const pnlPercent = position.spentSol > 0 ? ((total - position.spentSol) / position.spentSol) * 100 : 0;
  const hold: ExitDecision = { action: 'hold', peakValueSol, pnlPercent };
  if (position.spentSol <= 0) return hold;

  if (config.takeProfitPercent > 0 && pnlPercent >= config.takeProfitPercent) {
    return {
      action: 'exit',
      rule: 'take-profit',
      reason: `take-profit: ${pct(pnlPercent)} is at or above +${config.takeProfitPercent}%`,
      peakValueSol,
      pnlPercent,
    };
  }

  if (config.stopLossPercent > 0 && pnlPercent <= -config.stopLossPercent) {
    return {
      action: 'exit',
      rule: 'stop-loss',
      reason: `stop-loss: ${pct(pnlPercent)} is at or below -${config.stopLossPercent}%`,
      peakValueSol,
      pnlPercent,
    };
  }

  // The trailing stop only arms once the position has actually been in profit.
  // Below cost, a "drop from peak" is just the loss the stop-loss already
  // governs, and arming it there would exit every position twice as fast as
  // intended.
  if (config.trailingStopPercent > 0 && peakValueSol > position.spentSol && peakValueSol > 0) {
    const dropFromPeakPercent = ((peakValueSol - total) / peakValueSol) * 100;
    if (dropFromPeakPercent >= config.trailingStopPercent) {
      const peakPnlPercent = ((peakValueSol - position.spentSol) / position.spentSol) * 100;
      return {
        action: 'exit',
        rule: 'trailing-stop',
        reason:
          `trailing-stop: down ${dropFromPeakPercent.toFixed(1)}% from its peak of ${pct(peakPnlPercent)} ` +
          `(now ${pct(pnlPercent)})`,
        peakValueSol,
        pnlPercent,
      };
    }
  }

  return hold;
}

// One line describing the active rules, for the startup banner.
export function describeExitRules(config: ExitConfig): string {
  if (!exitRulesEnabled(config)) return 'exits OFF (only sells when the tracked wallet sells)';
  const parts: string[] = [];
  if (config.stopLossPercent > 0) parts.push(`stop-loss -${config.stopLossPercent}%`);
  if (config.takeProfitPercent > 0) parts.push(`take-profit +${config.takeProfitPercent}%`);
  if (config.trailingStopPercent > 0) parts.push(`trailing stop ${config.trailingStopPercent}% off peak`);
  return parts.join(', ');
}
