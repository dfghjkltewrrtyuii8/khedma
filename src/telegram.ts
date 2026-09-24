// Reports on your phone over Telegram, so an overnight run can be checked
// without scrolling back through the terminal.
//
//   • /pnl, /open, /wallets, /status — answered from YOUR chat only
//   • a report every TELEGRAM_REPORT_HOURS, and a final one when the bot stops
//   • a message per closed trade (TELEGRAM_TRADE_ALERTS=sells, the default)
//   • a note when the laptop slept, since nothing is watched while it sleeps
//
// Read-only on purpose: no command buys, sells or changes a setting, so
// someone holding your phone can look but not trade. Messages from anyone
// else are ignored without a reply. Everything arrives silently (no buzz)
// except a real-money sell that failed. The bot token lives in .env only and
// is scrubbed from every error message, so it never lands in a log.
//
// Set up with `npm run telegram`. Everything that isn't a network call is a
// pure function over plain data, so it is tested offline.

import type { TradeAlerts } from './config';
import { allRunsLine, TOKEN_ACCOUNT_RENT_SOL } from './pnl';
import { sleep } from './rateLimiter';
import { Position, PositionStatus } from './types';
import { walletRecords } from './walletGate';
import { shortAddress } from './watcher';

const API = 'https://api.telegram.org';
const POLL_SECONDS = 25; // long poll: Telegram holds the request open until a message arrives
const MAX_TEXT = 4_000; // Telegram's limit is 4096 characters per message
const MAX_QUEUED = 30; // beyond this, the oldest unsent messages are dropped
const SEND_GAP_MS = 1_100; // Telegram allows about one message a second per chat

// ------------------------------------------------------------------ API ---

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TelegramMessage {
  date: number; // epoch seconds
  chat: { id: number; type: string };
  from?: TelegramUser;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type TelegramErrorKind =
  | 'unauthorized' // the token was rejected
  | 'blocked' // you blocked the bot, or never pressed Start
  | 'chat-not-found'
  | 'conflict' // another program is reading this bot's messages
  | 'rate-limited'
  | 'network'
  | 'other';

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly kind: TelegramErrorKind,
    readonly retryAfterSec: number | null = null
  ) {
    super(message);
  }
}

function errorKind(status: number, description: string): TelegramErrorKind {
  if (status === 401 || status === 404) return 'unauthorized'; // 404 is what a malformed token gets
  if (status === 403) return 'blocked';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate-limited';
  if (/chat not found/i.test(description)) return 'chat-not-found';
  return 'other';
}

// What went wrong, in words, with what to do about it.
export function explainTelegramError(error: unknown): string {
  if (!(error instanceof TelegramError)) return (error as Error)?.message ?? String(error);
  switch (error.kind) {
    case 'unauthorized':
      return 'the bot token was rejected (revoked in @BotFather, or mistyped). Run: npm run telegram';
    case 'blocked':
      return 'Telegram says you blocked the bot or never pressed Start. Open your bot in Telegram, press Start (or Unblock), then try again.';
    case 'chat-not-found':
      return "your chat wasn't found. Run: npm run telegram";
    case 'conflict':
      return 'another program is already reading this bot\'s messages. Only one bot can use a token — stop the other one (another Terminal window, or someone else\'s computer using the same token).';
    case 'rate-limited':
      return `Telegram asked us to slow down${error.retryAfterSec ? ` for ${error.retryAfterSec}s` : ''}.`;
    case 'network':
      return `can't reach Telegram (${error.message}). Reports resume when the connection is back.`;
    default:
      return error.message;
  }
}

