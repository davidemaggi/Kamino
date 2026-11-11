import type { SyncSnapshot } from "@kamino/status";
import { describe, expect, it } from "vitest";
import { EngineState, type StateEngine } from "./engine-state.js";

const snap: SyncSnapshot = {
  queued: 2,
  oldestQueuedAt: 1,
  lastConfirmedAt: 1,
  unreachableSince: null,
  syncing: false,
  conflicts: 1,
  blocked: null,
  quotaRatio: null,
  linked: true,
};

function stub(): StateEngine & { syncs: number; fire(): void } {
  const cbs = new Set<() => void>();
  return {
    syncs: 0,
    snapshot: () => snap,
    conflicts: () => [
      { id: "c1", fileId: "f1", path: "notes/a.md" },
      { id: "c2", fileId: "f2", path: null },
    ],
    pending: () => [{ path: "b.md", op: "create", since: 3 }],
    deferred: () => [{ path: "big.bin", size: 9, direction: "upload" }],
    async syncNow() {
      this.syncs++;
    },
    async confirmDeletions() {
      this.syncs += 10;
    },
    onChange(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    fire() {
      for (const cb of cbs) cb();
    },
  };
}

const device = { name: "Laptop", mode: "live" as const, server: "sync.example.org" };

describe("EngineState", () => {
  it("is 'not linked' without an engine", async () => {
    let engine: StateEngine | null = null;
    const notices: string[] = [];
    const s = new EngineState({
      engine: () => engine,
      onHostChange: () => () => {},
      device: () => device,
      notice: (m) => notices.push(m),
      comingSoon: "soon",
    });
    expect(s.snapshot()).toMatchObject({ linked: false, queued: 0 });
    expect(s.pending()).toEqual([]);
    await s.syncNow();
    engine = stub();
    expect(s.snapshot()).toBe(snap);
  });

  it("forwards the engine's state and says resolution is coming", async () => {
    const e = stub();
    const notices: string[] = [];
    let hostCb: () => void = () => {};
    const s = new EngineState({
      engine: () => e,
      onHostChange: (cb) => {
        hostCb = cb;
        return () => {};
      },
      device: () => device,
      notice: (m) => notices.push(m),
      comingSoon: "soon",
    });
    let changes = 0;
    s.onChange(() => changes++);
    e.fire();
    hostCb();
    expect(changes).toBe(2);
    expect(s.pending()).toEqual([{ path: "b.md", op: "create", since: 3 }]);
    expect(s.deferred()).toEqual([{ path: "big.bin", size: 9, direction: "upload" }]);
    expect(s.device()).toEqual(device);
    expect(s.conflicts().map((c) => [c.id, c.path])).toEqual([
      ["c1", "notes/a.md"],
      ["c2", "c2"],
    ]);
    expect(await s.conflict("c1")).toBeNull();
    expect(await s.resolve("c1", { type: "keep_mine" })).toEqual({ ok: false, reason: "stale" });
    expect(await s.resolveAll("keep_both", ["c1"])).toEqual({ resolved: 0 });
    expect(notices).toEqual(["soon", "soon"]);
    await s.syncNow();
    await s.transferNow("big.bin");
    expect(e.syncs).toBe(2);
    await s.confirmDeletions();
    expect(e.syncs).toBe(12);
  });
});
