import { describe, expect, it, vi } from "vitest";
import { FakeSyncState } from "./fake.js";
import { conflictScenario } from "./scenarios.js";

const NOW = Date.UTC(2026, 10, 8, 10, 0);
const device = { name: "Laptop", mode: "live" as const, server: "sync.example" };

function loaded() {
  const s = new FakeSyncState(device, () => NOW);
  s.loadScenario(conflictScenario(NOW));
  return s;
}

describe("FakeSyncState", () => {
  it("starts empty and never synced", () => {
    const s = new FakeSyncState(device, () => NOW);
    expect(s.conflicts()).toEqual([]);
    expect(s.snapshot().lastConfirmedAt).toBeNull();
    expect(s.device()).toEqual(device);
  });

  it("loads the conflict scenario consistently", async () => {
    const s = loaded();
    const list = s.conflicts();
    expect(list).toHaveLength(3);
    expect(s.snapshot().conflicts).toBe(3);
    expect(list.some((c) => c.binary)).toBe(true);
    expect(await s.conflict(list[0]!.id)).not.toBeNull();
    expect(s.pending().length).toBeGreaterThan(0);
    expect(s.deferred().length).toBeGreaterThan(0);
  });

  it.each(["keep_mine", "keep_incoming", "keep_both"] as const)(
    "resolve %s closes the conflict and notifies",
    async (type) => {
      const s = loaded();
      const cb = vi.fn();
      s.onChange(cb);
      const id = s.conflicts()[0]!.id;
      expect(await s.resolve(id, { type })).toEqual({ ok: true });
      expect(s.conflicts().map((c) => c.id)).not.toContain(id);
      expect(s.snapshot().conflicts).toBe(2);
      expect(cb).toHaveBeenCalled();
    },
  );

  it("manual resolution closes the conflict", async () => {
    const s = loaded();
    const id = s.conflicts()[0]!.id;
    expect(await s.resolve(id, { type: "manual", text: "merged" })).toEqual({ ok: true });
    expect(await s.conflict(id)).toBeNull();
  });

  it("stale keeps the conflict open and changes the incoming version", async () => {
    const s = loaded();
    const id = s.conflicts().find((c) => !c.binary)!.id;
    const before = await s.conflict(id);
    s.nextResolveStale();
    expect(await s.resolve(id, { type: "keep_mine" })).toEqual({ ok: false, reason: "stale" });
    const after = await s.conflict(id);
    expect(after).not.toBeNull();
    expect(after!.binary).toBe(false);
    if (before && !before.binary && after && !after.binary) {
      expect(after.incomingText).not.toBe(before.incomingText);
    }
    expect(s.snapshot().conflicts).toBe(3);
  });

  it("resolving an unknown conflict reports gone", async () => {
    expect(await loaded().resolve("nope", { type: "keep_mine" })).toEqual({
      ok: false,
      reason: "gone",
    });
  });

  it("resolveAll resolves the given conflicts and returns the count", async () => {
    const s = loaded();
    expect(
      await s.resolveAll(
        "keep_both",
        s.conflicts().map((c) => c.id),
      ),
    ).toEqual({ resolved: 3 });
    expect(s.conflicts()).toEqual([]);
    expect(s.snapshot().conflicts).toBe(0);
  });

  it("syncNow empties the queue and confirms when the server is reachable", async () => {
    const s = loaded();
    await s.syncNow();
    expect(s.pending()).toEqual([]);
    expect(s.snapshot().queued).toBe(0);
    expect(s.snapshot().lastConfirmedAt).toBe(NOW);
  });

  it("resolveAll leaves conflicts it was not given", async () => {
    const s = loaded();
    expect(await s.resolveAll("keep_mine", ["c-shopping", "gone"])).toEqual({ resolved: 1 });
    expect(s.conflicts().map((c) => c.id)).toEqual(["c-plan", "c-photo"]);
    expect(s.snapshot().conflicts).toBe(2);
  });

  it("transferNow removes the deferred file", async () => {
    const s = loaded();
    const path = s.deferred()[0]!.path;
    await s.transferNow(path);
    expect(s.deferred().map((d) => d.path)).not.toContain(path);
  });

  it("setDevice updates the device info and notifies", () => {
    const s = new FakeSyncState(device, () => NOW);
    const cb = vi.fn();
    s.onChange(cb);
    s.setDevice({ name: "Studio", mode: "live", server: "other.example" });
    expect(s.device().name).toBe("Studio");
    expect(cb).toHaveBeenCalled();
  });

  it("onChange unsubscribe stops notifications", async () => {
    const s = loaded();
    const cb = vi.fn();
    const off = s.onChange(cb);
    off();
    await s.resolveAll("keep_mine", ["c-shopping"]);
    expect(cb).not.toHaveBeenCalled();
  });
});
