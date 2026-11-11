import { DEFAULT_SYNC_SETTINGS } from "@kamino/protocol";
import type { ClientConfig } from "@kamino/sync-core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Engine, type EngineDeps } from "./engine.js";
import { MemoryFs } from "./memory-fs.js";
import type { Clock, FsEntry, Http, VaultFs, WriteOutcome } from "./ports.js";
import { FakeServer } from "./testing/fake-server.js";

const DEV = "dev-a";
const config = (): ClientConfig => ({
  deviceId: DEV,
  platform: "linux",
  configDir: ".obsidian",
  settings: DEFAULT_SYNC_SETTINGS,
  batchSize: 7,
});

/** Time stands still unless a test moves it; sleeps never end (no periodic cycle in tests). */
const clock = (): Clock & { t: number } => ({
  t: 1_000_000,
  now() {
    return this.t;
  },
  sleep: () => new Promise<void>(() => {}),
  random: () => 0.5,
});

let ids = 0;
const deps = (server: FakeServer, fs: VaultFs, http?: Http): EngineDeps => ({
  fs,
  http: http ?? server.http(DEV),
  clock: clock(),
  newId: () => `id-${++ids}`,
  config: config(),
  vaultId: "v",
  token: () => DEV,
});

/** Local files outside the configuration folder: path → text. */
const localFiles = (fs: MemoryFs): Map<string, string> =>
  new Map(
    [...fs.files.keys()].filter((p) => !p.startsWith(".obsidian/")).map((p) => [p, fs.text(p)!]),
  );

