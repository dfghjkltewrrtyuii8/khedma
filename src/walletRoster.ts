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
//   - PROVEN WINNERS come first: a wallet whose copies have made money (at
//     least PROVEN_MIN_TRADES closed, net profit) gets a slot ahead of untried
//     ones. When one goes quiet it is benched like any other, but the bot
//     keeps an eye on it and brings it straight back the moment it trades
//     again — instead of leaving the best wallet at the back of a long line.
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
import { Candidate } from './discovery';
import { walletRecords } from './walletGate';
import { shortAddress } from './watcher';

export type RotationConfig = Pick<
  Config,
  'walletMaxConsecutiveLosses' | 'walletDropAfterTrades' | 'walletIdleMinutes'
> &
  Partial<Pick<Config, 'walletMaxTxPer10Min'>> & // absent or 0 = never drop a wallet for trading too fast
  Partial<Pick<Config, 'probationTrades' | 'dryRun'>>; // trial length (default PROBATION_TRADES); paper or real mode

// Every robot drop's reason starts with this, so it can be recognised later.
export const ROBOT_REASON = 'robot';

interface RosterFile {
  dropped: Record<string, { reason: string; at: string }>;
  idled: Record<string, string>; // wallet -> when it was last benched for being quiet
  // Wallets the bot found itself (DISCOVERY=true), oldest first.
  discovered: { wallet: string; at: string; why: string }[];
}

// A wallet is a proven winner once at least this many of its copies have
// closed, with a net profit across them.
export const PROVEN_MIN_TRADES = 2;

// How often a benched winner is checked for trading again (one cheap RPC
// lookup each), and how recent that trading must be to bring it back — so an
// old transaction can't pull it in only to be benched again minutes later.
const WINNER_CHECK_MS = 5 * 60_000;
const WINNER_RECENT_MS = 2 * WINNER_CHECK_MS;

// Pure: the proven winners and their net SOL — paper and real copies both count.
export function provenWinners(positions: readonly Position[]): Map<string, number> {
  const winners = new Map<string, number>();
  for (const r of walletRecords(positions).values()) {
    if (r.closed >= PROVEN_MIN_TRADES && r.netSol > 0) winners.set(r.wallet, r.netSol);
  }
  return winners;
}

// How many discovered wallets to remember. Past this, the oldest that isn't
// currently being copied is forgotten (dropped ones stay dropped regardless).
const MAX_DISCOVERED = 40;

// Is rotation on? It needs somewhere for new wallets to come from: your
// BENCH_WALLETS, or discovery.
export function rotationOn(cfg: Pick<Config, 'benchWallets' | 'discovery'>): boolean {
  return cfg.benchWallets.length > 0 || cfg.discovery;
}

// How many wallets rotation copies at once: ACTIVE_WALLETS, never fewer than
// you listed in TRACKED_WALLETS, never more than the watcher can follow on the
// free Helius plan (MAX_TRACKED_WALLETS). Empty slots are filled from the
// bench — including wallets discovery finds — as soon as there are any.
// (It used to be exactly the number in TRACKED_WALLETS, so with two listed,
// discovered wallets sat unwatched until one of the two went quiet for
// WALLET_IDLE_MINUTES — a long, silent wait.)
export function copySlots(cfg: Pick<Config, 'trackedWallets' | 'activeWallets' | 'maxTrackedWallets'>): number {
  return Math.min(cfg.maxTrackedWallets, Math.max(cfg.trackedWallets.length, cfg.activeWallets));
}

