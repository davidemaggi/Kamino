import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { describeStatus } from "./describe.js";
import { severity } from "./levels.js";
import { DEFAULT_THRESHOLDS, type SyncSnapshot } from "./types.js";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const past = fc.integer({ min: 0, max: 30 * DAY }).map((d) => NOW - d);

const snapshotArb: fc.Arbitrary<SyncSnapshot> = fc
  .record({
    queued: fc.nat({ max: 500 }),
    oldestQueuedAt: past,
    lastConfirmedAt: fc.option(past, { nil: null }),
    unreachableSince: fc.option(past, { nil: null }),
    syncing: fc.boolean(),
    conflicts: fc.nat({ max: 20 }),
    blocked: fc.constantFrom(null, "quota", "revoked", "auth", "protocol"),
    quotaRatio: fc.option(fc.double({ min: 0, max: 2, noNaN: true }), { nil: null }),
  })
  .map((s) => ({ ...s, oldestQueuedAt: s.queued > 0 ? s.oldestQueuedAt : null }));

const describe_ = (s: SyncSnapshot) => describeStatus(s, DEFAULT_THRESHOLDS, NOW);
const sev = (s: SyncSnapshot) => severity(describe_(s).level);

describe("describeStatus properties", () => {
  it("P1: safe implies nothing pending", () => {
    fc.assert(
      fc.property(snapshotArb, (s) => {
        if (describe_(s).level !== "safe") return;
        expect(s.queued).toBe(0);
        expect(s.lastConfirmedAt).not.toBeNull();
        expect(s.conflicts).toBe(0);
        expect(s.blocked).toBeNull();
      }),
    );
  });

  it("P2: worsening a snapshot never lowers severity", () => {
    const worsen = fc.constantFrom<(s: SyncSnapshot) => SyncSnapshot>(
      (s) => ({ ...s, queued: s.queued + 1, oldestQueuedAt: s.oldestQueuedAt ?? NOW }),
      (s) => ({ ...s, conflicts: s.conflicts + 1 }),
      (s) => ({ ...s, blocked: "quota" }),
      (s) => ({ ...s, quotaRatio: (s.quotaRatio ?? 0) + 0.5 }),
      (s) => ({ ...s, unreachableSince: (s.unreachableSince ?? NOW) - DAY }),
      (s) => (s.oldestQueuedAt === null ? s : { ...s, oldestQueuedAt: s.oldestQueuedAt - DAY }),
    );
    fc.assert(fc.property(snapshotArb, worsen, (s, f) => sev(f(s)) >= sev(s)));
  });

  it("P3: deterministic", () => {
    fc.assert(
      fc.property(snapshotArb, (s) => {
        expect(describe_(s)).toEqual(describe_(s));
      }),
    );
  });

  it("P4: every true condition is reported", () => {
    fc.assert(
      fc.property(snapshotArb, (s) => {
        const d = describe_(s);
        const keys = [d.message.key, ...d.secondary.map((m) => m.key)];
        if (s.blocked) expect(keys).toContain(`blocked.${s.blocked}`);
        if (s.conflicts > 0) expect(keys).toContain("decision.conflicts");
        if (s.queued > 0) expect(keys.some((k) => k.startsWith("working."))).toBe(true);
        if (s.unreachableSince !== null) {
          expect(keys.some((k) => k === "attention.offline" || k === "note.unreachable")).toBe(
            true,
          );
        }
      }),
    );
  });
});
