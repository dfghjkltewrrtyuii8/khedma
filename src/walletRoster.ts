// Wallet rotation: copy a few wallets at a time, keep the rest on a bench,
// and swap out the ones that aren't working — while the bot runs.
//
// The candidates are always YOUR list: TRACKED_WALLETS first, then
// BENCH_WALLETS. The bot never adds a wallet you didn't put there. What it
// decides for itself is which of them get one of the active slots:
//
//   - DROPPED for good when copying them loses money: WALLET_MAX_CONSECUTIVE_
//     LOSSES losses in a row, or a net loss once WALLET_DROP_AFTER_TRADES
//     copies have closed.
//   - Sent to the BACK of the bench when they've gone quiet: no buy seen for
//     WALLET_IDLE_MINUTES while the bot was running. Quiet isn't bad — it may
//     just trade while you're asleep — so it gets another turn later. Over a
//     few sessions this naturally favours wallets that trade during YOUR hours.
//
// A wallet that loses its slot stops being COPIED immediately, but stays
// WATCHED until every position copied from it has closed, so its sells are
// still mirrored. Rotation is on only when BENCH_WALLETS is set; without a
// bench the bot behaves exactly as before.

import fs from 'fs';
import path from 'path';
import { Config } from './config';
import { PositionStore } from './positions';
import { Position } from './types';
import { walletRecords } from './walletGate';
import { shortAddress } from './watcher';

export type RotationConfig = Pick<
  Config,
  'walletMaxConsecutiveLosses' | 'walletDropAfterTrades' | 'walletIdleMinutes'
>;

interface RosterFile {
  dropped: Record<string, { reason: string; at: string }>;
  idled: Record<string, string>; // wallet -> when it was last benched for being quiet
}

// Pure: should copying this wallet stop for good? Returns the reason, or null.
export function dropReason(positions: readonly Position[], wallet: string, cfg: RotationConfig): string | null {
  const record = walletRecords(positions).get(wallet);
  if (!record) return null;
  if (cfg.walletMaxConsecutiveLosses > 0 && record.consecutiveLosses >= cfg.walletMaxConsecutiveLosses) {
    return `${record.consecutiveLosses} copied losses in a row`;
  }
  if (cfg.walletDropAfterTrades > 0 && record.closed >= cfg.walletDropAfterTrades && record.netSol < 0) {
    return `net ${record.netSol.toFixed(4)} SOL over ${record.closed} copied trades`;
  }
  return null;
}

// Which wallets are active, which are waiting, which are out — persisted in
// data/wallets.json so rotation survives restarts. The order is derived, never
// stored: your .env order, with dropped wallets removed and recently-benched
// ones moved to the back. Editing the .env just works.
export class WalletRoster {
  private state: RosterFile = { dropped: {}, idled: {} };
  private readonly dataDir: string;
  private readonly file: string;

  constructor(
    private readonly pool: string[],
    private readonly activeCount: number,
    dataDir: string = path.join(process.cwd(), 'data')
  ) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'wallets.json');
  }

  load(): void {
    if (!fs.existsSync(this.file)) return;
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<RosterFile>;
    this.state = { dropped: parsed.dropped ?? {}, idled: parsed.idled ?? {} };
  }

  private save(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2));
    fs.renameSync(temp, this.file);
  }

  all(): string[] {
    return [...this.pool];
  }

  private ordered(): string[] {
    const index = new Map(this.pool.map((w, i) => [w, i]));
    const idledAt = (w: string) => (this.state.idled[w] ? Date.parse(this.state.idled[w]) : -Infinity);
    return this.pool
      .filter((w) => !this.state.dropped[w])
      .sort((a, b) => {
        const byIdle = idledAt(a) - idledAt(b); // NaN when neither was ever benched
        return (Number.isNaN(byIdle) ? 0 : byIdle) || index.get(a)! - index.get(b)!;
      });
  }

  active(): string[] {
    return this.ordered().slice(0, this.activeCount);
  }

  bench(): string[] {
    return this.ordered().slice(this.activeCount);
  }

  dropped(): { wallet: string; reason: string; at: string }[] {
    return this.pool.filter((w) => this.state.dropped[w]).map((w) => ({ wallet: w, ...this.state.dropped[w] }));
  }

  drop(wallet: string, reason: string, now: number): void {
    this.state.dropped[wallet] = { reason, at: new Date(now).toISOString() };
    this.save();
  }

  idle(wallet: string, now: number): void {
    this.state.idled[wallet] = new Date(now).toISOString();
    this.save();
  }
}

// What the rotation needs from the watcher and the trader — interfaces, so
// the whole flow can be tested without a network.
export interface WatchControl {
  isWatching(wallet: string): boolean;
  addWallet(wallet: string): void;
  removeWallet(wallet: string): Promise<void>;
}
export interface BuyControl {
  setActiveWallets(wallets: string[] | null): void;
}