interface ApiReply<T> {
  ok?: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init)
  ) {}

  // The token is part of every request URL, so it could surface in an error
  // message. Nothing leaves this class without it removed.
  private scrub(text: string): string {
    return this.token ? text.split(this.token).join('<token>') : text;
  }

  private async call<T>(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    let response;
    try {
      response = await this.fetchFn(`${API}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new TelegramError(this.scrub((error as Error).message || 'no connection'), 'network');
    }
    let body: ApiReply<T> | null;
    try {
      body = (await response.json()) as ApiReply<T>;
    } catch {
      body = null;
    }
    if (response.ok && body?.ok) return body.result as T;
    const description = this.scrub(String(body?.description ?? `HTTP ${response.status}`));
    throw new TelegramError(description, errorKind(response.status, description), body?.parameters?.retry_after ?? null);
  }

  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe', {});
  }

  getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, (timeoutSec + 15) * 1000);
  }

  sendMessage(chatId: string, text: string, silent: boolean): Promise<unknown> {
    const body = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 20)}\n… (cut short)` : text;
    return this.call('sendMessage', {
      chat_id: chatId,
      text: body,
      disable_notification: silent,
      link_preview_options: { is_disabled: true },
    });
  }
}

// ------------------------------------------------------------ formatting ---

function money(sol: number, solPriceUsd: number | null): string {
  const sign = sol >= 0 ? '+' : '-';
  const usd = solPriceUsd === null ? '' : ` (${sign}$${Math.abs(sol * solPriceUsd).toFixed(2)})`;
  return `${sign}${Math.abs(sol).toFixed(4)} SOL${usd}`;
}

function pct(x: number): string {
  return `${x >= 0 ? '+' : ''}${x.toFixed(0)}%`;
}

export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// Local time on this computer, e.g. "06:40".
function clock(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 5);
}

const result = (p: Position) => p.receivedSol - p.spentSol;
const resultPct = (p: Position) => (p.spentSol > 0 ? (result(p) / p.spentSol) * 100 : 0);
const closedAt = (p: Position) => Date.parse(p.closedAt ?? p.openedAt) || 0;

export interface ReportInput {
  positions: readonly Position[];
  now: number;
  solPriceUsd: number | null;
  // What an open position is worth now, in SOL, if known.
  priceOf?: (positionId: string) => number | undefined;
}

function pnlGroup(label: string, positions: Position[], input: ReportInput, recentSince?: number, recentLabel?: string): string[] {
  if (positions.length === 0) return [];
  const lines = [`── ${label} ──`];
  const closed = positions.filter((p) => p.status === 'closed');
  const open = positions.filter((p) => p.status === 'open');
  const stuck = positions.filter((p) => p.status === 'stuck');

  if (closed.length === 0) {
    lines.push('No closed trades yet.');
  } else {
    const wins = closed.filter((p) => result(p) > 0).length;
    lines.push(`Closed ${closed.length} · ${wins} won / ${closed.length - wins} lost (${Math.round((wins / closed.length) * 100)}%)`);
    lines.push(`Total: ${money(closed.reduce((a, p) => a + result(p), 0), input.solPriceUsd)}`);
    if (recentSince !== undefined) {
      const recent = closed.filter((p) => closedAt(p) >= recentSince);
      lines.push(
        recent.length === 0
          ? `${recentLabel ?? 'Recently'}: nothing closed`
          : `${recentLabel ?? 'Recently'}: ${recent.length} closed, ${money(recent.reduce((a, p) => a + result(p), 0), input.solPriceUsd)}`
      );
    }
    const sorted = [...closed].sort((a, b) => resultPct(b) - resultPct(a));
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    lines.push(
      closed.length === 1
        ? `Trade: ${shortAddress(best.mint)} ${pct(resultPct(best))}`
        : `Best ${shortAddress(best.mint)} ${pct(resultPct(best))} · worst ${shortAddress(worst.mint)} ${pct(resultPct(worst))}`
    );
  }

  if (open.length > 0) {
    const priced = open.filter((p) => input.priceOf?.(p.id) !== undefined);
    if (priced.length === 0) {
      lines.push(`Open ${open.length} (not priced yet)`);
    } else {
      const unrealized = priced.reduce((a, p) => a + input.priceOf!(p.id)! + p.receivedSol - p.spentSol, 0);
      lines.push(`Open ${open.length} · worth now ${money(unrealized, input.solPriceUsd)}${priced.length < open.length ? ` (${priced.length} priced)` : ''}`);
    }
  }
  if (stuck.length > 0) lines.push(`🔴 Stuck ${stuck.length} — sells failed, tokens still held`);

  // Paper trades pay nothing to hold a token; real ones do. At these sizes
  // that decides whether a small paper profit would have been real.
  if (positions[0].dryRun && closed.length > 0) {
    lines.push(`Real trades would also lock ~${TOKEN_ACCOUNT_RENT_SOL.toFixed(3)} SOL rent + fees each: about -${(closed.length * TOKEN_ACCOUNT_RENT_SOL).toFixed(4)} SOL on these ${closed.length}.`);
  }
  return lines;
}

