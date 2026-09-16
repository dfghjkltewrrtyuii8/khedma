// Wallet quality gate: stop copying a wallet that keeps losing us money.
//
// The bot copies 5–15 seconds behind the tracked wallet, so a wallet whose
// edge is speed (scalps, bonding-curve flips) loses for us even while it wins
// for them. There is no way to know that up front — only by watching what
// its copies actually returned. So: after N copied positions in a row closed
// at a loss, the wallet is MUTED for a cooling-off period. Its open positions
// are still mirrored (sells are never blocked); only new buys are skipped.
//
// Everything here is derived from the position history — no extra state to
// persist, nothing to drift out of sync. A muted wallet gets one more chance
// when the window expires; if that loses too, the streak continues and it is
// muted again from that loss.

import { Config } from './config';
import { Position } from './types';

export type WalletGateConfig = Pick<Config, 'walletMaxConsecutiveLosses' | 'walletMuteHours'>;

export interface WalletRecord {
  wallet: string;
  closed: number;
  wins: number;
  losses: number;
  netSol: number;
  consecutiveLosses: number; // counted back from the most recent close
  lastClosedAt: number | null; // epoch ms
}

export interface WalletMute {
  muted: boolean;
  reason?: string;
  until?: number; // epoch ms; absent when the mute never expires
}

function isLoss(position: Position): boolean {
  return position.receivedSol < position.spentSol;
}

// Per-wallet tally over CLOSED positions only (simulated and real alike — a
// loss on paper is evidence too, and paper is the optimistic case). Stuck and
// abandoned positions have no known outcome and are not counted.
export function walletRecords(positions: readonly Position[]): Map<string, WalletRecord> {
  const closed = positions
    .filter((p) => p.status === 'closed')
    .map((p) => ({ p, t: Date.parse(p.closedAt ?? p.openedAt) || 0 }))
    .sort((a, b) => a.t - b.t);

  const records = new Map<string, WalletRecord>();
  for (const { p, t } of closed) {
    let record = records.get(p.sourceWallet);
    if (!record) {
      record = { wallet: p.sourceWallet, closed: 0, wins: 0, losses: 0, netSol: 0, consecutiveLosses: 0, lastClosedAt: null };
      records.set(p.sourceWallet, record);
    }
    record.closed += 1;
    record.netSol += p.receivedSol - p.spentSol;
    if (isLoss(p)) {
      record.losses += 1;
      record.consecutiveLosses += 1;
    } else {
      record.wins += 1;
      record.consecutiveLosses = 0;
    }
    record.lastClosedAt = t;
  }
  return records;
}

export function walletMute(
  positions: readonly Position[],
  wallet: string,
  now: number,
  config: WalletGateConfig
): WalletMute {
  if (config.walletMaxConsecutiveLosses <= 0) return { muted: false };
  const record = walletRecords(positions).get(wallet);
  if (!record || record.lastClosedAt === null) return { muted: false };
  if (record.consecutiveLosses < config.walletMaxConsecutiveLosses) return { muted: false };

  const streak = `${record.consecutiveLosses} copied losses in a row`;
  if (config.walletMuteHours <= 0) {
    return { muted: true, reason: `${streak} — muted until you remove it from TRACKED_WALLETS (WALLET_MUTE_HOURS=0)` };
  }
  const until = record.lastClosedAt + config.walletMuteHours * 3_600_000;
  if (now >= until) return { muted: false };
  return { muted: true, until, reason: `${streak} — muted until ${new Date(until).toLocaleString()}` };
}
