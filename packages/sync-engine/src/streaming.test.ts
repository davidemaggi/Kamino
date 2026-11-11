import { DEFAULT_SYNC_SETTINGS } from "@kamino/protocol";
import { describe, expect, it } from "vitest";
import { Engine, type EngineDeps } from "./engine.js";
import { sha256Hex } from "./hash.js";
import { MemoryFs } from "./memory-fs.js";
import type { Http, VaultFs } from "./ports.js";
import { FakeServer } from "./testing/fake-server.js";

const MiB = 1024 * 1024;
let ids = 0;
const deps = (fs: VaultFs, http: Http, limits?: EngineDeps["limits"]): EngineDeps => ({
  fs,
  http,
  clock: { now: () => 1, sleep: () => new Promise<void>(() => {}), random: () => 0.5 },
  newId: () => `s-${++ids}`,
  config: {
    deviceId: "dev-a",
    platform: "linux",
    configDir: ".obsidian",
    settings: DEFAULT_SYNC_SETTINGS,
    batchSize: 10,
  },
  vaultId: "v",
  token: () => "dev-a",
  ...(limits ? { limits } : {}),
});

/** Bytes the engine pulled from the disk and pushed to the server, in order. */
class Timeline {
  read = 0;
  sent = 0;
  written = 0;
  fetched = 0;
  /** Largest gap between what was read and what was sent: what the engine holds. */
  maxHeldUp = 0;
  maxHeldDown = 0;
  maxBody = 0;
}

function instrumented(inner: MemoryFs, t: Timeline, streaming = true): VaultFs {
  return {
    streaming,
    list: () => inner.list(),
    stat: (p) => inner.stat(p),
    read: (p) =>
      (async function* () {
        for await (const piece of inner.read(p)) {
          t.read += piece.length;
          yield piece;
        }
      })(),
    write: (p, parts, expect, want) =>
      inner.write(
        p,
        (async function* () {
          for await (const piece of parts) {
            t.written += piece.length;
            yield piece;
          }
        })(),
        expect,
        want,
      ),
    rename: (a, b) => inner.rename(a, b),
    trash: (p) => inner.trash(p),
    mkdir: (p) => inner.mkdir(p),
    rmdirIfEmpty: (p) => inner.rmdirIfEmpty(p),
    loadState: (n) => inner.loadState(n),
    saveState: (n, d) => inner.saveState(n, d),
  };
}

function watchedHttp(server: FakeServer, t: Timeline): Http {
  const inner = server.http("dev-a");
  return {
    request: async (r) => {
      if (r.body) {
        t.sent += r.body.length;
        t.maxBody = Math.max(t.maxBody, r.body.length);
      }
      // A chunk only leaves once read: what's read and not yet sent is held in memory.
      t.maxHeldUp = Math.max(t.maxHeldUp, t.read - t.sent);
      t.maxHeldDown = Math.max(t.maxHeldDown, t.fetched - t.written);
      const res = await inner.request(r);
      if (res.body) t.fetched += res.body.length;
      return res;
    },
  };
}

const big = (n: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31) % 251;
  return b;
};

