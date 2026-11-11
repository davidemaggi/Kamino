import type { SyncSnapshot } from "@kamino/status";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InsistentNotices, REPEAT_MS } from "./insistent-notices.js";
import type { DeferredFile, PendingChange } from "./types.js";

const HOUR = 3_600_000;
let now = 10 * 24 * HOUR;
const safe: SyncSnapshot = {
  queued: 0,
  oldestQueuedAt: null,
  lastConfirmedAt: now,
  unreachableSince: null,
  syncing: false,
  conflicts: 0,
  blocked: null,
  quotaRatio: null,
  linked: true,
};

function source(
  snap: () => SyncSnapshot,
  deferred: () => DeferredFile[] = () => [],
  pending: () => PendingChange[] = () => [],
) {
  const cbs = new Set<() => void>();
  return {
    snapshot: snap,
    deferred,
    pending,
    onChange: (cb: () => void) => (cbs.add(cb), () => cbs.delete(cb)),
    fire: () => cbs.forEach((cb) => cb()),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("InsistentNotices (S-05)", () => {
  it("unsent changes older than the threshold: a notice now, then every hour, until fixed", () => {
    let snap: SyncSnapshot = { ...safe, queued: 3, oldestQueuedAt: now - 2 * HOUR };
    const shown: string[] = [];
    const n = new InsistentNotices({
      source: source(() => snap),
      clock: () => now,
      notice: (m) => shown.push(m),
      lang: "en",
    });
    const stop = n.start();
    expect(shown).toHaveLength(1);
    now += REPEAT_MS - 60_000;
    vi.advanceTimersByTime(REPEAT_MS - 60_000);
    expect(shown).toHaveLength(1);
    now += 60_000;
    vi.advanceTimersByTime(60_000);
    expect(shown).toHaveLength(2);
    snap = safe;
    now += REPEAT_MS;
    vi.advanceTimersByTime(REPEAT_MS);
    expect(shown).toHaveLength(2);
    // A new problem notifies again at once.
    snap = { ...safe, unreachableSince: now - 25 * HOUR };
    now += 60_000;
    vi.advanceTimersByTime(60_000);
    expect(shown).toHaveLength(3);
    stop();
  });

  it("files waiting for Wi-Fi alone never nag", () => {
    const snap = { ...safe, queued: 2, oldestQueuedAt: now - 5 * HOUR };
    const shown: string[] = [];
    new InsistentNotices({
      source: source(
        () => snap,
        () => [{ path: "v.mp4", size: 9, direction: "upload", reason: "network" } as DeferredFile],
      ),
      clock: () => now,
      notice: (m) => shown.push(m),
      lang: "en",
    }).start();
    expect(shown).toEqual([]);
  });

  it("held deletions nag", () => {
    const snap = { ...safe, blocked: "deletions" as const, queued: 80 };
    const shown: string[] = [];
    new InsistentNotices({
      source: source(() => snap),
      clock: () => now,
      notice: (m) => shown.push(m),
      lang: "en",
    }).start();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("disappeared");
  });
  it("uploads waiting for Wi-Fi still pending don't nag (review I6)", () => {
    const snap = { ...safe, queued: 1, oldestQueuedAt: now - 5 * HOUR };
    const shown: string[] = [];
    new InsistentNotices({
      source: source(
        () => snap,
        () => [{ path: "v.mp4", size: 9, direction: "upload", reason: "network" } as DeferredFile],
        () => [{ path: "v.mp4", op: "create", since: now - 5 * HOUR }],
      ),
      clock: () => now,
      notice: (m) => shown.push(m),
      lang: "en",
    }).start();
    expect(shown).toEqual([]);
  });

  it("an old queue nags only in Live mode (review I7)", () => {
    const snap = { ...safe, queued: 3, oldestQueuedAt: now - 5 * HOUR };
    for (const [mode, expected] of [
      ["live", 1],
      ["periodic", 0],
      ["manual", 0],
    ] as const) {
      const shown: string[] = [];
      new InsistentNotices({
        source: source(() => snap),
        clock: () => now,
        notice: (m) => shown.push(m),
        lang: "en",
        mode: () => mode,
      }).start();
      expect(shown).toHaveLength(expected);
    }
  });
});