// Pure: what in the settings will keep a paper test quiet, with the fix.
// Shown at startup and by `npm run doctor` — the bot never changes .env itself.
export function paperHints(
  cfg: Pick<Config, 'benchWallets' | 'discovery' | 'trackedWallets' | 'minTokenAgeMinutes' | 'minLiquidityUsd'>
): string[] {
  const hints: string[] = [];
  if (!rotationOn(cfg)) {
    hints.push(
      `wallet scanner off: only your ${cfg.trackedWallets.length} wallet(s) are copied, so whenever they're quiet nothing happens. ` +
        'Fix: npm run recommended'
    );
  }
  if (cfg.minTokenAgeMinutes > 0 || cfg.minLiquidityUsd > 0) {
    hints.push(
      `token check on (${cfg.minTokenAgeMinutes} min old / $${cfg.minLiquidityUsd.toLocaleString('en-US')} liquidity): the wallets worth copying ` +
        'mostly buy newer coins, so most copies get skipped. For paper testing: npm run recommended'
    );
  }
  return hints;
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
  private state: RosterFile = { dropped: {}, idled: {}, discovered: [] };
  private winners: () => Map<string, number> = () => new Map();
  private readonly dataDir: string;
  private readonly file: string;

  constructor(
    private readonly configPool: string[],
    private readonly activeCount: number,
    dataDir: string = path.join(process.cwd(), 'data')
  ) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'wallets.json');
  }

  load(): void {
    if (!fs.existsSync(this.file)) return;
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<RosterFile>;
    this.state = { dropped: parsed.dropped ?? {}, idled: parsed.idled ?? {}, discovered: parsed.discovered ?? [] };
  }

  private save(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2));
    fs.renameSync(temp, this.file);
  }

  // Your wallets first (TRACKED_WALLETS, BENCH_WALLETS), then the ones the bot
  // discovered, in the order it found them.
  all(): string[] {
    const found = this.state.discovered.map((d) => d.wallet).filter((w) => !this.configPool.includes(w));
    return [...this.configPool, ...found];
  }

  isDiscovered(wallet: string): boolean {
    return !this.configPool.includes(wallet) && this.state.discovered.some((d) => d.wallet === wallet);
  }

  discoveredInfo(wallet: string): { at: string; why: string } | undefined {
    return this.state.discovered.find((d) => d.wallet === wallet);
  }

  // Everything the bot already knows about — so discovery never re-suggests a
  // wallet that's listed, on the bench, or was dropped for losing.
  known(): Set<string> {
    return new Set([...this.all(), ...Object.keys(this.state.dropped)]);
  }

  // Add newly discovered wallets to the back of the bench. Returns the ones added.
  addDiscovered(candidates: Candidate[], now: number): string[] {
    const known = this.known();
    const added: string[] = [];
    for (const c of candidates) {
      if (known.has(c.wallet)) continue;
      this.state.discovered.push({ wallet: c.wallet, at: new Date(now).toISOString(), why: c.evidence.join('; ') });
      known.add(c.wallet);
      added.push(c.wallet);
    }
    const active = new Set(this.active());
    while (this.state.discovered.length > MAX_DISCOVERED) {
      const i = this.state.discovered.findIndex((d) => !active.has(d.wallet));
      if (i < 0) break;
      this.state.discovered.splice(i, 1);
    }
    if (added.length) this.save();
    return added;
  }

  // Where proven winners come from (see provenWinners); without it, nobody
  // is ranked and the order is your .env order.
  rankBy(winners: () => Map<string, number>): void {
    this.winners = winners;
  }

  // Wallets that went quiet wait at the back, longest-waiting first. Everyone
  // else: proven winners first (best first), then your .env order.
  private ordered(): string[] {
    const pool = this.all();
    const index = new Map(pool.map((w, i) => [w, i]));
    const winners = this.winners();
    const idledAt = (w: string) => (this.state.idled[w] ? Date.parse(this.state.idled[w]) : -Infinity);
    return pool
      .filter((w) => !this.state.dropped[w])
      .sort((a, b) => {
        const byIdle = idledAt(a) - idledAt(b); // NaN when neither was ever benched
        if (!Number.isNaN(byIdle) && byIdle !== 0) return byIdle;
        const byWinnings = (winners.get(b) ?? 0) - (winners.get(a) ?? 0);
        return byWinnings || index.get(a)! - index.get(b)!;
      });
  }

  active(): string[] {
    return this.ordered().slice(0, this.activeCount);
  }

  bench(): string[] {
    return this.ordered().slice(this.activeCount);
  }

  droppedReason(wallet: string): string | undefined {
    return this.state.dropped[wallet]?.reason;
  }

  dropped(): { wallet: string; reason: string; at: string }[] {
    return Object.keys(this.state.dropped).map((w) => ({ wallet: w, ...this.state.dropped[w] }));
  }

  drop(wallet: string, reason: string, now: number): void {
    this.state.dropped[wallet] = { reason, at: new Date(now).toISOString() };
    this.save();
  }

  idle(wallet: string, now: number): void {
    this.state.idled[wallet] = new Date(now).toISOString();
    this.save();
  }

  // When it was benched for going quiet (epoch ms), if it's waiting for that.
  idledAt(wallet: string): number | undefined {
    const at = this.state.idled[wallet];
    return at ? Date.parse(at) : undefined;
  }

  // No longer waiting at the back: it takes its place by rank again.
  release(wallet: string): void {
    delete this.state.idled[wallet];
    this.save();
  }
}

