/** How long a path the engine touched stays recognisable (spec §6.6). */
export const ECHO_MS = 10_000;

type Stat = { size: number; mtime: number } | null;

/**
 * Vault events caused by the engine's own writes (F4): recognised by path and by the exact
 * size and mtime the engine left, so a user edit in the same seconds is never swallowed.
 */
export class EchoGuard {
  private readonly seen = new Map<string, { stat: Stat; at: number }>();

  constructor(private readonly now: () => number) {}

  record(path: string, stat: Stat): void {
    this.seen.set(path, {
      stat: stat ? { size: stat.size, mtime: stat.mtime } : null,
      at: this.now(),
    });
    if (this.seen.size > 1000) this.prune();
  }

  isEcho(path: string, stat: Stat): boolean {
    const s = this.seen.get(path);
    if (!s || this.now() - s.at > ECHO_MS) return false;
    if (s.stat === null || stat === null) return s.stat === stat;
    return s.stat.size === stat.size && s.stat.mtime === stat.mtime;
  }

  private prune(): void {
    const now = this.now();
    for (const [p, s] of this.seen) if (now - s.at > ECHO_MS) this.seen.delete(p);
  }
}
