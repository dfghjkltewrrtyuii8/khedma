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
import { describeHours, HourProfile, likelyActive, VetVerdict } from './walletVetting';

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
  // Found wallets that vetting turned away (their own recent trades said no),
  // remembered for REJECT_MEMORY_MS so discovery doesn't suggest them again.
  rejected: Record<string, { reason: string; at: string }>;
  // Found wallets that passed vetting, and when (re-checked after REVET_MS).
  vetted: Record<string, string>;
  // Each vetted wallet's usual hours (walletVetting.ts), refreshed with
  // vetting. null: checked, but too little history to tell.
  hours: Record<string, HourProfile | null>;
  // Who is being copied. Kept as a list rather than worked out from the
  // ranking each time, so a wallet in the middle of trading is never pushed
  // out just because the ranking moved (it changes with the hour).
  active?: string[];
}

// What decides who is next for a free slot — worked out by the rotation.
export interface RankContext {
  now: number;
  winners: Map<string, number>; // proven winners and their net SOL
  awake: Set<string>; // benched wallets seen trading since they were benched
  hourScore(wallet: string): number | null; // how likely it's trading at this hour (null: unknown)
}
const NO_CONTEXT: RankContext = { now: 0, winners: new Map(), awake: new Set(), hourScore: () => null };
const UNKNOWN_HOUR_SCORE = 0.25; // a wallet whose hours aren't known yet: behind likely ones, ahead of unlikely ones
// A wallet just benched for going quiet has shown it isn't trading now,
// whatever its usual hours say: for this long it goes behind the others
// unless it's seen trading. (Without this, a wallet quiet at its usual hour
// was benched and picked straight back, over and over — 245 times in a
// simulated three days.)
const JUST_BENCHED_MS = 60 * 60_000;

const REJECT_MEMORY_MS = 7 * 24 * 3_600_000;
const REVET_MS = 3 * 24 * 3_600_000;

// A wallet is a proven winner once at least this many of its copies have
// closed, with a net profit across them.
export const PROVEN_MIN_TRADES = 2;