// What the rotation needs from the watcher and the trader — interfaces, so
// the whole flow can be tested without a network.
export interface WatchControl {
  isWatching(wallet: string): boolean;
  addWallet(wallet: string): void;
  removeWallet(wallet: string): Promise<void>;
  // When the wallet last did anything on-chain (epoch ms), if known.
  lastActivityOf?(wallet: string): number | undefined;
  // How many transactions it made in the last 10 minutes.
  recentTxCount?(wallet: string, now: number): number;
  // When a wallet that ISN'T watched last did anything on-chain (epoch ms).
  probeActivity?(wallet: string): Promise<number | undefined>;
}
export interface BuyControl {
  setActiveWallets(wallets: string[] | null): void;
}

export interface DiscoveryHook {
  // Returns candidates (already filtered against `exclude`). Must not throw.
  run(exclude: Set<string>): Promise<Candidate[]>;
  minBench: number; // run when fewer than this many wallets are waiting
  cooldownMs: number; // and not more often than this
}

// A discovered wallet trades on PAPER until it has proven itself: this many
// closed paper copies with a net profit. Only then can it be copied with real
// money (when DRY_RUN=false). Wallets you listed yourself are never on probation.
export const PROBATION_TRADES = 6;

export class Rotation {
  private readonly lastBuy = new Map<string, number>();
  private lastDiscoveryAt = -Infinity;
  // The discovery run in progress, if any — exposed so tests can await it.
  pendingDiscovery: Promise<void> | null = null;
  private readonly activeSince = new Map<string, number>();
  private readonly finishing = new Set<string>(); // off the active list, still holding a position we copied
  // Who was being copied as of the last startup/tick. Remembered rather than
  // re-read, because discovery can fill an empty slot between ticks — and
  // that wallet must still be announced and get its idle clock started.
  private lastActive: string[] = [];
  private readonly robots = new Set<string>(); // dropped this run for trading like a machine
  private readonly graduated = new Set<string>(); // discovered wallets already announced as past their trial
  // Benched winners: when each was last checked, and the newest on-chain
  // activity those checks found.
  private readonly winnerChecked = new Map<string, number>();
  private readonly winnerSeen = new Map<string, number>();
  private readonly winnerChecks = new Set<Promise<void>>();
  private readonly recalled = new Set<string>(); // announced as back this tick

  constructor(
    private readonly roster: WalletRoster,
    private readonly store: PositionStore,
    private readonly cfg: RotationConfig,
    private readonly log: (message: string) => void = console.log,
    private readonly discovery: DiscoveryHook | null = null
  ) {
    roster.rankBy(() => provenWinners(store.all()));
  }

  // Waits for winner checks in flight (tests).
  async settleWinnerChecks(): Promise<void> {
    await Promise.all([...this.winnerChecks]);
  }

