import { describe, expect, it } from "vitest";
import { initialState, step, type ClientEvent, type ClientState, type Effect } from "./client.js";
import { ALL_CONFIG, DEFAULT_SETTINGS } from "./exclusions.js";
import { MemoryStore } from "./store.js";

const H = (c: string) => c.repeat(64);
let n = 0;
const env = { newId: () => `id${++n}` };

/** A device with a disk (path → hash) driven to quiescence against a MemoryStore. */
class Device {
  s: ClientState;
  disk = new Map<string, string>();
  reported: string[] = [];
  constructor(
    readonly id: string,
    readonly store: MemoryStore,
  ) {
    this.s = initialState({
      deviceId: id,
      platform: "linux",
      configDir: ".obsidian",
      settings: { ...DEFAULT_SETTINGS, config: ALL_CONFIG },
      batchSize: 50,
    });
  }
  private run(e: ClientEvent): Effect[] {
    const r = step(this.s, e, env);
    this.s = r.state;
    return r.effects;
  }
  private effects(fx: Effect[]): void {
    const queue = [...fx];
    while (queue.length) {
      const f = queue.shift()!;
      switch (f.type) {
        case "push": {
          for (const h of f.hashes) this.store.blobs.add(h);
          const res = this.store.commit(f.ops, this.id);
          queue.push(...this.run({ type: "pushResult", requestId: f.requestId, ...res }));
          break;
        }
        case "pull":
          queue.push(
            ...this.run({
              type: "pullResult",
              requestId: f.requestId,
              ...this.store.changes(f.after),
            }),
          );
          break;
        case "snapshot":
          queue.push(
            ...this.run({
              type: "snapshotResult",
              requestId: f.requestId,
              snapshot: this.store.snapshot(),
            }),
          );
          break;
        case "write": {
          const ok = (this.disk.get(f.path) ?? null) === f.expect;
          if (ok) this.disk.set(f.path, f.hash);
          queue.push(...this.run({ type: "written", fileId: f.fileId, hash: f.hash, ok }));
          break;
        }
        case "trash": {
          const ok = this.disk.get(f.path) === f.expect;
          if (ok) this.disk.delete(f.path);
          queue.push(...this.run({ type: "trashed", fileId: f.fileId, ok }));
          break;
        }
        case "forced":
          this.reported.push(`${f.role}:${f.requestId}`);
          queue.push(...this.run({ type: "forcedReported", requestId: f.requestId }));
          break;
        default:
          break;
      }
    }
  }
  /** `forced` = what the server answers before the cycle (the engine asks it). */
  sync(rounds = 4, forced?: { requestId: string; role: "source" | "target" }): void {
    for (let i = 0; i < rounds; i++) {
      const scan = [...this.disk].map(([path, hash]) => ({
        path,
        hash,
        size: sizeOf(hash),
        mtime: 0,
      }));
      this.effects(this.run({ type: "sync", scan, folders: [], forced: forced ?? null }));
    }
  }
}

/** Each content has its own size: an op must send the size of what it sends. */
const sizeOf = (hash: string) => Number.parseInt(hash.slice(0, 4), 16);
const versionsOf = (store: MemoryStore, fileId: string) =>
  [...store.versions.values()].filter((v) => v.fileId === fileId).map((v) => v.hash);
const fileAt = (store: MemoryStore, path: string) =>
  [...store.files.values()].find((f) => f.path === path && !f.deleted)!;