export class Rotation {
  private readonly lastBuy = new Map<string, number>();
  private readonly activeSince = new Map<string, number>();
  private readonly finishing = new Set<string>(); // off the active list, still holding a position we copied

  constructor(
    private readonly roster: WalletRoster,
    private readonly store: PositionStore,
    private readonly cfg: RotationConfig,
    private readonly log: (message: string) => void = console.log
  ) {}

  private holdsPositionFrom(wallet: string): boolean {
    return this.store.all().some((p) => p.sourceWallet === wallet && (p.status === 'open' || p.status === 'stuck'));
  }

  // Drop every active wallet that has earned it. Dropping promotes the next
  // bench wallet, which may itself carry a losing history, so repeat until
  // the active list is stable.
  private applyDrops(now: number): void {
    for (;;) {
      const next = this.roster.active().find((w) => dropReason(this.store.all(), w, this.cfg) !== null);
      if (!next) return;
      const reason = dropReason(this.store.all(), next, this.cfg)!;
      this.roster.drop(next, reason, now);
      this.log(`🔄 Dropped ${shortAddress(next)} — ${reason}.`);
    }
  }

  // Before anything is watched: apply drops earned in earlier sessions, and
  // return every wallet that must be watched — the active ones, plus any off
  // the list that we still hold a position from (their sells still count).
  startup(now: number): string[] {
    this.applyDrops(now);
    const active = this.roster.active();
    for (const w of active) this.activeSince.set(w, now);
    for (const w of this.roster.all()) {
      if (!active.includes(w) && this.holdsPositionFrom(w)) this.finishing.add(w);
    }
    return [...active, ...this.finishing];
  }

  noteBuy(wallet: string, now: number): void {
    this.lastBuy.set(wallet, now);
  }

  async tick(now: number, watch: WatchControl, trader: BuyControl): Promise<void> {
    const before = this.roster.active();

    this.applyDrops(now);

    if (this.cfg.walletIdleMinutes > 0) {
      const limitMs = this.cfg.walletIdleMinutes * 60_000;
      for (const w of this.roster.active()) {
        if (this.roster.bench().length === 0) break; // nobody to swap in
        const last = Math.max(this.lastBuy.get(w) ?? 0, this.activeSince.get(w) ?? now);
        if (now - last >= limitMs) {
          this.roster.idle(w, now);
          this.log(
            `🔄 Benched ${shortAddress(w)} — no buys in ${this.cfg.walletIdleMinutes} min while you were running. ` +
              'It goes to the back of the bench and gets another turn later.'
          );
        }
      }
    }

    const active = this.roster.active();
    const activeSet = new Set(active);
    for (const w of before) {
      if (!activeSet.has(w) && this.holdsPositionFrom(w)) this.finishing.add(w);
    }
    for (const w of active) {
      this.finishing.delete(w);
      if (!before.includes(w)) {
        this.activeSince.set(w, now);
        this.lastBuy.delete(w);
        this.log(`🔄 Now copying ${shortAddress(w)} (from the bench).`);
      }
      if (!watch.isWatching(w)) watch.addWallet(w);
    }
    for (const w of before) {
      if (!activeSet.has(w) && !this.finishing.has(w) && watch.isWatching(w)) await watch.removeWallet(w);
    }
    for (const w of [...this.finishing]) {
      if (!this.holdsPositionFrom(w)) {
        this.finishing.delete(w);
        if (watch.isWatching(w)) await watch.removeWallet(w);
      }
    }
    trader.setActiveWallets(active);
  }

  describe(): string {
    const active = this.roster.active().map(shortAddress).join(', ') || 'none';
    const parts = [`copying ${active}`, `${this.roster.bench().length} on the bench`];
    const dropped = this.roster.dropped().length;
    if (dropped) parts.push(`${dropped} dropped`);
    if (this.finishing.size) parts.push(`${this.finishing.size} finishing open trades`);
    return parts.join(' · ');
  }
}

// For `npm run summary`: the full roster, with reasons.
export function printRoster(roster: WalletRoster): void {
  console.log('── WALLET ROTATION ──');
  console.log(`  Copying now: ${roster.active().map(shortAddress).join(', ') || 'none'}`);
  const bench = roster.bench();
  console.log(`  Bench, next up first: ${bench.length ? bench.map(shortAddress).join(', ') : 'empty — add more to BENCH_WALLETS'}`);
  for (const d of roster.dropped()) {
    console.log(`  Dropped ${shortAddress(d.wallet)} — ${d.reason} (${new Date(d.at).toLocaleString()})`);
  }
  console.log('  To give every wallet a fresh start, delete data/wallets.json (with the bot stopped).\n');
}
