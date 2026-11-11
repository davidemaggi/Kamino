import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../__mocks__/obsidian.js";
import { Watcher, type WatchTarget } from "./watcher.js";

function target(): WatchTarget & { changes: number; renames: string[][]; syncs: number } {
  return {
    changes: 0,
    renames: [],
    syncs: 0,
    localChange() {
      this.changes++;
    },
    localRename(from, to) {
      this.renames.push([from, to]);
    },
    async syncNow() {
      this.syncs++;
    },
  };
}

let app: App;
beforeEach(() => {
  vi.useFakeTimers();
  app = new App();
});
afterEach(() => vi.useRealTimers());

const start = (t: WatchTarget) => {
  const w = new Watcher(app as never, () => t);
  const refs: unknown[] = [];
  const stop = w.attach((r) => refs.push(r));
  return { w, refs, stop };
};

describe("Watcher", () => {
  it("debounces vault events: 1.5 s for other files, 5 s for the open one", () => {
    const t = target();
    start(t);
    app.vault.trigger("modify", { path: "a.md" });
    app.vault.trigger("create", { path: "b.md" });
    vi.advanceTimersByTime(1400);
    expect(t.changes).toBe(0);
    vi.advanceTimersByTime(200);
    expect(t.changes).toBe(1);
    app.workspace.activeFile = { path: "open.md" };
    app.vault.trigger("modify", { path: "open.md" });
    vi.advanceTimersByTime(4900);
    expect(t.changes).toBe(1);
    vi.advanceTimersByTime(200);
    expect(t.changes).toBe(2);
  });

  it("reports renames right away and schedules a cycle", () => {
    const t = target();
    start(t);
    app.vault.trigger("rename", { path: "new.md" }, "old.md");
    expect(t.renames).toEqual([["old.md", "new.md"]]);
    vi.advanceTimersByTime(1600);
    expect(t.changes).toBe(1);
  });

  it("syncs when the app comes back to the foreground, and stops cleanly", () => {
    const t = target();
    const { stop } = start(t);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(t.syncs).toBe(1);
    app.vault.trigger("modify", { path: "a.md" });
    stop();
    vi.advanceTimersByTime(10_000);
    expect(t.changes).toBe(0);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(t.syncs).toBe(1);
  });
  it("ignores events caused by the engine itself (F4), not the user's", async () => {
    const t = target();
    const echoes = new Set(["engine.md"]);
    t.isEcho = (path) => echoes.has(path);
    start(t);
    app.vault.trigger("modify", { path: "engine.md" });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    vi.advanceTimersByTime(2_000);
    expect(t.changes).toBe(0);
    app.vault.trigger("modify", { path: "user.md" });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    vi.advanceTimersByTime(2_000);
    expect(t.changes).toBe(1);
  });

  it("uses the configured debounce for the open file", async () => {
    const t = target();
    new Watcher(
      app as never,
      () => t,
      () => 12_000,
    ).attach(() => {});
    app.workspace.activeFile = { path: "open.md" };
    app.vault.trigger("modify", { path: "open.md" });
    await Promise.resolve();
    vi.advanceTimersByTime(11_000);
    expect(t.changes).toBe(0);
    vi.advanceTimersByTime(1_500);
    expect(t.changes).toBe(1);
  });
});
