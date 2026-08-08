// §6 "Rate limits per key". In-memory token bucket per API key, single
// process (the V1 deployment shape, §2: one process, one SQLite file).
// Buckets are keyed by api_keys.id, so rotating a key does not inherit the
// old bucket and two keys of one agent are limited independently.
export interface RateLimitOptions {
  /** bucket size = burst allowance */
  capacity: number;
  /** tokens added per second */
  refillPerSec: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = { capacity: 60, refillPerSec: 10 };

interface Bucket {
  tokens: number;
  updatedAtMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly opts: RateLimitOptions;

  constructor(opts: RateLimitOptions = DEFAULT_RATE_LIMIT) {
    if (opts.capacity < 1 || opts.refillPerSec < 0) {
      throw new Error("rate limit: capacity >= 1 and refillPerSec >= 0 required");
    }
    this.opts = opts;
  }

  /** Take one token for keyId; false = over limit (caller maps to RATE_LIMITED). */
  take(keyId: string, nowMs: number): boolean {
    let bucket = this.buckets.get(keyId);
    if (!bucket) {
      bucket = { tokens: this.opts.capacity, updatedAtMs: nowMs };
      this.buckets.set(keyId, bucket);
    } else if (nowMs > bucket.updatedAtMs) {
      const refill = ((nowMs - bucket.updatedAtMs) / 1000) * this.opts.refillPerSec;
      bucket.tokens = Math.min(this.opts.capacity, bucket.tokens + refill);
      bucket.updatedAtMs = nowMs;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}
