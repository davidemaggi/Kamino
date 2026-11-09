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
}
