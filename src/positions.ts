// Position storage, persisted to data/positions.json so a restart (or crash)
// never forgets what the bot bought. Writes are atomic (write temp file, then
// rename) so a crash mid-write can't corrupt the file.

import fs from 'fs';
import path from 'path';
import { Position, PositionStatus } from './types';

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
}