// `positions` is what the sheet covers (usually this run). Pass `allTime` to
// add one line with the totals over every run.
export function formatPnl(
  input: ReportInput & { title: string; recentSince?: number; recentLabel?: string; allTime?: readonly Position[] }
): string {
  const paper = input.positions.filter((p) => p.dryRun);
  const real = input.positions.filter((p) => !p.dryRun);
  const lines = [`📊 ${input.title}`];
  if (paper.length === 0 && real.length === 0) {
    lines.push('No trades yet — still watching.');
  } else {
    const groups = [
      pnlGroup('PAPER (simulated, no real money)', paper, input, input.recentSince, input.recentLabel),
      pnlGroup('💰 REAL MONEY', real, input, input.recentSince, input.recentLabel),
    ].filter((g) => g.length > 0);
    groups.forEach((g, i) => lines.push(...(i > 0 ? ['', ...g] : g)));
  }
  if (input.allTime) {
    const line = allRunsLine(input.allTime, input.positions, input.solPriceUsd);
    if (line) lines.push('', line);
  }
  return lines.join('\n');
}

export function formatOpen(input: ReportInput): string {
  const held = input.positions
    .filter((p) => p.status === 'open' || p.status === 'stuck')
    .sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
  if (held.length === 0) return '📂 Nothing open right now.';
  const lines = [`📂 Open trades (${held.length})`];
  for (const p of held.slice(0, 12)) {
    const mode = p.dryRun ? 'paper' : 'REAL';
    const age = duration(input.now - (Date.parse(p.openedAt) || input.now));
    if (p.status === 'stuck') {
      lines.push(`🔴 ${shortAddress(p.mint)} · ${mode} · STUCK — sell failed, tokens still held`);
    } else {
      const value = input.priceOf?.(p.id);
      const worth =
        value === undefined
          ? `cost ${p.spentSol.toFixed(4)} SOL, not priced yet`
          : `${pct(((value + p.receivedSol - p.spentSol) / p.spentSol) * 100)} (${value.toFixed(4)} SOL)`;
      lines.push(`• ${shortAddress(p.mint)} · ${mode} · ${worth} · ${age} · from ${shortAddress(p.sourceWallet)}`);
    }
    lines.push(`  https://dexscreener.com/solana/${p.mint}`);
  }
  if (held.length > 12) lines.push(`…and ${held.length - 12} more (npm run summary on the computer lists all).`);
  return lines.join('\n');
}

export interface WalletsInput {
  positions: readonly Position[];
  copying: string[];
  bench: string[];
  dropped: { wallet: string; reason: string }[];
  isDiscovered: (wallet: string) => boolean;
  isPaperOnly: (wallet: string) => boolean;
  solPriceUsd: number | null;
}