describe("engine", () => {
  it("sends a new local file to the server", async () => {
    const server = new FakeServer();
    const fs = new MemoryFs();
    fs.put("notes/a.md", "hello world");
    const e = await Engine.open(deps(server, fs));
    await e.syncNow();
    expect(server.files()).toEqual(new Map([["notes/a.md", "hello world"]]));
    const s = e.snapshot();
    expect(s.queued).toBe(0);
    expect(s.lastConfirmedAt).not.toBeNull();
    expect(s.unreachableSince).toBeNull();
    expect(server.statuses.at(-1)).toMatchObject({ pendingOps: 0, deferredFiles: 0 });
  });

  it("writes a remote file", async () => {
    const server = new FakeServer();
    await server.remotePut(
      "dev-b",
      { opId: "o1", fileId: "f1", versionId: "v1", path: "b.md", baseVersionId: null, mtime: 5 },
      "from b",
    );
    const fs = new MemoryFs();
    const e = await Engine.open(deps(server, fs));
    await e.syncNow();
    expect(fs.text("b.md")).toBe("from b");
    // The next cycle sees the written file as in sync: nothing to send.
    const before = server.store.head;
    await e.syncNow();
    expect(server.store.head).toBe(before);
  });

  it("follows remote edits and deletions", async () => {
    const server = new FakeServer();
    const r = await server.remotePut(
      "dev-b",
      { opId: "o1", fileId: "f1", versionId: "v1", path: "b.md", baseVersionId: null, mtime: 5 },
      "one",
    );
    expect(r.results[0]!.status).toBe("accepted");
    const fs = new MemoryFs();
    const e = await Engine.open(deps(server, fs));
    await e.syncNow();
    await server.remotePut(
      "dev-b",
      { opId: "o2", fileId: "f1", versionId: "v2", path: "b.md", baseVersionId: "v1", mtime: 6 },
      "two",
    );
    await e.syncNow();
    await e.syncNow(); // the write lands; the scan adopts it
    expect(fs.text("b.md")).toBe("two");
    server.store.commit(
      [{ type: "delete", opId: "o3", fileId: "f1", baseVersionId: "v2" }],
      "dev-b",
    );
    await e.syncNow();
    await e.syncNow();
    expect(fs.files.has("b.md")).toBe(false);
    expect(fs.trashed).toEqual(["b.md"]);
  });

  it("shows the server as unreachable, then recovers", async () => {
    const server = new FakeServer();
    const fs = new MemoryFs();
    const d = deps(server, fs);
    const e = await Engine.open(d);
    await e.syncNow();
    server.down = true;
    fs.put("a.md", "x");
    await e.syncNow();
    const s = e.snapshot();
    expect(s.unreachableSince).toBe(d.clock.now());
    expect(s.queued).toBeGreaterThan(0);
    expect(s.oldestQueuedAt).not.toBeNull();
    server.down = false;
    await e.syncNow();
    expect(e.snapshot().unreachableSince).toBeNull();
    expect(e.snapshot().queued).toBe(0);
    expect(server.files().get("a.md")).toBe("x");
  });

  it("stops when the device is revoked", async () => {
    const server = new FakeServer();
    const fs = new MemoryFs();
    const e = await Engine.open(deps(server, fs));
    let changes = 0;
    e.onChange(() => changes++);
    server.revoked = true;
    await e.syncNow();
    expect(e.stopped).toBe("revoked");
    expect(e.snapshot().blocked).toBe("revoked");
    expect(changes).toBeGreaterThan(0);
    const n = server.requests;
    await e.syncNow();
    expect(server.requests).toBe(n);
  });

  it("lists pending changes without paths of the configuration folder", async () => {
    const server = new FakeServer();
    server.down = true;
    const fs = new MemoryFs();
    fs.put("a.md", "x");
    const e = await Engine.open(deps(server, fs));
    await e.syncNow();
    // Not joined yet: the first cycle needs the snapshot, so nothing is known about a.md.
    server.down = false;
    await e.syncNow();
    server.down = true;
    fs.put("c.md", "y");
    await e.syncNow();
    expect(e.pending()).toEqual([{ path: "c.md", op: "create", since: expect.any(Number) }]);
  });

  it("syncs folders both ways, empty ones included", async () => {
    const server = new FakeServer();
    const fs = new MemoryFs();
    await fs.mkdir("empty/inner");
    const e = await Engine.open(deps(server, fs));
    await e.syncNow();
    const live = () =>
      [...server.store.files.values()]
        .filter((f) => f.kind === "folder" && !f.deleted)
        .map((f) => f.path)
        .sort();
    expect(live()).toEqual(["empty", "empty/inner"]);
    server.store.commit([{ type: "mkdir", opId: "o9", fileId: "F9", path: "remote" }], "dev-b");
    await e.syncNow();
    expect(fs.folders.has("remote")).toBe(true);
    await e.syncNow();
    expect(live()).toEqual(["empty", "empty/inner", "remote"]);
  });

  it("reports the transfer backlog and can pause", async () => {
    const server = new FakeServer();
    await server.remotePut(
      "dev-b",
      { opId: "o1", fileId: "f1", versionId: "v1", path: "r.md", baseVersionId: null, mtime: 5 },
      "remote!",
    );
    server.down = true;
    const fs = new MemoryFs();
    fs.put("a.md", "12345");
    const e = await Engine.open(deps(server, fs));
    server.down = false;
    e.pause();
    await e.syncNow();
    expect(server.requests).toBe(0); // paused: nothing happens
    expect(e.paused).toBe(true);
    e.resume();
    await e.syncNow();
    expect(e.backlog()).toEqual({ up: { files: 0, bytes: 0 }, down: { files: 0, bytes: 0 } });
    expect(fs.text("r.md")).toBe("remote!");
    // Before syncing, local changes count as upload backlog.
    server.down = true;
    fs.put("b.md", "123");
    await e.syncNow();
    expect(e.backlog().up).toEqual({ files: 1, bytes: 3 });
  });

  it("tells its host when the vault settings change", async () => {
    const server = new FakeServer();
    const fs = new MemoryFs();
    let told = 0;
    const e = await Engine.open({ ...deps(server, fs), onSettingsChanged: () => told++ });
    await e.syncNow();
    expect(told).toBe(0);
    server.store.journal.push({
      seq: ++server.store.head,
      type: "vault_settings_changed",
      fileId: "_vault",
      path: "_vault",
      deviceId: "dev-b",
      at: new Date(0).toISOString(),
      ignorable: true,
    });
    await e.syncNow();
    expect(told).toBe(1);
  });

  it("catches up from the snapshot when its cursor is too old (03 §6.3)", async () => {
    const server = new FakeServer();
    const fs = new MemoryFs();
    fs.put("mine.md", "kept");
    const e = await Engine.open(deps(server, fs));
    await e.syncNow();
    await server.remotePut(
      "dev-b",
      {
        opId: "o1",
        fileId: "f1",
        versionId: "v1",
        path: "while-away.md",
        baseVersionId: null,
        mtime: 5,
      },
      "news",
    );
    server.floor = server.store.head; // compacted past this device
    await e.syncNow();
    await e.syncNow();
    expect(fs.text("while-away.md")).toBe("news");
    expect(fs.text("mine.md")).toBe("kept");
    expect(server.files()).toEqual(
      new Map([
        ["mine.md", "kept"],
        ["while-away.md", "news"],
      ]),
    );
    expect(e.snapshot().unreachableSince).toBeNull();
  });

  it("a file that can't be read is never deleted on the server, and is shown (review C1)", async () => {
    const server = new FakeServer();
    const fs = new MemoryFs();
    fs.put("locked.md", "v1");
    const e = await Engine.open(deps(server, fs));
    await e.syncNow();
    fs.put("locked.md", "v2"); // changed, and now locked
    const read = fs.read.bind(fs);
    fs.read = (p: string) => {
      if (p === "locked.md") throw new Error("EBUSY");
      return read(p);
    };
    await e.syncNow();
    expect(server.files().get("locked.md")).toBe("v1");
    expect(e.deferred()).toEqual([
      expect.objectContaining({ path: "locked.md", direction: "upload" }),
    ]);
    fs.read = read;
    await e.syncNow();
    expect(server.files().get("locked.md")).toBe("v2");
    expect(e.deferred()).toEqual([]);
  });

  it("holds a mass deletion until the user confirms it (review I1)", async () => {
    const server = new FakeServer();
    const fs = new MemoryFs();
    for (let i = 0; i < 60; i++) fs.put(`n${i}.md`, `x${i}`);
    const e = await Engine.open(deps(server, fs));
    await e.syncNow();
    expect(server.files().size).toBe(60);
    // The listing comes back empty (unmounted disk, revoked permission…).
    for (let i = 0; i < 60; i++) fs.remove(`n${i}.md`);
    await e.syncNow();
    expect(server.files().size).toBe(60);
    expect(e.snapshot().blocked).toBe("deletions");
    await e.syncNow(); // still held, cycle after cycle
    expect(server.files().size).toBe(60);
    await e.confirmDeletions();
    expect(server.files().size).toBe(0);
    expect(e.snapshot().blocked).toBeNull();
  });

  it("a few deletions go through without asking", async () => {
    const server = new FakeServer();
    const fs = new MemoryFs();
    for (let i = 0; i < 10; i++) fs.put(`n${i}.md`, `x${i}`);
    const e = await Engine.open(deps(server, fs));
    await e.syncNow();
    fs.remove("n0.md");
    fs.remove("n1.md");
    await e.syncNow();
    expect(server.files().size).toBe(8);
    expect(e.snapshot().blocked).toBeNull();
  });

  it("a rename during the scan is a move, not a delete and a new file (review I2)", async () => {
    const server = new FakeServer();
    const fs = new MemoryFs();
    fs.put("a.md", "content");
    const e = await Engine.open(deps(server, fs));
    await e.syncNow();
    const id = [...server.store.files.values()][0]!.fileId;
    // The user renames a.md while the next scan is listing the vault.
    const list = fs.list.bind(fs);
    let once = true;
    fs.list = async () => {
      const out = await list();
      if (once) {
        once = false;
        await fs.rename("a.md", "b.md");
        e.localRename("a.md", "b.md");
      }
      return out;
    };
    await e.syncNow();
    await e.syncNow();
    const files = [...server.store.files.values()];
    expect(files.map((f) => [f.fileId, f.path, f.deleted])).toEqual([[id, "b.md", false]]);
  });

  it("a failed state save doesn't leave the engine stuck (review I3)", async () => {
    const server = new FakeServer();
    const fs = new MemoryFs();
    fs.put("a.md", "x");
    const e = await Engine.open(deps(server, fs));
    await e.syncNow();
    const save = fs.saveState.bind(fs);
    let failures = 0;
    fs.saveState = async (name, data) => {
      // Disk full exactly when the push result is being recorded.
      if (name === "durable" && failures === 0 && data.includes("b.md") && !data.includes('"sent":[{')) {
        failures++;
        throw new Error("ENOSPC");
      }
      return save(name, data);
    };
    fs.put("b.md", "y");
    await e.syncNow();
    expect(failures).toBe(1);
    await e.syncNow();
    expect(server.files().get("b.md")).toBe("y");
    expect(e.snapshot().queued).toBe(0);
  });

  it("resumes from the saved state after a restart", async () => {
    const server = new FakeServer();
    const fs = new MemoryFs();
    fs.put("a.md", "x");
    const e = await Engine.open(deps(server, fs));
    await e.syncNow();
    await e.stop();
    const again = await Engine.open(deps(server, fs));
    const before = server.store.head;
    await again.syncNow();
    expect(server.store.head).toBe(before); // nothing sent twice
    expect(again.snapshot().queued).toBe(0);
  });
});

