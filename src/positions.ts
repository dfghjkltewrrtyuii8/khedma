// Position storage, persisted to data/positions.json so a restart (or crash)
// never forgets what the bot bought. Writes are atomic (write temp file, then
// rename) so a crash mid-write can't corrupt the file.

import fs from 'fs';
import path from 'path';
import { ExitRule, Position, PositionStatus } from './types';

export class PositionStore {
  private positions: Position[] = [];
  private readonly dataDir: string;
  private readonly storePath: string;

  // dataDir is overridable so tests can use a scratch directory and never
  // touch the real data/positions.json.
  constructor(dataDir: string = path.join(process.cwd(), 'data')) {
    this.dataDir = dataDir;
    this.storePath = path.join(dataDir, 'positions.json');
  }

  load(): void {
    if (!fs.existsSync(this.storePath)) return;
    const raw = fs.readFileSync(this.storePath, 'utf8');
    this.positions = JSON.parse(raw) as Position[];
  }

  private save(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tempPath = `${this.storePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.positions, null, 2));
    fs.renameSync(tempPath, this.storePath);
  }

  all(): readonly Position[] {
    return this.positions;
  }

  byStatus(status: PositionStatus): Position[] {
    return this.positions.filter((p) => p.status === status);
  }

  // Positions still tying up capital: open AND stuck both count.
  atRiskCount(): number {
    return this.positions.filter((p) => p.status === 'open' || p.status === 'stuck').length;
  }

  findOpenByMint(mint: string): Position | undefined {
    return this.positions.find((p) => p.mint === mint && (p.status === 'open' || p.status === 'stuck'));
  }

  findOpenByMintAndSource(mint: string, sourceWallet: string): Position | undefined {
    return this.positions.find((p) => p.mint === mint && p.sourceWallet === sourceWallet && p.status === 'open');
  }

  openPosition(input: Omit<Position, 'id' | 'status' | 'openedAt' | 'receivedSol' | 'sellTxs' | 'initialTokenAmountRaw'>): Position {
    const position: Position = {
      ...input,
      id: `pos-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      status: 'open',
      openedAt: new Date().toISOString(),
      receivedSol: 0,
      sellTxs: [],
      initialTokenAmountRaw: input.tokenAmountRaw,
    };
    this.positions.push(position);
    this.save();
    return position;
  }

  // Record a successful (full or partial) sell.
  recordSell(position: Position, soldRaw: bigint, receivedSol: number, sellTx?: string): void {
    const remaining = BigInt(position.tokenAmountRaw) - soldRaw;
    position.tokenAmountRaw = (remaining > 0n ? remaining : 0n).toString();
    position.receivedSol += receivedSol;
    if (sellTx) position.sellTxs.push(sellTx);
    if (BigInt(position.tokenAmountRaw) === 0n) {
      position.status = 'closed';
      position.closedAt = new Date().toISOString();
    }
    this.save();
  }

  // Remember the highest value a position has reached, so the trailing stop
  // survives a restart instead of resetting its peak to whatever it is worth
  // the moment the bot comes back up.
  updatePeak(position: Position, peakValueSol: number): void {
    if (position.peakValueSol !== undefined && peakValueSol <= position.peakValueSol) return;
    position.peakValueSol = peakValueSol;
    this.save();
  }

  // Record that one of OUR rules is closing this position, not the tracked
  // wallet's sell. Written before the sell is attempted, so a sell that fails
  // and goes stuck still shows why we were trying to get out.
  noteExitRule(position: Position, rule: ExitRule): void {
    position.exitRule = rule;
    this.save();
  }

  // Positions this mint was closed out of by our own exit rule since `since`.
  // Used to stop the bot buying straight back into something it just stopped
  // out of, which would otherwise happen the moment the tracked wallet buys
  // more of it.
  ruleExitSince(mint: string, since: number): Position | undefined {
    return this.positions.find(
      (p) =>
        p.mint === mint &&
        p.exitRule !== undefined &&
        p.status === 'closed' &&
        Date.parse(p.closedAt ?? '') >= since
    );
  }

  // The most recent position we opened on this token copying this wallet, if
  // opened since `since` — whatever its status now. Their sells often arrive
  // after our own stop-loss has already closed ours; this is how those still
  // get attributed.
  latestByMintAndSource(mint: string, sourceWallet: string, since: number): Position | undefined {
    let latest: Position | undefined;
    for (const p of this.positions) {
      if (p.mint !== mint || p.sourceWallet !== sourceWallet) continue;
      const opened = Date.parse(p.openedAt);
      if (!(opened >= since)) continue;
      if (!latest || opened >= Date.parse(latest.openedAt)) latest = p;
    }
    return latest;
  }

  // Accumulate what the tracked wallet received selling this token.
  recordSourceSell(position: Position, sol: number, tokensRaw: bigint): void {
    position.sourceSellSol = (position.sourceSellSol ?? 0) + sol;
    position.sourceSellTokensRaw = (BigInt(position.sourceSellTokensRaw ?? '0') + tokensRaw).toString();
    this.save();
  }

  // A sell PERMANENTLY failed: the tokens are still sitting in the wallet.
  // This is deliberately NOT "closed" — we never record fake P&L.
  markStuck(position: Position, reason: string): void {
    position.status = 'stuck';
    position.stuckReason = reason;
    this.save();
  }

  // A previously-stuck position we're retrying goes back to open first,
  // so a successful retry can close it normally.
  reopenStuck(position: Position): void {
    if (position.status === 'stuck') {
      position.status = 'open';
      delete position.stuckReason;
      this.save();
    }
  }

  // The wallet holds ZERO of this token even though our record says we
  // should still have some. For a real position that almost always means it
  // was sold outside the bot (manually, or by another tool) — there is
  // nothing left to sell, so this frees the position slot. Deliberately NOT
  // "closed": we don't know what it sold for, so no P&L is recorded either
  // way, and it's reported separately so you can reconcile it yourself.
  markAbandoned(position: Position, reason: string): void {
    position.status = 'abandoned';
    position.abandonedReason = reason;
    position.tokenAmountRaw = '0';
    this.save();
  }
}