  // Start a check on each benched winner that's due one. Never blocks: what a
  // check finds is acted on at the next tick.
  private checkBenchedWinners(now: number, watch: WatchControl): void {
    if (!watch.probeActivity) return;
    const winners = provenWinners(this.store.all());
    for (const w of this.roster.bench()) {
      if (!winners.has(w) || this.roster.idledAt(w) === undefined) continue;
      if (now - (this.winnerChecked.get(w) ?? -Infinity) < WINNER_CHECK_MS) continue;
      this.winnerChecked.set(w, now);
      const check: Promise<void> = watch
        .probeActivity(w)
        .then((at) => {
          if (at !== undefined && at > (this.winnerSeen.get(w) ?? 0)) this.winnerSeen.set(w, at);
        })
        .catch(() => {})
        .finally(() => {
          this.winnerChecks.delete(check);
        });
      this.winnerChecks.add(check);
    }
  }

  // A benched winner seen trading since it was benched goes straight back to
  // the copy list; the lowest-ranked wallet there makes room.
  private recallWinners(now: number): void {
    const winners = provenWinners(this.store.all());
    const before = this.roster.active();
    const back: string[] = [];
    for (const w of this.roster.bench()) {
      const benchedAt = this.roster.idledAt(w);
      const seen = this.winnerSeen.get(w);
      if (!winners.has(w) || benchedAt === undefined || seen === undefined) continue;
      if (seen <= benchedAt || now - seen > WINNER_RECENT_MS) continue;
      this.roster.release(w);
      this.winnerSeen.delete(w);
      back.push(w);
    }
    if (back.length === 0) return;
    const after = new Set(this.roster.active());
    for (const w of back.filter((x) => after.has(x))) {
      const r = walletRecords(this.store.all()).get(w)!;
      this.recalled.add(w);
      // Its quiet-clock starts now, as for any wallet taking a slot — the
      // old one would bench it again on the spot.
      this.activeSince.set(w, now);
      this.lastBuy.delete(w);
      this.log(
        `🔄 ${shortAddress(w)} ⭐ is trading again — one of your best wallets (${r.wins}W/${r.losses}L, net ` +
          `${r.netSol >= 0 ? '+' : ''}${r.netSol.toFixed(4)} SOL), so it's back on the copy list.`
      );
    }
    const bumped = before.filter((w) => !after.has(w));
    if (bumped.length > 0) {
      this.log(`🔄 ${bumped.map(shortAddress).join(', ')} moved to the bench to make room — first in line for the next free slot.`);
    }
  }

  private trialLength(): number {
    return this.cfg.probationTrades ?? PROBATION_TRADES;
  }

  // True while a discovered wallet hasn't yet earned real-money copies.
  isPaperOnly(wallet: string): boolean {
    if (!this.roster.isDiscovered(wallet)) return false;
    const needed = this.trialLength();
    if (needed <= 0) return false; // PROBATION_TRADES=0: no trial
    const paper = walletRecords(this.store.all().filter((p) => p.dryRun)).get(wallet);
    return !(paper && paper.closed >= needed && paper.netSol > 0);
  }

  // The wallets being copied whose buys would use real money.
  realMoneyWallets(): string[] {
    return this.roster.active().filter((w) => !this.isPaperOnly(w));
  }

  // Say so once when a discovered wallet passes its trial.
  private announceGraduates(active: string[], quiet: boolean): void {
    for (const w of active) {
      if (!this.roster.isDiscovered(w) || this.isPaperOnly(w) || this.graduated.has(w)) continue;
      this.graduated.add(w);
      if (quiet) continue;
      this.log(
        `🎓 ${shortAddress(w)} passed its trial (${this.trialLength()} paper copies, in profit) — ` +
          (this.cfg.dryRun ? 'it will trade real money once DRY_RUN=false.' : 'its copies now use real money.')
      );
    }
  }

