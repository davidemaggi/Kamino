import type { Backlog, DeferredFile, StopReason } from "@kamino/sync-engine";
import { describe, expect, it } from "vitest";
import { RealTransfer, type TransferEngine } from "./real-transfer.js";

class StubEngine implements TransferEngine {
  b: Backlog = { up: { files: 0, bytes: 0 }, down: { files: 0, bytes: 0 } };
  paused = false;
  stopped: StopReason | null = null;
  unreachableSince: number | null = null;
  syncing = false;
  syncs = 0;
  waiting: DeferredFile[] = [];
  deferred() {
    return this.waiting;
  }
  private cbs = new Set<() => void>();
  release: () => void = () => {};
  backlog() {
    return structuredClone(this.b);
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  syncNow() {
    this.syncs++;
    return new Promise<void>((r) => (this.release = r));
  }
  snapshot() {
    return { unreachableSince: this.unreachableSince, syncing: this.syncing };
  }
  onChange(cb: () => void) {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  fire() {
    for (const cb of this.cbs) cb();
  }
}

describe("RealTransfer", () => {
  it("shows the first cycle's files and bytes as they go", async () => {
    const e = new StubEngine();
    const t = new RealTransfer(() => e);
    expect(t.progress()).toBeNull();
    let changes = 0;
    t.onChange(() => changes++);
    t.start("download");
    expect(e.syncs).toBe(1);
    e.b.down = { files: 4, bytes: 400 };
    e.fire();
    expect(t.progress()).toEqual({
      direction: "download",
      phase: "running",
      files: { done: 0, total: 4 },
      bytes: { done: 0, total: 400 },
    });
    e.b.down = { files: 1, bytes: 100 };
    expect(t.progress()?.files).toEqual({ done: 3, total: 4 });
    e.b.down = { files: 0, bytes: 0 };
    e.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.progress()?.phase).toBe("done");
    expect(changes).toBeGreaterThan(0);
  });

  it("pauses, resumes, shows interruptions and failures", () => {
    const e = new StubEngine();
    const t = new RealTransfer(() => e);
    t.start("upload");
    e.b.up = { files: 2, bytes: 20 };
    t.pause();
    expect(e.paused).toBe(true);
    expect(t.progress()?.phase).toBe("paused");
    t.resume();
    expect(e.paused).toBe(false);
    e.unreachableSince = 5;
    expect(t.progress()?.phase).toBe("interrupted");
    t.retry();
    expect(e.syncs).toBe(2);
    e.stopped = "revoked";
    expect(t.progress()?.phase).toBe("failed");
  });
  it("is done when only waiting files are left, and says how many (M9)", async () => {
    const e = new StubEngine();
    e.waiting = [{ path: "v.mp4", size: 9, direction: "download", reason: "network" }];
    const t = new RealTransfer(() => e);
    t.start("download");
    e.b.down = { files: 3, bytes: 30 };
    t.progress();
    e.b.down = { files: 1, bytes: 9 };
    e.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.progress()).toMatchObject({ phase: "done", waiting: 1 });
  });
});