// How often a benched winner is checked for trading again (one cheap RPC
// lookup each), and how recent that trading must be to count as awake — so
// an old transaction can't pull it in only to be benched again minutes later.
const WINNER_CHECK_MS = 5 * 60_000;
const AWAKE_MS = 2 * WINNER_CHECK_MS;
// Other benched wallets are checked less often, one at a time, and only while
// a copied wallet has gone quiet (see Rotation.checkBench).
const OTHER_CHECK_MS = 15 * 60_000;
// At startup, at most this many wallets are checked for what they did last
// (the best-ranked first) — one cheap lookup each, a few seconds in all.
const START_CHECKS = 40;

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
  private state: RosterFile = { dropped: {}, idled: {}, discovered: [], rejected: {}, vetted: {}, hours: {} };
  private context: () => RankContext = () => NO_CONTEXT;
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
    this.state = {
      dropped: parsed.dropped ?? {},
      idled: parsed.idled ?? {},
      discovered: parsed.discovered ?? [],
      rejected: parsed.rejected ?? {},
      vetted: parsed.vetted ?? {},
      hours: parsed.hours ?? {},
      active: parsed.active, // absent in files from before v1.13: worked out from the ranking once
    };
    if (parsed.active === undefined) this.recheckQuietRejects();
  }

  // Wallets returned to the bench by recheckQuietRejects (this run).
  rechecked = 0;

  // The first vetting turned wallets away just for not trading when it
  // looked — mostly overnight. Asleep isn't bad now, so on the first start
  // after the update those get another look: back on the bench, waiting
  // (💤), and vetted again one at a time. Machines, flippers and losers stay
  // turned away.
  private recheckQuietRejects(): void {
    for (const [wallet, r] of Object.entries(this.state.rejected)) {
      if (!/^hasn't bought for |^too quiet: /.test(r.reason)) continue;
      delete this.state.rejected[wallet];
      if (this.configPool.includes(wallet) || this.state.discovered.some((d) => d.wallet === wallet)) continue;
      this.state.discovered.push({ wallet, at: r.at, why: `re-checked: first turned away only for being quiet (${r.reason})` });
      this.state.idled[wallet] = r.at;
      this.rechecked += 1;
    }
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
  // wallet that's listed, on the bench, dropped for losing, or recently
  // turned away by vetting.
  known(now: number = Date.now()): Set<string> {
    const rejected = Object.keys(this.state.rejected).filter((w) => now - Date.parse(this.state.rejected[w].at) < REJECT_MEMORY_MS);
    return new Set([...this.all(), ...Object.keys(this.state.dropped), ...rejected]);
  }

  // A found wallet that failed vetting: off the roster (it stops being copied;
  // the rotation keeps watching it while a copied position is open).
  reject(wallet: string, reason: string, now: number): void {
    this.state.discovered = this.state.discovered.filter((d) => d.wallet !== wallet);
    if (this.state.active) this.state.active = this.state.active.filter((w) => w !== wallet);
    delete this.state.vetted[wallet];
    delete this.state.hours[wallet];
    delete this.state.idled[wallet];
    this.state.rejected[wallet] = { reason, at: new Date(now).toISOString() };
    for (const w of Object.keys(this.state.rejected)) {
      if (now - Date.parse(this.state.rejected[w].at) >= REJECT_MEMORY_MS) delete this.state.rejected[w];
    }
    this.save();
  }

  rejectedCount(now: number = Date.now()): number {
    return Object.values(this.state.rejected).filter((r) => now - Date.parse(r.at) < REJECT_MEMORY_MS).length;
  }

  markVetted(wallet: string, now: number, hours: HourProfile | null = null): void {
    this.state.vetted[wallet] = new Date(now).toISOString();
    this.state.hours[wallet] = hours; // null is recorded too: checked, nothing to learn — never re-checked for it
    this.save();
  }

  hoursOf(wallet: string): HourProfile | undefined {
    return this.state.hours[wallet] ?? undefined;
  }

  // A found wallet not vetted in the last REVET_MS (or ever), or vetted before
  // the bot learned usual hours.
  needsVetting(wallet: string, now: number): boolean {
    if (!this.isDiscovered(wallet)) return false; // your own picks are yours to judge
    const at = this.state.vetted[wallet];
    return !at || now - Date.parse(at) >= REVET_MS || !(wallet in this.state.hours);
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

  // What the ranking goes by (see RankContext); without it: proven winners
  // aren't known, and the order is your .env order, quiet ones last.
  rankBy(context: () => RankContext): void {
    this.context = context;
  }

  // Next up first:
  //   1. wallets seen trading since they were benched — proven winners first
  //   2. wallets not benched for going quiet: proven winners (best first),
  //      then your .env order and the order they were found
  //   3. wallets benched for going quiet: the ones most likely trading at
  //      this hour first, then the longest-waiting
  private rank(wallets: string[]): string[] {
    const ctx = this.context();
    const index = new Map(this.all().map((w, i) => [w, i]));
    const idledAt = (w: string) => (this.state.idled[w] ? Date.parse(this.state.idled[w]) : undefined);
    const tier = (w: string) => (ctx.awake.has(w) ? 0 : idledAt(w) === undefined ? 1 : 2);
    const winnings = (w: string) => ctx.winners.get(w) ?? 0;
    const hourScore = (w: string) => (ctx.now - idledAt(w)! < JUST_BENCHED_MS ? -1 : ctx.hourScore(w) ?? UNKNOWN_HOUR_SCORE);
    return [...wallets].sort((a, b) => {
      const byTier = tier(a) - tier(b);
      if (byTier !== 0) return byTier;
      if (tier(a) === 2) {
        const byHour = hourScore(b) - hourScore(a);
        if (byHour !== 0) return byHour;
        const byWait = idledAt(a)! - idledAt(b)!;
        if (byWait !== 0) return byWait;
      }
      return winnings(b) - winnings(a) || index.get(a)! - index.get(b)!;
    });
  }

  private copying(): string[] {
    const pool = new Set(this.all());
    const list = this.state.active ?? this.rank(this.all().filter((w) => !this.state.dropped[w])).slice(0, this.activeCount);
    return list.filter((w) => pool.has(w) && !this.state.dropped[w]).slice(0, this.activeCount);
  }

  // Who is being copied, best-ranked first.
  active(): string[] {
    return this.rank(this.copying());
  }

  // Everyone else who could be copied, next up first.
  bench(): string[] {
    const active = new Set(this.copying());
    return this.rank(this.all().filter((w) => !this.state.dropped[w] && !active.has(w)));
  }

  freeSlots(): number {
    return Math.max(0, this.activeCount - this.copying().length);
  }

  // The wallet for the free slot, if there is one.
  nextUp(): string | undefined {
    return this.freeSlots() > 0 ? this.bench()[0] : undefined;
  }

  activate(wallet: string): void {
    this.state.active = [...this.copying().filter((w) => w !== wallet), wallet];
    this.save();
  }

  // Off the copy list, onto the bench as it is (not marked quiet).
  deactivate(wallet: string): void {
    this.state.active = this.copying().filter((w) => w !== wallet);
    this.save();
  }

  // Replace the copy list (startup: picked fresh from what every wallet did last).
  setCopyList(wallets: string[]): void {
    this.state.active = wallets.slice(0, this.activeCount);
    this.save();
  }

  // Write the copy list down (a file from before v1.13 had none).
  settle(): void {
    if (this.state.active === undefined) {
      this.state.active = this.copying();
      this.save();
    }
  }

  droppedReason(wallet: string): string | undefined {
    return this.state.dropped[wallet]?.reason;
  }

  dropped(): { wallet: string; reason: string; at: string }[] {
    return Object.keys(this.state.dropped).map((w) => ({ wallet: w, ...this.state.dropped[w] }));
  }

  drop(wallet: string, reason: string, now: number): void {
    this.state.dropped[wallet] = { reason, at: new Date(now).toISOString() };
    if (this.state.active) this.state.active = this.state.active.filter((w) => w !== wallet);
    this.save();
  }

  // Benched for going quiet: off the copy list, behind everyone not benched.
  idle(wallet: string, now: number): void {
    this.state.idled[wallet] = new Date(now).toISOString();
    if (this.state.active) this.state.active = this.state.active.filter((w) => w !== wallet);
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
  // Judge a wallet by its own recent trades (walletVetting.ts). When given,
  // only wallets that pass get onto the roster, and ones already on it are
  // re-checked one at a time.
  vet?(wallet: string): Promise<VetVerdict>;
}

// A discovered wallet trades on PAPER until it has proven itself: this many
// closed copies with a net profit (paper, or real ones from before the trial
// was turned on). Only then can it be copied with real
// money (when DRY_RUN=false). Wallets you listed yourself are never on probation.
export const PROBATION_TRADES = 6;

export class Rotation {
  private readonly lastBuy = new Map<string, number>();
  private lastDiscoveryAt = -Infinity;
  // The discovery run in progress, if any — exposed so tests can await it.
  pendingDiscovery: Promise<void> | null = null;
  // The one roster check in progress, if any — exposed so tests can await it.
  pendingVet: Promise<void> | null = null;
  private readonly activeSince = new Map<string, number>();
  private readonly finishing = new Set<string>(); // off the active list, still holding a position we copied
  // Who was being copied as of the last startup/tick. Remembered rather than
  // re-read, so every wallet new to the list gets announced and its quiet
  // clock started.
  private lastActive: string[] = [];
  private readonly robots = new Set<string>(); // dropped this run for trading like a machine
  private readonly graduated = new Set<string>(); // discovered wallets already announced as past their trial
  // Benched wallets: when each was last checked for trading again, and the
  // newest on-chain activity those checks found.
  private readonly checkedAt = new Map<string, number>();
  private readonly seenAt = new Map<string, number>();
  private readonly checks = new Set<Promise<void>>();
  private readonly announced = new Set<string>(); // new on the copy list this tick, announced already
  private readonly whyNew = new Map<string, string>(); // why a wallet got a free slot this tick
  private readonly benchedNow = new Set<string>(); // benched this tick — never refilled into the slot it just left
  // Latest on-chain activity learned outside the watcher: the startup check,
  // and checks on benched wallets. The watcher only knows wallets it watches.
  private readonly knownActivity = new Map<string, number>();
  private clock = 0; // the last startup/tick — what "this hour" means for the ranking

  constructor(
    private readonly roster: WalletRoster,
    private readonly store: PositionStore,
    private readonly cfg: RotationConfig,
    private readonly log: (message: string) => void = console.log,
    private readonly discovery: DiscoveryHook | null = null
  ) {
    roster.rankBy(() => this.rankContext());
  }

  private rankContext(): RankContext {
    const now = this.clock;
    const awake = new Set<string>();
    for (const [w, seen] of this.seenAt) if (this.isAwake(w, seen, now)) awake.add(w);
    return { now, winners: provenWinners(this.store.all()), awake, hourScore: (w) => likelyActive(this.roster.hoursOf(w), now) };
  }

  // Benched for going quiet, then seen trading again — recently enough that
  // it's probably still at it.
  private isAwake(wallet: string, seen: number, now: number): boolean {
    const benchedAt = this.roster.idledAt(wallet);
    return benchedAt !== undefined && seen > benchedAt && now - seen <= AWAKE_MS;
  }

  // Waits for bench checks in flight (tests).
  async settleChecks(): Promise<void> {
    await Promise.all([...this.checks]);
  }

  // A wallet's latest known on-chain activity: from the watcher, or from a
  // check the rotation made itself — whichever is newer.
  private lastSeen(wallet: string, watch?: WatchControl): number | undefined {
    const watched = watch?.lastActivityOf?.(wallet);
    const checked = this.knownActivity.get(wallet);
    if (watched === undefined) return checked;
    return checked === undefined ? watched : Math.max(watched, checked);
  }

  // The last sign of life that counts for a copied wallet: its last buy, or
  // when it got its slot — or its last on-chain activity, if that was
  // earlier (a wallet that hasn't done anything for hours is quiet at once).
  private lastSign(wallet: string, now: number, watch: WatchControl): number {
    const since = this.activeSince.get(wallet) ?? now;
    const onChain = this.lastSeen(wallet, watch);
    const quietSince = onChain !== undefined ? Math.min(since, onChain) : since;
    return Math.max(this.lastBuy.get(wallet) ?? 0, quietSince);
  }

  // Copied wallets (not proven winners, not new this tick) that have done
  // nothing at all on-chain — not just no buys — for at least `ms`, quietest
  // first. Any activity counts here: a wallet that is up and trading only
  // pauses between buys, and swapping two awake wallets back and forth over
  // those pauses is churn (a simulated day did it 400 times).
  private quietActives(now: number, watch: WatchControl, ms: number): string[] {
    const winners = provenWinners(this.store.all());
    const last = (w: string) => Math.max(this.lastSign(w, now, watch), this.lastSeen(w, watch) ?? 0);
    return this.roster
      .active()
      .filter((w) => !winners.has(w) && !this.announced.has(w) && now - last(w) >= ms)
      .sort((a, b) => last(a) - last(b));
  }

  // Check benched wallets for trading again: proven winners every 5 minutes;
  // the others one at a time — the one likeliest to be trading at this hour
  // first, each at most every 15 minutes, and only while one could get a
  // slot (a copied wallet has gone quiet). One cheap lookup per check; it
  // never blocks, and what it finds counts from the next tick.
  private checkBench(now: number, watch: WatchControl): void {
    if (!watch.probeActivity) return;
    const winners = provenWinners(this.store.all());
    const idleMs = this.cfg.walletIdleMinutes * 60_000;
    const benched = this.roster.bench().filter((w) => this.roster.idledAt(w) !== undefined); // ranked: likeliest now first
    const due = (w: string, every: number) => now - (this.checkedAt.get(w) ?? -Infinity) >= every;
    const toCheck = benched.filter((w) => winners.has(w) && due(w, WINNER_CHECK_MS));
    if (idleMs > 0 && this.quietActives(now, watch, idleMs / 2).length > 0) {
      const other = benched.find((w) => !winners.has(w) && due(w, OTHER_CHECK_MS));
      if (other) toCheck.push(other);
    }
    for (const w of toCheck) {
      this.checkedAt.set(w, now);
      const check: Promise<void> = watch
        .probeActivity(w)
        .then((at) => {
          if (at === undefined) return;
          if (at > (this.seenAt.get(w) ?? 0)) this.seenAt.set(w, at);
          if (at > (this.knownActivity.get(w) ?? 0)) this.knownActivity.set(w, at);
        })
        .catch(() => {})
        .finally(() => {
          this.checks.delete(check);
        });
      this.checks.add(check);
    }
  }

  // On the copy list from now, with a fresh quiet clock.
  private takeSlot(wallet: string, now: number): void {
    this.roster.release(wallet);
    this.roster.activate(wallet);
    this.seenAt.delete(wallet);
    this.activeSince.set(wallet, now);
    this.lastBuy.delete(wallet);
  }

  // Benched wallets seen trading again, when there's no free slot for them
  // (a free slot is filled by fillSlots, where they're first in line). A
  // proven winner goes straight back on — the lowest-ranked other wallet
  // makes room. Anyone else takes the slot of a copied wallet that has been
  // quiet for half of WALLET_IDLE_MINUTES: why wait out the full half hour
  // on a quiet one while another is trading right now?
  private wake(now: number, watch: WatchControl): void {
    const ctx = this.rankContext();
    const awake = this.roster.bench().filter((w) => ctx.awake.has(w)); // winners first
    const idleMs = this.cfg.walletIdleMinutes * 60_000;
    let free = this.roster.freeSlots();
    for (const w of awake) {
      if (free > 0) {
        free -= 1; // fillSlots takes it
        continue;
      }
      if (dropReason(this.store.all(), w, this.cfg) !== null) continue; // earned a drop while benched: fillSlots drops it if it's ever next
      if (ctx.winners.has(w)) {
        const out = [...this.roster.active()].reverse().find((x) => !ctx.winners.has(x));
        if (!out) continue;
        this.roster.deactivate(out);
        this.takeSlot(w, now);
        this.announced.add(w);
        const r = walletRecords(this.store.all()).get(w)!;
        this.log(
          `🔄 ${shortAddress(w)} ⭐ is trading again — one of your best wallets (${r.wins}W/${r.losses}L, net ` +
            `${r.netSol >= 0 ? '+' : ''}${r.netSol.toFixed(4)} SOL), so it's back on the copy list.`
        );
        this.log(`🔄 ${shortAddress(out)} moved to the bench to make room — first in line for the next free slot.`);
        continue;
      }
      if (idleMs <= 0) continue;
      const quiet = this.quietActives(now, watch, idleMs / 2)[0];
      if (!quiet) continue;
      this.roster.idle(quiet, now);
      this.benchedNow.add(quiet);
      this.takeSlot(w, now);
      this.announced.add(w);
      this.log(
        `🔄 Benched ${shortAddress(quiet)} — nothing on-chain for ${Math.round(idleMs / 120_000)}+ min, and ${shortAddress(w)} is ` +
          `trading right now, so it takes the slot.`
      );
    }
  }

  // Fill free slots, best-ranked first. A wallet that earned a drop in an
  // earlier session is dropped on its way in, and the next one tried.
  private fillSlots(now: number): void {
    const ctx = this.rankContext();
    for (;;) {
      if (this.roster.freeSlots() === 0) return;
      const next = this.roster.bench().find((w) => !this.benchedNow.has(w));
      if (!next) return;
      const reason = dropReason(this.store.all(), next, this.cfg);
      if (reason) {
        this.roster.drop(next, reason, now);
        this.log(`🔄 Dropped ${shortAddress(next)} — ${reason}.`);
        continue;
      }
      if (ctx.awake.has(next)) this.whyNew.set(next, " — it's trading right now");
      else if (this.roster.idledAt(next) !== undefined && (ctx.hourScore(next) ?? 0) >= 0.5) this.whyNew.set(next, ' — it usually trades at this hour');
      this.takeSlot(next, now);
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
    // Every copy counts, paper or real: a wallet that already made money with
    // real copies (a proven winner, say) has passed — turning the trial back
    // on must not send it back to paper.
    const record = walletRecords(this.store.all()).get(wallet);
    return !(record && record.closed >= needed && record.netSol > 0);
  }

  // The wallets being copied whose buys would use real money.
  realMoneyWallets(): string[] {
    return this.roster.active().filter((w) => !this.isPaperOnly(w));
  }

  // Say so once when a discovered wallet passes its trial.
  private announceGraduates(active: string[], quiet: boolean): void {
    if (this.trialLength() <= 0) return; // no trial, nothing to pass
    for (const w of active) {
      if (!this.roster.isDiscovered(w) || this.isPaperOnly(w) || this.graduated.has(w)) continue;
      this.graduated.add(w);
      if (quiet) continue;
      this.log(
        `🎓 ${shortAddress(w)} passed its trial (${this.trialLength()} copies, in profit) — ` +
          (this.cfg.dryRun ? 'it will trade real money once DRY_RUN=false.' : 'its copies now use real money.')
      );
    }
  }

  // Start a discovery run in the background if the bench is running low.
  // Never blocks trading; new wallets land on the bench when it finishes.
  // A wallet already known to have been quiet longer than WALLET_IDLE_MINUTES
  // doesn't count: it would be benched again the moment it got a slot. (It
  // used to count, so a bench full of quiet wallets stopped discovery for
  // good — and quiet wallets were just swapped for other quiet ones.)
  private maybeDiscover(now: number, watch?: WatchControl): void {
    if (!this.discovery || this.pendingDiscovery) return;
    const idleMs = this.cfg.walletIdleMinutes * 60_000;
    const usable = this.roster.bench().filter((w) => {
      const at = this.lastSeen(w, watch);
      return at === undefined || idleMs <= 0 || now - at < idleMs;
    }).length;
    if (usable >= this.discovery.minBench) return;
    if (now - this.lastDiscoveryAt < this.discovery.cooldownMs) return;
    this.lastDiscoveryAt = now;
    this.log('🔎 Not enough active wallets waiting — looking for new ones to try (a few minutes; trading carries on)…');
    const discovery = this.discovery;
    this.pendingDiscovery = discovery
      .run(this.roster.known(now))
      .then(async (candidates) => {
        const vetted = discovery.vet ? await this.vetCandidates(candidates, discovery.vet) : { keep: candidates, asleep: new Set<string>(), hours: new Map<string, HourProfile | null>() };
        const at = Date.now();
        const added = this.roster.addDiscovered(vetted.keep, at);
        for (const w of added) {
          if (discovery.vet) this.roster.markVetted(w, at, vetted.hours.get(w) ?? null);
          if (vetted.asleep.has(w)) this.roster.idle(w, at); // waits on the bench until it trades
        }
        const sleeping = added.filter((w) => vetted.asleep.has(w)).length;
        this.log(
          added.length
            ? `🔎 Found ${added.length} new wallet(s) to try: ${added.map(shortAddress).join(', ')}` +
                (sleeping > 0 ? ` (${sleeping} asleep — on the bench until they trade)` : '') +
                (this.trialLength() > 0 ? ' — paper-tested first.' : '.')
            : '🔎 No new wallets passed the filter this time; will look again later.'
        );
      })
      .catch((error) => this.log(`🔎 Discovery failed: ${(error as Error).message}`))
      .finally(() => {
        this.pendingDiscovery = null;
      });
  }

  // Check each nominee's own recent trades: the ones that pass are kept, the
  // ones asleep are kept for later, the rest are turned away.
  private async vetCandidates(
    candidates: Candidate[],
    vet: (wallet: string) => Promise<VetVerdict>
  ): Promise<{ keep: Candidate[]; asleep: Set<string>; hours: Map<string, HourProfile | null> }> {
    const result = { keep: [] as Candidate[], asleep: new Set<string>(), hours: new Map<string, HourProfile | null>() };
    if (candidates.length === 0) return result;
    this.log(`🧪 Checking ${candidates.length} nominee(s) against their own recent trades…`);
    for (const c of candidates) {
      let verdict: VetVerdict;
      try {
        verdict = await vet(c.wallet);
      } catch (error) {
        this.log(`   ⚠️ ${shortAddress(c.wallet)}: couldn't read its trades (${(error as Error).message.slice(0, 80)}) — skipped for now`);
        continue;
      }
      if (verdict.status === 'fail') {
        this.roster.reject(c.wallet, verdict.reason, Date.now());
        this.log(`   ❌ ${shortAddress(c.wallet)} — ${verdict.reason}`);
        continue;
      }
      result.keep.push(c);
      result.hours.set(c.wallet, verdict.hours);
      if (verdict.status === 'asleep') result.asleep.add(c.wallet);
      this.log(`   ${verdict.status === 'asleep' ? '💤' : '✅'} ${shortAddress(c.wallet)} — ${verdict.reason}`);
    }
    return result;
  }

  // Wallets found before vetting (or before it learned usual hours), and
  // ones vetted days ago, are checked one at a time, copied ones first. One
  // that fails is taken off the roster and its slot goes to the next wallet;
  // one that's asleep stays, and waits on the bench. Proven winners are left
  // alone: the bot's own copies of them are better evidence than any history.
  private maybeVetRoster(now: number): void {
    const vet = this.discovery?.vet;
    if (!vet || this.pendingVet || this.pendingDiscovery) return;
    const winners = provenWinners(this.store.all());
    const wallet = [...this.roster.active(), ...this.roster.bench()].find(
      (w) => !winners.has(w) && this.roster.needsVetting(w, now)
    );
    if (!wallet) return;
    this.pendingVet = vet(wallet)
      .then((verdict) => {
        // Changed meanwhile: dropped, or its copies made it a proven winner.
        if (!this.roster.needsVetting(wallet, Date.now()) || provenWinners(this.store.all()).has(wallet)) return;
        const copying = this.roster.active().includes(wallet);
        if (verdict.status === 'fail') {
          this.roster.reject(wallet, verdict.reason, Date.now());
          this.log(`🧪 Removed ${shortAddress(wallet)}${copying ? ' from the copy list' : ' from the bench'} — ${verdict.reason}.`);
          return;
        }
        this.roster.markVetted(wallet, Date.now(), verdict.hours);
        if (verdict.status === 'asleep' && !copying && this.roster.idledAt(wallet) === undefined) this.roster.idle(wallet, Date.now());
        this.log(
          `🧪 Checked ${shortAddress(wallet)}: ` +
            (verdict.status === 'asleep' ? `💤 ${verdict.reason} — kept; it gets a slot when it trades again` : `✅ ${verdict.reason}`)
        );
      })
      .catch(() => {}) // tried again at a later tick
      .finally(() => {
        this.pendingVet = null;
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

  // Drop every copied wallet that has earned it (its slot is refilled by fillSlots).
  private applyDrops(now: number): void {
    for (const w of this.roster.active()) {
      const reason = dropReason(this.store.all(), w, this.cfg);
      if (!reason) continue;
      this.roster.drop(w, reason, now);
      this.log(`🔄 Dropped ${shortAddress(w)} — ${reason}.`);
    }
  }

  // At startup nobody is mid-trade, so the copy list is picked fresh rather
  // than carried over from whenever the bot last stopped (a list picked at
  // night is mostly asleep by the afternoon, and the first minutes were spent
  // swapping it out). Every wallet's latest on-chain activity is checked —
  // one cheap lookup each — and the slots go, in order, to:
  //   1. wallets active in the last WALLET_IDLE_MINUTES: proven winners
  //      first, then the most recently active
  //   2. everyone else, most recently active first
  // The same rule the quiet-wallet check uses once running (a quiet wallet
  // gives way only to one known to be more active), so nothing picked here
  // is swapped straight out. A proven winner that's asleep isn't forced in:
  // it's checked every 5 minutes and brought back the moment it trades.
  // Wallets that couldn't be checked come last, ranked on their usual hours.
  // Call before startup().
  async pickAtStart(now: number, check: (wallet: string) => Promise<number | undefined>): Promise<void> {
    this.clock = now;
    this.applyDrops(now);
    const pool = [...this.roster.active(), ...this.roster.bench()].filter((w) => dropReason(this.store.all(), w, this.cfg) === null);
    if (pool.length === 0) return;
    const toCheck = pool.slice(0, START_CHECKS);
    this.log(`🔎 Checking what your ${toCheck.length} wallet(s) did last, to start with the ones trading now…`);
    let failed = 0;
    for (const w of toCheck) {
      try {
        // No transactions at all is an answer too: known to be inactive (0),
        // not "unknown" — an unknown wallet would be tried once, for nothing.
        const at = (await check(w)) ?? 0;
        if (at > (this.knownActivity.get(w) ?? -1)) this.knownActivity.set(w, at);
      } catch {
        failed += 1; // unknown: judged on its usual hours, and worth one try later
      }
    }
    const idleMs = (this.cfg.walletIdleMinutes > 0 ? this.cfg.walletIdleMinutes : 30) * 60_000;
    const winners = provenWinners(this.store.all());
    const index = new Map(pool.map((w, i) => [w, i]));
    const seen = (w: string) => this.knownActivity.get(w);
    const recent = (w: string) => {
      const at = seen(w);
      return at !== undefined && now - at < idleMs;
    };
    const hour = (w: string) => likelyActive(this.roster.hoursOf(w), now) ?? UNKNOWN_HOUR_SCORE;
    const winnings = (w: string) => winners.get(w) ?? 0;
    const order = [...toCheck].sort((a, b) => {
      const byNow = Number(recent(b)) - Number(recent(a));
      if (byNow !== 0) return byNow;
      if (recent(a) && winnings(b) !== winnings(a)) return winnings(b) - winnings(a);
      const bySeen = (seen(b) ?? 0) - (seen(a) ?? 0);
      if (bySeen !== 0) return bySeen;
      return winnings(b) - winnings(a) || hour(b) - hour(a) || index.get(a)! - index.get(b)!;
    });
    const slots = this.roster.freeSlots() + this.roster.active().length;
    const chosen = order.slice(0, slots);
    const previous = this.roster.active();
    this.roster.setCopyList(chosen);
    for (const w of chosen) this.roster.release(w);
    // Last time's picks that are left out because they're quiet wait as
    // benched-for-quiet; ones left out only for lack of room stay first in line.
    for (const w of previous) if (!chosen.includes(w) && !recent(w)) this.roster.idle(w, now);

    const ago = (at: number) => {
      const min = Math.round((now - at) / 60_000);
      return min < 90 ? `${min} min ago` : `${Math.round(min / 60)}h ago`;
    };
    const why = (w: string) => {
      const at = seen(w);
      if (at === 0) return 'no activity found';
      if (at !== undefined) return `${recent(w) ? 'active' : 'last active'} ${ago(at)}`;
      return hour(w) >= 0.5 ? 'not checked; usually trades at this hour' : 'not checked';
    };
    const trading = chosen.filter(recent).length;
    this.log(
      `▶ Starting with ${chosen.length} wallet(s), ${trading} of them trading now: ` +
        chosen.map((w) => `${shortAddress(w)}${winners.has(w) ? '⭐' : ''} (${why(w)})`).join(', ')
    );
    if (failed > 0) this.log(`   (${failed} couldn't be checked just now — judged on their usual hours instead)`);
  }

  // Before anything is watched: apply drops earned in earlier sessions, fill
  // the slots, and return every wallet that must be watched — the active
  // ones, plus any off the list that we still hold a position from (their
  // sells still count).
  startup(now: number): string[] {
    this.clock = now;
    this.applyDrops(now);
    this.fillSlots(now);
    this.roster.settle();
    this.whyNew.clear();
    const active = this.roster.active();
    this.lastActive = active;
    for (const w of active) this.activeSince.set(w, now);
    this.announceGraduates(active, true); // already past it at startup: counted, not announced
    for (const w of this.roster.all()) {
      if (!active.includes(w) && this.holdsPositionFrom(w) && !this.isRobot(w)) this.finishing.add(w);
    }
    if (this.roster.rechecked > 0) {
      this.log(
        `🧪 ${this.roster.rechecked} wallet(s) turned away only for being quiet are back on the bench (💤) — ` +
          'asleep isn\'t bad any more; each is checked again, one at a time.'
      );
      this.roster.rechecked = 0;
    }
    this.maybeDiscover(now);
    return [...active, ...this.finishing];
  }

  noteBuy(wallet: string, now: number): void {
    this.lastBuy.set(wallet, now);
  }

  async tick(now: number, watch: WatchControl, trader: BuyControl): Promise<void> {
    this.clock = now;
    const before = this.lastActive;
    this.announced.clear();
    this.whyNew.clear();
    this.benchedNow.clear();

    this.applyDrops(now);
    this.dropRobots(now, watch);
    this.wake(now, watch);

    // Quiet wallets give way — each to its own replacement: the best-ranked
    // waiting wallet not already taken this tick and not known to be at
    // least as quiet as it. (Comparing every quiet wallet with the one best
    // waiting wallet, then refilling from the whole bench, let staler wallets
    // back in — and a live run swapped 5–7 wallets back and forth every 30
    // seconds.) A wallet whose activity isn't known yet is worth one try.
    const idleMs = this.cfg.walletIdleMinutes * 60_000;
    if (idleMs > 0) {
      const lastOf = (w: string) => this.lastSign(w, now, watch);
      const quiet = this.roster
        .active()
        .filter((w) => !this.announced.has(w) && now - lastOf(w) >= idleMs)
        .sort((a, b) => lastOf(a) - lastOf(b)); // quietest first
      const waiting = this.roster.bench().filter((x) => !this.benchedNow.has(x));
      const taken = new Set<string>();
      for (const w of quiet) {
        const last = lastOf(w);
        const next = waiting.find((x) => {
          if (taken.has(x) || dropReason(this.store.all(), x, this.cfg) !== null) return false;
          const seen = this.lastSeen(x, watch);
          return seen === undefined || seen > last;
        });
        if (!next) continue; // nobody waiting would do better
        taken.add(next);
        this.roster.idle(w, now);
        this.benchedNow.add(w);
        this.log(
          `🔄 Benched ${shortAddress(w)} — no buys in ${this.cfg.walletIdleMinutes}+ min. ` +
            'It waits on the bench and gets a slot again when it trades.'
        );
        const ctx = this.rankContext();
        if (ctx.awake.has(next)) this.whyNew.set(next, " — it's trading right now");
        else if (this.roster.idledAt(next) !== undefined && (ctx.hourScore(next) ?? 0) >= 0.5) this.whyNew.set(next, ' — it usually trades at this hour');
        this.takeSlot(next, now);
      }
    }
    this.fillSlots(now);

    const active = this.roster.active();
    const activeSet = new Set(active);
    for (const w of before) {
      if (!activeSet.has(w) && this.holdsPositionFrom(w) && !this.isRobot(w)) this.finishing.add(w);
    }
    for (const w of active) {
      this.finishing.delete(w);
      if (!before.includes(w)) {
        if (!this.announced.has(w)) {
          this.activeSince.set(w, now);
          this.lastBuy.delete(w);
          this.log(`🔄 Now copying ${shortAddress(w)} (from the bench)${this.whyNew.get(w) ?? ''}.`);
        }
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
    this.checkBench(now, watch);
    this.maybeVetRoster(now);
  }

  describe(): string {
    const ctx = this.rankContext();
    const active = this.roster.active().map((w) => shortAddress(w) + (ctx.winners.has(w) ? '⭐' : '')).join(', ') || 'none';
    const bench = this.roster.bench();
    const awake = bench.filter((w) => ctx.awake.has(w)).length;
    const onProbation = this.roster.active().filter((w) => this.isPaperOnly(w)).length;
    const parts = [`copying ${active}`, `${bench.length} on the bench${awake > 0 ? ` (${awake} trading now)` : ''}`];
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
  const now = Date.now();
  roster.rankBy(() => ({ now, winners, awake: new Set(), hourScore: (w) => likelyActive(roster.hoursOf(w), now) }));
  const label = (w: string) =>
    shortAddress(w) + (roster.isDiscovered(w) ? '*' : '') + (winners.has(w) ? '⭐' : '') + (roster.idledAt(w) !== undefined ? '💤' : '');
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
    const trial = cfg?.probationTrades ?? PROBATION_TRADES;
    console.log(trial > 0 ? `  * found by discovery — traded on paper until it has ${trial} closed copies in profit` : '  * found by discovery');
    for (const w of roster.active().filter((x) => roster.isDiscovered(x))) {
      console.log(`    ${shortAddress(w)} was picked because: ${roster.discoveredInfo(w)?.why ?? '?'}`);
    }
  }
  if (roster.all().some((w) => roster.idledAt(w) !== undefined)) {
    console.log('  💤 benched for going quiet — gets a slot again when it trades (checked every few minutes)');
  }
  const offset = -new Date(now).getTimezoneOffset();
  const hours = [...roster.active(), ...bench]
    .map((w) => ({ w, text: describeHours(roster.hoursOf(w), offset) }))
    .filter((h) => h.text !== null);
  if (hours.length > 0) {
    console.log('  Usual trading hours (your time):');
    for (const h of hours) console.log(`    ${shortAddress(h.w)}: ${h.text}`);
  }
  for (const d of roster.dropped()) {
    console.log(`  Dropped ${shortAddress(d.wallet)} — ${d.reason} (${new Date(d.at).toLocaleString()})`);
  }
  const rejected = roster.rejectedCount();
  if (rejected > 0) console.log(`  ${rejected} found wallet(s) turned away by vetting in the last 7 days (their own recent trades didn't qualify)`);
  if (winners.size > 0) {
    console.log(`  ⭐ proven winner (${PROVEN_MIN_TRADES}+ closed copies, net profit) — first claim on a slot; brought back as soon as it trades again`);
  }
  console.log('  (Deleting data/wallets.json starts the roster over — but it also forgets every drop, so robots and losing wallets come back.)\n');
}