/** A crash: from the chosen call on, nothing the old engine does reaches the disk or the server. */
class Crash {
  calls = 0;
  dead = false;
  private resolveDead!: () => void;
  readonly died = new Promise<void>((r) => (this.resolveDead = r));
  constructor(
    private readonly at: number,
    /** The fatal call itself happens (response lost) rather than not. */
    private readonly lands: boolean,
  ) {}
  async gate<T>(f: () => Promise<T>): Promise<T> {
    if (this.dead) return new Promise<T>(() => {});
    if (++this.calls < this.at) return f();
    this.dead = true;
    this.resolveDead();
    if (this.lands) await f();
    return new Promise<T>(() => {});
  }
  fs(inner: MemoryFs): VaultFs {
    return {
      streaming: true,
      list: () => (this.dead ? new Promise<FsEntry[]>(() => {}) : inner.list()),
      stat: (p) => inner.stat(p),
      read: (p) => inner.read(p),
      write: (p, parts, expect, want) =>
        this.gate<WriteOutcome>(() => inner.write(p, parts, expect, want)),
      rename: (a, b) => this.gate(() => inner.rename(a, b)),
      trash: (p) => this.gate(() => inner.trash(p)),
      mkdir: (p) => this.gate(() => inner.mkdir(p)),
      rmdirIfEmpty: (p) => this.gate(() => inner.rmdirIfEmpty(p)),
      loadState: (n) => inner.loadState(n),
      saveState: (n, d) => this.gate(() => inner.saveState(n, d)),
    };
  }
  http(inner: Http): Http {
    return { request: (r) => this.gate(() => inner.request(r)) };
  }
}