  // Start a discovery run in the background if the bench is running low.
  // Never blocks trading; new wallets land on the bench when it finishes.
  // Start a discovery run when too few waiting wallets could actually help.
  // A wallet already known to have been quiet longer than WALLET_IDLE_MINUTES
  // doesn't count: it would be benched again the moment it got a slot. (It
  // used to count, so a bench full of quiet wallets stopped discovery for
  // good — and quiet wallets were just swapped for other quiet ones.)
  private maybeDiscover(now: number, watch?: WatchControl): void {
    if (!this.discovery || this.pendingDiscovery) return;
    const idleMs = this.cfg.walletIdleMinutes * 60_000;
    const usable = this.roster.bench().filter((w) => {
      const at = watch?.lastActivityOf?.(w);
      return at === undefined || idleMs <= 0 || now - at < idleMs;
    }).length;
    if (usable >= this.discovery.minBench) return;
    if (now - this.lastDiscoveryAt < this.discovery.cooldownMs) return;
    this.lastDiscoveryAt = now;
    this.log('🔎 Not enough active wallets waiting — looking for new ones to try (a few minutes; trading carries on)…');
    this.pendingDiscovery = this.discovery
      .run(this.roster.known())
      .then((candidates) => {
        const added = this.roster.addDiscovered(candidates, Date.now());
        this.log(
          added.length
            ? `🔎 Found ${added.length} new wallet(s) to try: ${added.map(shortAddress).join(', ')} — paper-tested first.`
            : '🔎 No new wallets passed the filter this time; will look again later.'
        );
      })
      .catch((error) => this.log(`🔎 Discovery failed: ${(error as Error).message}`))
      .finally(() => {
        this.pendingDiscovery = null;
      });
  }

  // A robot is never kept watched to mirror its sells: its flood of
  // transactions is exactly what's being stopped. Its open copies are closed
  // by the exit rules, or at shutdown.
  private isRobot(wallet: string): boolean {
    return this.robots.has(wallet) || (this.roster.droppedReason(wallet)?.startsWith(ROBOT_REASON) ?? false);
  }