export function formatWallets(input: WalletsInput): string {
  const records = walletRecords(input.positions);
  const label = (w: string) => shortAddress(w) + (input.isDiscovered(w) ? '*' : '');
  const lines = ['👛 Wallets (records over all runs — drops and probation are judged on them)', `Copying now (${input.copying.length}):`];
  for (const w of input.copying) {
    const r = records.get(w);
    const record = r ? `${r.closed} closed, ${r.wins}W/${r.losses}L, ${money(r.netSol, input.solPriceUsd)}` : 'no closed trades yet';
    lines.push(`• ${label(w)} — ${record}${input.isPaperOnly(w) ? ' · paper-only until proven' : ''}`);
  }
  if (input.bench.length > 0) lines.push(`Bench: ${input.bench.length} waiting (next: ${label(input.bench[0])})`);
  for (const d of input.dropped.slice(-5)) lines.push(`Dropped ${shortAddress(d.wallet)} — ${d.reason}`);
  if ([...input.copying, ...input.bench].some((w) => input.isDiscovered(w))) lines.push('* found by discovery');
  return lines.join('\n');
}

// When each copied wallet last did anything on-chain — the line that tells
// "the wallets are quiet" apart from "the bot is broken".
export interface WalletActivity {
  wallet: string;
  at: number | undefined; // epoch ms; undefined = not checked yet
}

export function describeActivity(list: WalletActivity[], now: number): string {
  return list
    .map(({ wallet, at }) =>
      `${shortAddress(wallet)} ${at === undefined ? 'not checked yet' : now - at < 60_000 ? 'just now' : `${duration(now - at)} ago`}`
    )
    .join(' · ');
}

// True when every copied wallet is known to have done nothing for quietMs.
export function allQuiet(list: WalletActivity[], now: number, quietMs = 60 * 60_000): boolean {
  return list.length > 0 && list.every(({ at }) => at !== undefined && now - at >= quietMs);
}

export function quietHint(rotating: boolean): string {
  return rotating
    ? "💤 None of the wallets it copies has traded in the last hour — that's why nothing is happening, not a fault. Quiet wallets are swapped for active ones automatically."
    : "💤 None of the wallets it copies has traded in the last hour — that's why nothing is happening, not a fault. Turn on the wallet scanner so quiet wallets get swapped for active ones: npm run recommended";
}

export interface StatusInput {
  now: number;
  startedAt: number;
  dryRun: boolean;
  watching: number;
  processed: number;
  missedUnreadable: number;
  lastSwap: { at: number; wallet: string } | null;
  sleeps: { from: number; to: number }[];
  nextReportAt: number | null;
  activity: WalletActivity[];
  rotating: boolean;
}

export function formatStatus(s: StatusInput): string {
  const lines = [
    `🟢 Running ${duration(s.now - s.startedAt)} · ${s.dryRun ? 'PAPER mode' : '💰 REAL MONEY mode'}`,
    `Watching ${s.watching} wallet(s) · ${s.processed} transactions checked`,
    s.lastSwap
      ? `Last trade seen ${duration(s.now - s.lastSwap.at)} ago (${shortAddress(s.lastSwap.wallet)})`
      : 'No trades seen yet from the wallets it copies',
  ];
  if (s.activity.length > 0) {
    lines.push(`Last on-chain activity: ${describeActivity(s.activity, s.now)}`);
    if (allQuiet(s.activity, s.now)) lines.push(quietHint(s.rotating));
  }
  if (s.sleeps.length > 0) {
    const total = s.sleeps.reduce((a, g) => a + (g.to - g.from), 0);
    const last = s.sleeps[s.sleeps.length - 1];
    lines.push(`😴 Laptop slept ${s.sleeps.length}× this run, ${duration(total)} in total (last ${clock(last.from)}–${clock(last.to)})`);
  }
  if (s.missedUnreadable > 0) lines.push(`🚨 ${s.missedUnreadable} trade(s) were in a format this version can't read — update the bot.`);
  if (s.nextReportAt !== null) lines.push(`Next report in ${duration(s.nextReportAt - s.now)}`);
  return lines.join('\n');
}

export function formatSleep(gap: { from: number; to: number }, platform: string = process.platform): string {
  const tip =
    platform === 'darwin'
      ? 'To keep it awake: plugged in, lid open, and start it with\ncaffeinate -is npm start'
      : platform === 'win32'
        ? 'To keep it awake: Settings → System → Power → "When plugged in, put my device to sleep after" → Never.'
        : 'Keep the computer from sleeping while the bot runs.';
  return (
    `😴 The computer was asleep ${clock(gap.from)}–${clock(gap.to)} (${duration(gap.to - gap.from)}). ` +
    'The bot can\'t watch while it sleeps, so trades in that window were missed.\n' +
    tip
  );
}