describe("large files (E3)", () => {
  it("uploads 20 MB holding less than three chunks at a time", async () => {
    const server = new FakeServer();
    server.chunkSize = 4 * MiB;
    const disk = new MemoryFs();
    disk.pieceSize = MiB;
    disk.put("big.bin", big(20 * MiB));
    const t = new Timeline();
    const e = await Engine.open(deps(instrumented(disk, t), watchedHttp(server, t)));
    await e.syncNow();
    expect(server.store.snapshot().files.map((f) => f.path)).toEqual(["big.bin"]);
    expect(t.maxBody).toBeLessThanOrEqual(4 * MiB);
    // The scan reads the file once to hash it; the upload reads it again chunk by chunk.
    expect(t.maxHeldUp - 20 * MiB).toBeLessThan(3 * 4 * MiB);
  }, 30_000);

  it("downloads 20 MB writing each piece as it arrives", async () => {
    const server = new FakeServer();
    const data = big(20 * MiB);
    const hash = await sha256Hex(
      (async function* () {
        yield data;
      })(),
    );
    server.content.set(hash, data);
    server.store.blobs.add(hash);
    server.store.commit(
      [
        {
          type: "put",
          opId: "o1",
          fileId: "f1",
          versionId: "v1",
          path: "big.bin",
          baseVersionId: null,
          contentHash: hash,
          size: data.length,
          mtime: 1,
        },
      ],
      "dev-b",
    );
    const disk = new MemoryFs();
    const t = new Timeline();
    const e = await Engine.open(deps(instrumented(disk, t), watchedHttp(server, t)));
    await e.syncNow();
    expect(disk.files.get("big.bin")?.data.length).toBe(20 * MiB);
    expect(t.maxHeldDown).toBeLessThanOrEqual(4 * MiB);
  }, 30_000);

  it("without streaming, a file over the limit waits as deferred and is never lost", async () => {
    const server = new FakeServer();
    const disk = new MemoryFs();
    disk.put("small.md", "ok");
    disk.put("big.bin", big(64));
    const t = new Timeline();
    const e = await Engine.open(
      deps(instrumented(disk, t, false), watchedHttp(server, t), { maxInMemoryBytes: 32 }),
    );
    await e.syncNow();
    expect(server.store.snapshot().files.map((f) => f.path)).toEqual(["small.md"]);
    expect(e.deferred()).toEqual([
      { path: "big.bin", size: 64, direction: "upload", reason: "size" },
    ]);
    expect(disk.files.has("big.bin")).toBe(true);
    expect(server.statuses.at(-1)).toMatchObject({ deferredFiles: 1 });
    // Never read whole into memory (review I4): only the small file (hash, then upload).
    expect(t.read).toBe(4);
  });

  it("without streaming, files excluded by the settings are never read (review I4)", async () => {
    const server = new FakeServer();
    const disk = new MemoryFs();
    disk.put("note.md", "ok");
    disk.put(".git/objects/pack.bin", big(64));
    const t = new Timeline();
    const e = await Engine.open(
      deps(instrumented(disk, t, false), watchedHttp(server, t), { maxInMemoryBytes: 1000 }),
    );
    await e.syncNow();
    expect(t.read).toBe(4); // note.md hashed and uploaded; .git never read
    expect(server.store.snapshot().files.map((f) => f.path)).toEqual(["note.md"]);
  });

  it("without streaming, a local file too big to hash is never read and waits (review I4)", async () => {
    const server = new FakeServer();
    const disk = new MemoryFs();
    disk.put("big.md", "y".repeat(64));
    const t = new Timeline();
    const e = await Engine.open(
      deps(instrumented(disk, t, false), watchedHttp(server, t), { maxInMemoryBytes: 32 }),
    );
    await e.syncNow();
    expect(t.read).toBe(0);
    expect(e.deferred()).toEqual([
      { path: "big.md", size: 64, direction: "upload", reason: "size" },
    ]);
  });

  it("without streaming, a remote file over the limit is not downloaded", async () => {
    const server = new FakeServer();
    await server.remotePut(
      "dev-b",
      { opId: "o1", fileId: "f1", versionId: "v1", path: "big.md", baseVersionId: null, mtime: 1 },
      "x".repeat(64),
    );
    const disk = new MemoryFs();
    const t = new Timeline();
    const e = await Engine.open(
      deps(instrumented(disk, t, false), watchedHttp(server, t), { maxInMemoryBytes: 32 }),
    );
    await e.syncNow();
    expect(disk.files.has("big.md")).toBe(false);
    expect(e.deferred()).toEqual([
      { path: "big.md", size: 64, direction: "download", reason: "size" },
    ]);
  });
});
