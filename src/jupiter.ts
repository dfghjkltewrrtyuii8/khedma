// Thin client for Jupiter Swap API v2 (api.jup.ag/swap/v2).
// EVERY request goes through the shared RateLimiter — never call fetch()
// against api.jup.ag from anywhere else in this codebase.

import { RateLimiter, sleep } from './rateLimiter';

const BASE_URL = 'https://api.jup.ag/swap/v2';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_429_RETRIES = 3;

export type JupiterErrorKind = 'rate-limited' | 'no-route' | 'other';

export class JupiterError extends Error {
  constructor(message: string, public readonly kind: JupiterErrorKind) {
    super(message);
    this.name = 'JupiterError';
  }
}

export interface JupiterOrder {
  requestId: string;
  // Base64 unsigned transaction to sign and pass to execute().
  transactionBase64: string | null;
  inAmountRaw: bigint;
  outAmountRaw: bigint;
}

export interface OrderParams {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint; // raw units of inputMint
  takerPubkey: string;
  slippageBps: number;
}

function looksLikeNoRoute(text: string): boolean {
  return /route|no.?liquidity|not\s*tradable|could\s*not\s*find/i.test(text);
}

export class JupiterClient {
  constructor(
    private readonly apiKey: string,
    private readonly limiter: RateLimiter
  ) {}

  private async request(label: string, url: string, init: RequestInit): Promise<unknown> {
    // Each attempt is scheduled separately so a backoff wait between retries
    // doesn't block other queued Jupiter calls.
    for (let attempt = 1; ; attempt++) {
      const response = await this.limiter.schedule(label, () =>
        fetch(url, {
          ...init,
          headers: { 'x-api-key': this.apiKey, accept: 'application/json', ...(init.headers ?? {}) },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      );

      const bodyText = await response.text();

      if (response.status === 429) {
        if (attempt >= MAX_429_RETRIES) {
          throw new JupiterError(`${label}: still rate-limited (429) after ${attempt} attempts`, 'rate-limited');
        }
        const backoffMs = 2000 * attempt;
        console.log(`   ⏳ Jupiter 429 on ${label}, retrying in ${backoffMs / 1000}s (attempt ${attempt}/${MAX_429_RETRIES})`);
        await sleep(backoffMs);
        continue;
      }

      if (!response.ok) {
        const kind: JupiterErrorKind = looksLikeNoRoute(bodyText) ? 'no-route' : 'other';
        throw new JupiterError(`${label}: HTTP ${response.status} — ${bodyText.slice(0, 500)}`, kind);
      }

      try {
        return JSON.parse(bodyText);
      } catch {
        throw new JupiterError(`${label}: response was not JSON — ${bodyText.slice(0, 500)}`, 'other');
      }
    }
  }

  async getOrder(params: OrderParams): Promise<JupiterOrder> {
    const query = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amountRaw.toString(),
      taker: params.takerPubkey,
      slippageBps: params.slippageBps.toString(),
    });
    const body = (await this.request('order', `${BASE_URL}/order?${query}`, { method: 'GET' })) as Record<
      string,
      unknown
    >;

    const errorText = typeof body.error === 'string' ? body.error : typeof body.errorMessage === 'string' ? body.errorMessage : null;
    if (errorText) {
      throw new JupiterError(`order: ${errorText}`, looksLikeNoRoute(errorText) ? 'no-route' : 'other');
    }

    const inAmount = body.inAmount ?? (body as any).quote?.inAmount;
    const outAmount = body.outAmount ?? (body as any).quote?.outAmount;
    const requestId = body.requestId;
    if (typeof requestId !== 'string' || inAmount == null || outAmount == null) {
      throw new JupiterError(
        `order: unexpected response shape — ${JSON.stringify(body).slice(0, 500)}`,
        'other'
      );
    }

    return {
      requestId,
      transactionBase64: typeof body.transaction === 'string' ? body.transaction : null,
      inAmountRaw: BigInt(String(inAmount)),
      outAmountRaw: BigInt(String(outAmount)),
    };
  }

  // Submits a SIGNED transaction. Safe to retry: the signed transaction has a
  // fixed signature, so the network can only ever execute it once.
  async execute(signedTransactionBase64: string, requestId: string): Promise<{ signature: string }> {
    const body = (await this.request('execute', `${BASE_URL}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signedTransaction: signedTransactionBase64, requestId }),
    })) as Record<string, unknown>;

    const status = typeof body.status === 'string' ? body.status : '';
    const signature = typeof body.signature === 'string' ? body.signature : '';
    if (status.toLowerCase() !== 'success') {
      throw new JupiterError(`execute: status=${status || 'unknown'} — ${JSON.stringify(body).slice(0, 500)}`, 'other');
    }
    return { signature };
  }
}