export function helpText(reportHours: number): string {
  return [
    '🤖 Copybot reports (read-only — it can\'t trade from here, on purpose)',
    '/pnl — profit and loss so far',
    '/open — what it holds right now, with charts',
    '/wallets — who it copies and how each is doing',
    '/status — running? last trade seen? did the laptop sleep?',
    reportHours > 0 ? `A report arrives every ${reportHours}h, and a final one when the bot stops.` : 'A final report arrives when the bot stops.',
  ].join('\n');
}

// ----------------------------------------------------------- trade feed ---

export interface TradeEvent {
  kind: 'opened' | 'closed' | 'stuck';
  position: Position;
}

// Turns changes in the position store into trade events, by comparing each
// position's status with what it was at the last poll. Positions that
// existed when the feed was created are not announced.
export class TradeFeed {
  private seen = new Map<string, PositionStatus>();

  constructor(existing: readonly Position[]) {
    for (const p of existing) this.seen.set(p.id, p.status);
  }

  poll(positions: readonly Position[]): TradeEvent[] {
    const events: TradeEvent[] = [];
    for (const p of positions) {
      const before = this.seen.get(p.id);
      if (before === p.status) continue;
      this.seen.set(p.id, p.status);
      if (p.status === 'open' && before === undefined) events.push({ kind: 'opened', position: p });
      else if (p.status === 'closed') events.push({ kind: 'closed', position: p });
      else if (p.status === 'stuck') events.push({ kind: 'stuck', position: p });
    }
    return events;
  }
}

const EXIT_WORDS: Record<string, string> = {
  'stop-loss': 'stop-loss',
  'trailing-stop': 'trailing stop',
  'take-profit': 'take-profit',
};

// The message for one trade event, or null if TELEGRAM_TRADE_ALERTS says to
// stay quiet about it. Only a failed real-money sell makes the phone buzz.
export function formatTradeEvent(
  event: TradeEvent,
  alerts: TradeAlerts,
  solPriceUsd: number | null
): { text: string; silent: boolean } | null {
  const p = event.position;
  const mode = p.dryRun ? 'paper' : 'REAL';
  if (event.kind === 'stuck') {
    return {
      text: `🔴 Sell failed — ${shortAddress(p.mint)} is stuck (${mode}). The tokens are still held; the bot retries when it stops.\nhttps://dexscreener.com/solana/${p.mint}`,
      silent: p.dryRun,
    };
  }
  if (event.kind === 'opened') {
    if (alerts !== 'all') return null;
    return { text: `🛒 Bought ${shortAddress(p.mint)} · ${p.spentSol.toFixed(4)} SOL · ${mode} · copying ${shortAddress(p.sourceWallet)}`, silent: true };
  }
  if (alerts === 'off') return null;
  const why = p.exitRule ? EXIT_WORDS[p.exitRule] ?? p.exitRule : 'they sold';
  return {
    text: `${result(p) > 0 ? '✅' : '🔻'} Sold ${shortAddress(p.mint)} ${pct(resultPct(p))} (${money(result(p), solPriceUsd)}) · ${mode} · ${why} · from ${shortAddress(p.sourceWallet)}`,
    silent: true,
  };
}

// ------------------------------------------------------------ the bot ---

export type CommandName = 'pnl' | 'open' | 'wallets' | 'status' | 'help';