  // Drop any watched wallet transacting faster than a person can: a robot
  // wallet swamps the watcher (its trades queue ahead of everyone else's) and
  // burns through the free Helius allowance, one lookup per transaction —
  // and its trades aren't copyable anyway.
  private dropRobots(now: number, watch: WatchControl): void {
    const limit = this.cfg.walletMaxTxPer10Min ?? 0;
    if (limit <= 0 || !watch.recentTxCount) return;
    for (const w of [...this.roster.active(), ...this.finishing]) {
      const count = watch.recentTxCount(w, now);
      if (count <= limit) continue;
      const holding = this.holdsPositionFrom(w);
      this.roster.drop(w, `${ROBOT_REASON} — ${count} transactions in 10 minutes`, now);
      this.robots.add(w);
      this.finishing.delete(w);
      this.log(
        `🔄 Dropped ${shortAddress(w)} — robot: ${count} transactions in 10 minutes (no person trades that fast). ` +
          'No longer watched.' +
          (holding ? ' Its open copy will be closed by your exit rules, or when you stop the bot.' : '')
      );
    }
  }

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
    this.lastActive = active;
    for (const w of active) this.activeSince.set(w, now);
    this.announceGraduates(active, true); // already past it at startup: counted, not announced
    for (const w of this.roster.all()) {
      if (!active.includes(w) && this.holdsPositionFrom(w) && !this.isRobot(w)) this.finishing.add(w);
    }
    this.maybeDiscover(now);
    return [...active, ...this.finishing];
  }

  noteBuy(wallet: string, now: number): void {
    this.lastBuy.set(wallet, now);
  }

  async tick(now: number, watch: WatchControl, trader: BuyControl): Promise<void> {
    const before = this.lastActive;

    this.applyDrops(now);
    this.dropRobots(now, watch);
    this.recalled.clear();
    this.recallWinners(now);

    if (this.cfg.walletIdleMinutes > 0) {
      const limitMs = this.cfg.walletIdleMinutes * 60_000;
      for (const w of this.roster.active()) {
        const bench = this.roster.bench();
        if (bench.length === 0) break; // nobody to swap in
        // Quiet since it got its slot — or since its last on-chain activity,
        // if that was earlier: a wallet that hasn't done anything for hours
        // is swapped out on the first check, not after another 90 minutes.
        const since = this.activeSince.get(w) ?? now;
        const onChain = watch.lastActivityOf?.(w);
        const quietSince = onChain !== undefined ? Math.min(since, onChain) : since;
        const last = Math.max(this.lastBuy.get(w) ?? 0, quietSince);
        if (now - last >= limitMs) {
          // Never trade one quiet wallet for another already known to be at
          // least as quiet — that only churns (and spams the alerts).
          const nextUp = watch.lastActivityOf?.(bench[0]);
          if (nextUp !== undefined && nextUp <= last) continue;
          this.roster.idle(w, now);
          this.log(
            `🔄 Benched ${shortAddress(w)} — no buys in ${this.cfg.walletIdleMinutes}+ min. ` +
              'It goes to the back of the bench and gets another turn later.'
          );
        }
      }
    }

    const active = this.roster.active();
    const activeSet = new Set(active);
    for (const w of before) {
      if (!activeSet.has(w) && this.holdsPositionFrom(w) && !this.isRobot(w)) this.finishing.add(w);
    }
    for (const w of active) {
      this.finishing.delete(w);
      if (!before.includes(w)) {
        this.activeSince.set(w, now);
        this.lastBuy.delete(w);
        if (!this.recalled.has(w)) this.log(`🔄 Now copying ${shortAddress(w)} (from the bench).`);
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
    for (const w of this.robots) {
      if (watch.isWatching(w)) await watch.removeWallet(w);
    }
    this.lastActive = active;
    this.announceGraduates(active, false);
    trader.setActiveWallets(active);
    this.maybeDiscover(now, watch);
    this.checkBenchedWinners(now, watch);
  }

  describe(): string {
    const winners = provenWinners(this.store.all());
    const active = this.roster.active().map((w) => shortAddress(w) + (winners.has(w) ? '⭐' : '')).join(', ') || 'none';
    const onProbation = this.roster.active().filter((w) => this.isPaperOnly(w)).length;
    const parts = [`copying ${active}`, `${this.roster.bench().length} on the bench`];
    if (onProbation) parts.push(`${onProbation} found by discovery, paper-only until proven`);
    const dropped = this.roster.dropped().length;
    if (dropped) parts.push(`${dropped} dropped`);
    if (this.finishing.size) parts.push(`${this.finishing.size} finishing open trades`);
    return parts.join(' · ');
  }
}

// For `npm run summary`: the full roster, with reasons.
export function printRoster(roster: WalletRoster, positions?: readonly Position[], cfg?: RotationConfig): void {
  const winners = positions ? provenWinners(positions) : new Map<string, number>();
  if (positions) roster.rankBy(() => winners);
  const label = (w: string) => shortAddress(w) + (roster.isDiscovered(w) ? '*' : '') + (winners.has(w) ? '⭐' : '');
  console.log('── WALLET ROTATION ──');
  console.log(`  Copying now: ${roster.active().map(label).join(', ') || 'none'}`);
  // A drop already earned is applied when the bot next starts; say so here
  // rather than listing the wallet as if it will keep being copied.
  if (positions && cfg) {
    for (const w of roster.active()) {
      const reason = dropReason(positions, w, cfg);
      if (reason) console.log(`    ${shortAddress(w)} will be dropped when rotation next runs — ${reason}`);
    }
  }
  const bench = roster.bench();
  console.log(`  Bench, next up first: ${bench.length ? bench.map(label).join(', ') : 'empty'}`);
  if (roster.all().some((w) => roster.isDiscovered(w))) {
    console.log(`  * found by discovery — traded on paper until it has ${cfg?.probationTrades ?? PROBATION_TRADES} closed paper copies in profit`);
    for (const w of roster.active().filter((x) => roster.isDiscovered(x))) {
      console.log(`    ${shortAddress(w)} was picked because: ${roster.discoveredInfo(w)?.why ?? '?'}`);
    }
  }
  for (const d of roster.dropped()) {
    console.log(`  Dropped ${shortAddress(d.wallet)} — ${d.reason} (${new Date(d.at).toLocaleString()})`);
  }
  if (winners.size > 0) {
    console.log(`  ⭐ proven winner (${PROVEN_MIN_TRADES}+ closed copies, net profit) — first claim on a slot; brought back as soon as it trades again`);
  }
  console.log('  To give every wallet a fresh start, delete data/wallets.json (with the bot stopped).\n');
}
