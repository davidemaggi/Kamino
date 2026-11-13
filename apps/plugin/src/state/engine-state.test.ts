import type { SyncSnapshot } from "@kamino/status";
import { describe, expect, it } from "vitest";
import type { ConflictDetail, ResolveRequest, ResolveResult } from "@kamino/sync-engine";
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

const enc = (t: string) => new TextEncoder().encode(t);
const detail = (id: string, content: boolean): ConflictDetail => ({
  id,
  fileId: "f1",
  path: "notes/a.md",
  kind: "concurrent_edit",
  head: "v9",
  mine: { at: 5, author: null, size: 4, bytes: content ? enc("mine") : null },
  incoming: {
    at: 7,
    author: { kind: "device", name: "Phone" },
    size: 6,
    bytes: content ? enc("theirs") : null,
  },
});

function stub(): StateEngine & {
  syncs: number;
  fire(): void;
  resolved: ResolveRequest[][];
  answer: ResolveResult;
} {
  const cbs = new Set<() => void>();
  return {
    syncs: 0,
    resolved: [],
    answer: "ok",
    snapshot: () => snap,
    conflicts: () => [
      { id: "c1", fileId: "f1", path: "notes/a.md", here: true },
      { id: "c2", fileId: "f2", path: null, here: false },
    ],
    conflictDetail: (id, content) => Promise.resolve(id === "c1" ? detail(id, content) : null),
    resolve(reqs) {
      this.resolved.push([...reqs]);
      return Promise.resolve(reqs.map(() => this.answer));
    },
    pending: () => [{ path: "b.md", op: "create", since: 3 }],
    deferred: () => [{ path: "big.bin", size: 9, direction: "upload" }],
    async syncNow() {
      this.syncs++;
    },
    async confirmDeletions() {
      this.syncs += 10;
    },
    async transferNow(path: string) {
      this.syncs += 100;
      void path;
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

const labels = {
  copy: "conflict",
  webApp: "web app",
  otherDevice: "another device",
  failed: "failed",
};
const flush = () => new Promise((r) => setTimeout(r, 0));

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
      labels,
    });
    expect(s.snapshot()).toMatchObject({ linked: false, queued: 0 });
    expect(s.pending()).toEqual([]);
    await s.syncNow();
    engine = stub();
    expect(s.snapshot()).toBe(snap);
  });

  it("forwards the engine's state", async () => {
    const e = stub();
    let hostCb: () => void = () => {};
    const s = new EngineState({
      engine: () => e,
      onHostChange: (cb) => {
        hostCb = cb;
        return () => {};
      },
      device: () => device,
      notice: () => {},
      labels,
    });
    let changes = 0;
    s.onChange(() => changes++);
    e.fire();
    hostCb();
    expect(changes).toBe(2);
    expect(s.pending()).toEqual([{ path: "b.md", op: "create", since: 3 }]);
    expect(s.deferred()).toEqual([{ path: "big.bin", size: 9, direction: "upload" }]);
    expect(s.device()).toEqual(device);
    await s.syncNow();
    await s.transferNow("big.bin"); // review I4: reaches the engine, not a plain sync
    expect(e.syncs).toBe(101);
    await s.confirmDeletions();
    expect(e.syncs).toBe(111);
  });

  it("lists conflicts, then who and when once known; the other side's are not resolvable here", async () => {
    const e = stub();
    const s = new EngineState({
      engine: () => e,
      onHostChange: () => () => {},
      device: () => device,
      notice: () => {},
      labels,
    });
    let changes = 0;
    s.onChange(() => changes++);
    const first = s.conflicts();
    expect(first.map((c) => [c.id, c.path, c.elsewhere ?? false])).toEqual([
      ["c1", "notes/a.md", false],
      ["c2", "c2", true],
    ]);
    expect(first[0]!.incoming).toEqual({ device: "another device", at: null });
    await flush();
    expect(changes).toBe(1);
    expect(s.conflicts()[0]).toMatchObject({
      mine: { device: "Laptop", at: 5 },
      incoming: { device: "Phone", at: 7 },
    });
    expect(await s.conflict("c2")).toBeNull();
  });

  it("shows the texts and resolves against the version shown", async () => {
    const e = stub();
    const s = new EngineState({
      engine: () => e,
      onHostChange: () => () => {},
      device: () => device,
      notice: () => {},
      labels,
    });
    expect(await s.conflict("c1")).toMatchObject({
      binary: false,
      mineText: "mine",
      incomingText: "theirs",
      incoming: { device: "Phone", at: 7 },
    });
    expect(await s.resolve("c1", { type: "keep_both" })).toEqual({ ok: true });
    expect(e.resolved.at(-1)).toEqual([
      { id: "c1", head: "v9", choice: "both", copy: { label: "conflict", device: "Laptop" } },
    ]);
    // A new look is needed before the next choice: the head shown is forgotten.
    expect(await s.resolve("c1", { type: "keep_mine" })).toEqual({ ok: false, reason: "stale" });
    await s.conflict("c1");
    expect(await s.resolve("c1", { type: "manual", text: "merged" })).toEqual({ ok: true });
    const manual = e.resolved.at(-1)![0]!;
    expect(manual.choice).toBe("mine");
    expect(new TextDecoder().decode(manual.text)).toBe("merged");
    expect(await s.resolve("zz", { type: "keep_mine" })).toEqual({ ok: false, reason: "gone" });
    await s.conflict("c1");
    e.answer = "stale";
    expect(await s.resolve("c1", { type: "keep_incoming" })).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("resolves in bulk only the conflicts seen, against the versions shown", async () => {
    const e = stub();
    const s = new EngineState({
      engine: () => e,
      onHostChange: () => () => {},
      device: () => device,
      notice: () => {},
      labels,
    });
    s.conflicts();
    await flush();
    expect(await s.resolveAll("keep_incoming", ["c1", "c2"])).toEqual({ resolved: 1 });
    expect(e.resolved).toEqual([[{ id: "c1", head: "v9", choice: "incoming" }]]);
  });
});