type Cmd =
  | { t: "localPut"; n: number; text: string }
  | { t: "localDelete"; n: number }
  | { t: "remotePut"; n: number; text: string }
  | { t: "remoteDelete"; n: number }
  | { t: "sync" }
  | { t: "crash"; at: number; lands: boolean };

const cmd: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({
    t: fc.constant("localPut" as const),
    n: fc.nat(5),
    text: fc.string({ maxLength: 12 }),
  }),
  fc.record({ t: fc.constant("localDelete" as const), n: fc.nat(5) }),
  fc.record({
    t: fc.constant("remotePut" as const),
    n: fc.nat(5),
    text: fc.string({ maxLength: 12 }),
  }),
  fc.record({ t: fc.constant("remoteDelete" as const), n: fc.nat(5) }),
  fc.constant({ t: "sync" as const }),
  fc.record({
    t: fc.constant("crash" as const),
    at: fc.integer({ min: 1, max: 30 }),
    lands: fc.boolean(),
  }),
);

describe("engine properties", () => {
  it("after crashes and restarts the vault and the server converge, nothing created is lost", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(cmd, { maxLength: 25 }), async (cmds) => {
        const server = new FakeServer();
        server.chunkSize = 5;
        const fs = new MemoryFs();
        let engine = await Engine.open(deps(server, fs));
        const created = new Set<string>(); // every text ever written by the user, locally or remotely
        const seen = new Set<string>(); // local texts on disk right after a completed sync
        const remote = new Map<number, { fileId: string; versionId: string }>();
        let n = 0;
        for (const c of cmds) {
          switch (c.t) {
            case "localPut":
              // Local and remote names never meet: no conflicts in this property.
              fs.put(`l${c.n}.md`, c.text);
              created.add(`l${c.n}.md:${c.text}`);
              break;
            case "localDelete":
              fs.remove(`l${c.n}.md`);
              break;
            case "remotePut": {
              const prev = remote.get(c.n);
              const live = prev && server.store.files.get(prev.fileId)?.deleted === false;
              const fileId = live ? prev.fileId : `rf-${++n}`;
              const versionId = `rv-${++n}`;
              await server.remotePut(
                "dev-b",
                {
                  opId: `ro-${++n}`,
                  fileId,
                  versionId,
                  path: `r${c.n}.md`,
                  baseVersionId: live ? prev.versionId : null,
                  mtime: 1,
                },
                c.text,
              );
              if (server.store.files.get(fileId)?.headVersionId === versionId) {
                remote.set(c.n, { fileId, versionId });
                created.add(`r${c.n}.md:${c.text}`);
              }
              break;
            }
            case "remoteDelete": {
              const prev = remote.get(c.n);
              if (!prev) break;
              server.store.commit(
                [
                  {
                    type: "delete",
                    opId: `ro-${++n}`,
                    fileId: prev.fileId,
                    baseVersionId: prev.versionId,
                  },
                ],
                "dev-b",
              );
              remote.delete(c.n);
              break;
            }
            case "sync":
              await engine.syncNow();
              for (const text of localFiles(fs).values()) seen.add(text);
              break;
            case "crash": {
              const crash = new Crash(c.at, c.lands);
              const doomed = await Engine.open(
                deps(server, crash.fs(fs), crash.http(server.http(DEV))),
              );
              await Promise.race([doomed.syncNow(), crash.died]);
              engine = await Engine.open(deps(server, fs));
              break;
            }
          }
        }
        for (let i = 0; i < 4; i++) await engine.syncNow();

        expect(localFiles(fs)).toEqual(server.files());
        // Nothing invented: every live file holds a text some user wrote at that path.
        for (const [path, text] of server.files())
          expect(created.has(`${path}:${text}`)).toBe(true);
        // Nothing lost: what was on disk at a completed sync is on the server, current or old.
        const stored = new Set(
          [...server.content.values()].map((d) => new TextDecoder().decode(d)),
        );
        for (const text of seen)
          expect(stored.has(text), `"${text}" reached the server`).toBe(true);
      }),
      { numRuns: 60 },
    );
  });
});