// "/pnl", "/pnl@MyCopyBot", "pnl", "P&L" all mean the same thing.
export function parseCommand(text: string): CommandName {
  const word = text.trim().split(/\s+/)[0]?.replace(/^\//, '').replace(/@.*$/, '').toLowerCase() ?? '';
  if (['pnl', 'p&l', 'profit', 'profits'].includes(word)) return 'pnl';
  if (['open', 'positions', 'holding'].includes(word)) return 'open';
  if (['wallets', 'wallet'].includes(word)) return 'wallets';
  if (['status', 'running'].includes(word)) return 'status';
  return 'help';
}

export type CommandHandlers = Record<Exclude<CommandName, 'help'>, () => Promise<string>>;

export class TelegramBot {
  private queue: { text: string; silent: boolean }[] = [];
  private draining: Promise<void> | null = null;
  private stopped = false;
  private reported = new Set<TelegramErrorKind>();

  constructor(
    private readonly client: TelegramClient,
    private readonly chatId: string,
    private readonly handlers: CommandHandlers,
    private readonly reportHours: number,
    private readonly log: (message: string) => void = console.log,
    private readonly sendGapMs = SEND_GAP_MS
  ) {}

  // Queue a message. Never throws and never blocks trading; failures are
  // reported once per kind in the terminal.
  send(text: string, silent = true): void {
    if (this.queue.length >= MAX_QUEUED) this.queue.shift();
    this.queue.push({ text, silent });
    if (!this.draining) {
      this.draining = this.drain().finally(() => {
        this.draining = null;
      });
    }
  }

  // Wait (up to timeoutMs) for queued messages to go out — used on shutdown.
  async flush(timeoutMs: number): Promise<void> {
    if (this.draining) await Promise.race([this.draining, sleep(timeoutMs)]);
  }

  start(): void {
    void this.pollLoop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const message = this.queue.shift()!;
      await this.deliver(message);
      if (this.queue.length > 0) await sleep(this.sendGapMs);
    }
  }

  private async deliver(message: { text: string; silent: boolean }, attempt = 1): Promise<void> {
    try {
      await this.client.sendMessage(this.chatId, message.text, message.silent);
    } catch (error) {
      const e = error as TelegramError;
      if (e.kind === 'rate-limited' && attempt === 1) {
        await sleep((e.retryAfterSec ?? 5) * 1000);
        return this.deliver(message, 2);
      }
      this.problem(e);
    }
  }

  private problem(error: unknown): void {
    const kind = error instanceof TelegramError ? error.kind : 'other';
    if (this.reported.has(kind)) return;
    this.reported.add(kind);
    this.log(`   📵 Telegram: ${explainTelegramError(error)}`);
  }

  private async pollLoop(): Promise<void> {
    let offset = 0;
    // Skip whatever was sent while the bot was off: answering a pile of old
    // requests at startup helps no one. (-1 = "just the latest, forget the rest".)
    try {
      const pending = await this.client.getUpdates(-1, 0);
      if (pending.length > 0) offset = pending[pending.length - 1].update_id + 1;
    } catch (error) {
      this.problem(error);
      if (error instanceof TelegramError && error.kind === 'unauthorized') return;
    }
    let backoffMs = 5_000;
    while (!this.stopped) {
      let updates: TelegramUpdate[];
      try {
        updates = await this.client.getUpdates(offset, POLL_SECONDS);
        backoffMs = 5_000;
      } catch (error) {
        this.problem(error);
        if (error instanceof TelegramError && error.kind === 'unauthorized') return; // won't fix itself
        const retryAfter = error instanceof TelegramError && error.retryAfterSec ? error.retryAfterSec * 1000 : backoffMs;
        await sleep(retryAfter);
        backoffMs = Math.min(backoffMs * 2, 60_000);
        continue;
      }
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        if (!this.stopped) await this.handle(update);
      }
    }
  }

  // Exposed for tests. Anything not from your chat is dropped without a reply.
  async handle(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message || String(message.chat.id) !== this.chatId) return;
    const command = parseCommand(message.text ?? '');
    let reply: string;
    try {
      reply = command === 'help' ? helpText(this.reportHours) : await this.handlers[command]();
    } catch (error) {
      reply = `Couldn't build that just now: ${(error as Error).message}`;
    }
    this.send(reply, true);
  }
}
