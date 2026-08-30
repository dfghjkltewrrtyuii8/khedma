// A single shared rate limiter for EVERY Jupiter API call (orders, executes —
// anything). The free tier allows 1 request/second, shared across everything,
// so we serialize all calls (max 1 in flight) and keep >= minGapMs between
// the START of one call and the START of the next.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RateLimiter {
  private chain: Promise<unknown> = Promise.resolve();
  private lastStartAt = 0;
  private pending = 0;

  constructor(private readonly minGapMs: number) {}

  get pendingCount(): number {
    return this.pending;
  }

  // Queue `fn` to run after everything already scheduled, respecting the gap.
  schedule<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const result = this.chain
      .catch(() => {
        /* a previous call failing must not block the queue */
      })
      .then(async () => {
        const waitMs = this.lastStartAt + this.minGapMs - Date.now();
        if (waitMs > 0) await sleep(waitMs);
        this.lastStartAt = Date.now();
        if (this.pending > 3) {
          console.log(`   (rate limiter: running "${label}", ${this.pending - 1} more queued)`);
        }
        return fn();
      })
      .finally(() => {
        this.pending -= 1;
      });
    this.chain = result;
    return result;
  }
}

export { sleep };
