// Session loss limit: once this session's closed trades are down
// SESSION_MAX_LOSS_USD (losses minus wins), the bot takes no new buys for the
// rest of the session. Open trades are still sold as usual — take-profit,
// stop-loss, trailing stop, or when the copied wallet sells — so nothing is
// left unwatched. Restarting the bot starts a new session.
//
// What counts is exactly what the session's P&L sheet calls "Realized P&L":
// SOL received minus SOL spent, over the positions closed this session in the
// mode the bot runs in (real money, or paper when DRY_RUN=true — so a practice
// run shows the limit working without risking anything).
//
// Once hit it stays hit for the session, even if a later sell wins some of it
// back: "stop when down $45" shouldn't turn into a loop of stopping and
// starting again. The actual loss can still end up past the limit by what the
// trades open at that moment lose before they're sold.

import { inRun } from './positions';
import { Position } from './types';

// Net result in SOL of the trades closed this session, in one mode.
export function sessionResultSol(positions: readonly Position[], since: number, dryRun: boolean): number {
  let net = 0;
  for (const p of positions) {
    if (p.status !== 'closed' || p.dryRun !== dryRun || !inRun(p, since)) continue;
    net += p.receivedSol - p.spentSol;
  }
  return net;
}

// How far down the session is in dollars (0 when it's up), and whether that
// reaches the limit. A limit of 0 is off.
export function lossLimitReached(resultSol: number, solPriceUsd: number, limitUsd: number): { lossUsd: number; reached: boolean } {
  const lossUsd = Math.max(0, -resultSol * solPriceUsd);
  // A cent of rounding slack, so "-$45.00" on the sheet always counts as $45.
  return { lossUsd, reached: limitUsd > 0 && lossUsd >= limitUsd - 0.005 };
}

export function describeLossLimit(limitUsd: number): string {
  return limitUsd > 0 ? `no new buys once this session is down $${limitUsd}` : 'no session loss limit';
}

export class LossLimit {
  private hitAt: number | null = null;
  private hitLossUsd = 0;
  private lastPrice: number | null = null;
  private warnedNoPrice = false;

  constructor(
    private readonly limitUsd: number,
    private readonly since: number,
    private readonly dryRun: boolean,
    private readonly positions: () => readonly Position[],
    private readonly price: () => Promise<number | null>,
    // Told once, the moment the limit is reached (Telegram, terminal).
    private readonly onHit: (message: string) => void,
    private readonly log: (message: string) => void = console.log,
    private readonly now: () => number = Date.now
  ) {}

  get enabled(): boolean {
    return this.limitUsd > 0;
  }

  isHit(): boolean {
    return this.hitAt !== null;
  }

  // Before a buy: null to go ahead, or why not.
  async blockReason(): Promise<string | null> {
    if (!this.enabled) return null;
    await this.update();
    if (this.hitAt === null) return null;
    return `session loss limit reached (down $${this.hitLossUsd.toFixed(2)}, limit $${this.limitUsd}) — no new buys this session; open trades are still sold as usual`;
  }

  // After a trade closes: checks the limit and announces it if this is the
  // trade that reached it.
  async afterClose(): Promise<void> {
    if (!this.enabled || this.hitAt !== null) return;
    await this.update();
  }

  // One line for /status: where the session stands against the limit.
  async statusLine(): Promise<string | null> {
    if (!this.enabled) return null;
    await this.update();
    if (this.hitAt !== null) {
      const at = new Date(this.hitAt).toTimeString().slice(0, 5);
      return `⛔ Loss limit hit at ${at} (down $${this.hitLossUsd.toFixed(2)}) — no new buys this session; open trades are still sold. Restart the bot to start a new session.`;
    }
    const resultSol = sessionResultSol(this.positions(), this.since, this.dryRun);
    const price = resultSol < 0 ? this.lastPrice : 0;
    if (price === null) return `Loss limit: $${this.limitUsd} per session (SOL price not known yet)`;
    const { lossUsd } = lossLimitReached(resultSol, price, this.limitUsd);
    return `Loss limit: down $${lossUsd.toFixed(2)} of $${this.limitUsd} this session`;
  }

  // The price to count in. A buy never waits on the price feed once a price
  // is known: it's refreshed in the background (the feed caches it for a
  // minute anyway), and the last one is used meanwhile.
  private async knownPrice(): Promise<number | null> {
    if (this.lastPrice === null) {
      const fresh = await this.price().catch(() => null);
      if (fresh !== null) this.lastPrice = fresh;
    } else {
      void this.price()
        .then((p) => {
          if (p !== null) this.lastPrice = p;
        })
        .catch(() => {});
    }
    return this.lastPrice;
  }

  // One check at a time: a buy and a sell checking at the same moment must
  // not both announce the limit.
  private updating: Promise<void> | null = null;

  private update(): Promise<void> {
    if (!this.updating) {
      this.updating = this.check().finally(() => {
        this.updating = null;
      });
    }
    return this.updating;
  }

  private async check(): Promise<void> {
    if (this.hitAt !== null) return;
    const resultSol = sessionResultSol(this.positions(), this.since, this.dryRun);
    if (resultSol >= 0) return; // a session that's up can't have hit a loss limit — no price needed
    const price = await this.knownPrice();
    if (price === null) {
      // Without a SOL price dollars can't be counted. Trading isn't stopped
      // over a price-feed hiccup, but it is said once, in plain words.
      if (!this.warnedNoPrice) {
        this.warnedNoPrice = true;
        this.log('   ⚠️ Loss limit: the SOL/USD price is unavailable right now, so the session loss can\'t be checked in dollars yet.');
      }
      return;
    }
    const { lossUsd, reached } = lossLimitReached(resultSol, price, this.limitUsd);
    if (!reached) return;
    this.hitAt = this.now();
    this.hitLossUsd = lossUsd;
    this.onHit(
      `⛔ Loss limit reached: this session is down $${lossUsd.toFixed(2)} (limit $${this.limitUsd}).\n` +
        'No new buys for the rest of this session. Open trades are still sold as usual ' +
        '(take-profit, stop-loss, trailing stop, or when the wallet sells).\n' +
        'Restarting the bot starts a new session.'
    );
  }
}