describe("forced sync (ADR-0019)", () => {
  it("the source's files win on the server, open conflicts close", () => {
    const store = new MemoryStore();
    const src = new Device("src", store);
    const other = new Device("other", store);
    src.disk.set("a.md", H("1"));
    src.sync();
    other.sync();
    // Both edit a.md: the other device's edit is the head, the source's is a conflict.
    other.disk.set("a.md", H("2"));
    other.sync();
    src.disk.set("a.md", H("3"));
    src.sync();
    expect([...store.conflicts.values()].filter((c) => c.status === "open")).toHaveLength(1);
    // A file only the source has, at a path the server has with other content.
    other.disk.set("b.md", H("4"));
    other.sync();
    src.disk.set("c.md", H("5"));
    src.sync();
    store.event("force_push", "req1", "src");
    src.sync();
    expect(fileAt(store, "a.md").headHash).toBe(H("3"));
    expect(fileAt(store, "c.md").headHash).toBe(H("5"));
    expect([...store.conflicts.values()].filter((c) => c.status === "open")).toEqual([]);
    expect(versionsOf(store, fileAt(store, "a.md").fileId)).toContain(H("2"));
    expect(src.reported).toEqual(["source:req1"]);
    expect(src.s.durable.forced).toBeNull();
    expect(src.disk.get("a.md")).toBe(H("3"));
  });

  it("a target keeps its different contents in the history, takes the server's, keeps its extras", () => {
    const store = new MemoryStore();
    const src = new Device("src", store);
    const dst = new Device("dst", store);
    src.disk.set("a.md", H("1"));
    src.disk.set("b.md", H("2"));
    src.sync();
    dst.sync();
    // The target edits a.md on the current base (it would win normally), deletes b.md,
    // and has a file of its own.
    dst.disk.set("a.md", H("7"));
    dst.disk.delete("b.md");
    dst.disk.set("x.md", H("8"));
    store.event("realign", "req2", "dst");
    dst.sync(4, { requestId: "req2", role: "target" });
    const a = fileAt(store, "a.md");
    expect(a.headHash).toBe(H("1"));
    expect(versionsOf(store, a.fileId)).toContain(H("7"));
    const archived = [...store.versions.values()].find((v) => v.hash === H("7"))!;
    expect(archived.size).toBe(sizeOf(H("7")));
    expect(dst.disk.get("a.md")).toBe(H("1"));
    expect(dst.disk.get("b.md")).toBe(H("2"));
    expect(dst.disk.get("x.md")).toBe(H("8"));
    expect(fileAt(store, "x.md").headHash).toBe(H("8"));
    expect(fileAt(store, "b.md")).toBeDefined();
    expect(dst.reported).toEqual(["target:req2"]);
    expect(dst.s.durable.forced).toBeNull();
    // The server still lists it for a moment: not done twice.
    dst.sync(2, { requestId: "req2", role: "target" });
    expect(dst.reported).toEqual(["target:req2"]);
    // Back to normal sync afterwards.
    src.disk.set("a.md", H("9"));
    src.sync();
    dst.sync();
    expect(dst.disk.get("a.md")).toBe(H("9"));
  });

  it("other devices' requests are ignored", () => {
    const store = new MemoryStore();
    const d = new Device("d", store);
    d.disk.set("a.md", H("1"));
    d.sync();
    store.event("force_push", "r", "someone");
    store.event("realign", "r", "someone");
    d.sync();
    expect(d.s.durable.forced ?? null).toBeNull();
    expect(d.reported).toEqual([]);
  });
});

describe("forced sync: a target in a conflict", () => {
  it("its losing copy stays on the server and it takes the current version", () => {
    const store = new MemoryStore();
    const src = new Device("src", store);
    const dst = new Device("dst", store);
    src.disk.set("a.md", H("1"));
    src.sync();
    dst.sync();
    src.disk.set("a.md", H("2"));
    src.sync();
    dst.disk.set("a.md", H("3"));
    dst.sync(1);
    expect([...store.conflicts.values()].some((c) => c.status === "open")).toBe(true);
    store.event("force_push", "q", "src");
    src.sync();
    store.event("realign", "q", "dst");
    dst.sync(4, { requestId: "q", role: "target" });
    expect(dst.disk.get("a.md")).toBe(H("2"));
    expect(store.hasContent(H("3"))).toBe(true);
    expect([...store.conflicts.values()].some((c) => c.status === "open")).toBe(false);
    expect(Object.values(dst.s.durable.index).every((e) => e.conflictId === null)).toBe(true);
  });
});
