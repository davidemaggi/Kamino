import { ApiError } from "../http/errors.js";
export interface Limit {
  max: number;
  windowMs: number;
}

/** In-memory fixed windows (single instance, 04 §8). */
export class RateLimiter<B extends string> {
  private readonly hits = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limits: Record<B, Limit>,
    private readonly now: () => number = Date.now,
  ) {}

  hit(bucket: B, key: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const { max, windowMs } = this.limits[bucket];
    const id = `${bucket}\u0000${key}`;
    const t = this.now();
    // Expired windows are dropped once the map grows: memory stays bounded.
    if (this.hits.size > 10_000)
      for (const [k, v] of this.hits) if (t - v.start >= windowMs) this.hits.delete(k);
    const cur = this.hits.get(id);
    if (!cur || t - cur.start >= windowMs) {
      this.hits.set(id, { start: t, count: 1 });
      return { ok: true };
    }
    if (cur.count >= max)
      return {
        ok: false,
        retryAfterSec: Math.max(1, Math.ceil((cur.start + windowMs - t) / 1000)),
      };
    cur.count++;
    return { ok: true };
  }

  /** Like `hit`, but throws `RateLimited` (a 429 with `Retry-After`) when over the limit. */
  check(bucket: B, key: string): void {
    const r = this.hit(bucket, key);
    if (!r.ok) throw new RateLimited(r.retryAfterSec);
  }
}

export class RateLimited extends ApiError {
  constructor(readonly retryAfterSec: number) {
    super("rate_limited", 429);
  }
}
