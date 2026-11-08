import { describe, expect, it } from "vitest";
import { describeStatus } from "./describe.js";
import { exampleSnapshots } from "./examples.js";
import { DEFAULT_THRESHOLDS, type SyncSnapshot } from "./types.js";

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const HOUR = 3_600_000;
const synced: SyncSnapshot = {
  queued: 0,
  oldestQueuedAt: null,
  lastConfirmedAt: NOW - 60_000,
  unreachableSince: null,
  syncing: false,
  conflicts: 0,
  blocked: null,
  quotaRatio: null,
};

describe("describeStatus examples", () => {
  for (const ex of exampleSnapshots(NOW)) {
    it(ex.id, () => {
      const d = describeStatus(ex.snapshot, DEFAULT_THRESHOLDS, NOW);
      expect(d.level).toBe(ex.expected.level);
      expect(d.message.key).toBe(ex.expected.key);
    });
  }
});

describe("describeStatus rules", () => {
  it("offline below threshold stays safe with a note", () => {
    const d = describeStatus(
      { ...synced, unreachableSince: NOW - 23 * HOUR },
      DEFAULT_THRESHOLDS,
      NOW,
    );
    expect(d.level).toBe("safe");
    expect(d.secondary).toEqual([{ key: "note.unreachable", params: { ageMs: 23 * HOUR } }]);
  });

  it("offline at threshold becomes attention", () => {
    const d = describeStatus(
      { ...synced, unreachableSince: NOW - 24 * HOUR },
      DEFAULT_THRESHOLDS,
      NOW,
    );
    expect(d.level).toBe("attention");
    expect(d.message).toEqual({ key: "attention.offline", params: { ageMs: 24 * HOUR, count: 0 } });
  });

  it("never synced with empty queue is not safe", () => {
    const d = describeStatus({ ...synced, lastConfirmedAt: null }, DEFAULT_THRESHOLDS, NOW);
    expect(d.level).toBe("working");
    expect(d.message.key).toBe("working.neverSynced");
  });

  it("blocked reports the queued count and lists other conditions as secondary", () => {
    const d = describeStatus(
      { ...synced, blocked: "quota", queued: 12, oldestQueuedAt: NOW - 2 * HOUR, conflicts: 1 },
      DEFAULT_THRESHOLDS,
      NOW,
    );
    expect(d.message).toEqual({ key: "blocked.quota", params: { count: 12 } });
    expect(d.secondary.map((m) => m.key)).toEqual([
      "decision.conflicts",
      "attention.stale",
      "working.queued",
    ]);
  });

  it("quota percent is floored, so a warning never reads 100%", () => {
    const d = describeStatus({ ...synced, quotaRatio: 0.996 }, DEFAULT_THRESHOLDS, NOW);
    expect(d.message).toEqual({ key: "attention.quota", params: { percent: 99 } });
  });

  it("carries icon and lastConfirmedAt", () => {
    const d = describeStatus(synced, DEFAULT_THRESHOLDS, NOW);
    expect(d.icon).toBe("shield-check");
    expect(d.lastConfirmedAt).toBe(NOW - 60_000);
  });
});
