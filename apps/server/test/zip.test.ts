import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import yauzl from "yauzl";
import { readPlain } from "../src/blobs/uploads.js";
import { FsBlobStore } from "../src/blobs/fs-store.js";
import { HistoryService, type TreeEntry } from "../src/history/service.js";
import { folderNames, zipFileName, zipStream } from "../src/history/zip.js";
import { ownedVault } from "../src/vaults/access.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { linkDevice, uploadContent, user, type TestDevice } from "./helpers/sync.js";

async function toBuffer(s: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of s) parts.push(Buffer.from(p as Buffer));
  return Buffer.concat(parts);
}

/** name → content (null for directories). */
async function unzip(buf: Buffer): Promise<Record<string, string | null>> {
  const zip = await new Promise<yauzl.ZipFile>((ok, ko) =>
    yauzl.fromBuffer(buf, { lazyEntries: true }, (e, z) => (e ? ko(e) : ok(z))),
  );
  const out: Record<string, string | null> = {};
  await new Promise<void>((ok, ko) => {
    zip.on("entry", (entry: yauzl.Entry) => {
      if (entry.fileName.endsWith("/")) {
        out[entry.fileName] = null;
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (e, s) => {
        if (e) return ko(e);
        toBuffer(s).then((b) => {
          out[entry.fileName] = b.toString("utf8");
          zip.readEntry();
        }, ko);
      });
    });
    zip.on("end", ok);
    zip.on("error", ko);
    zip.readEntry();
  });
  return out;
}

describe("zip stream", () => {
  it("names the file by date only", () => {
    const now = new Date("2026-11-11T10:00:00Z");
    expect(zipFileName(null, now)).toBe("vault-2026-11-11.zip");
    expect(zipFileName(new Date("2026-11-01T23:00:00Z"), now)).toBe("vault-2026-11-01.zip");
  });

  it("streams a 20 MB file without reading ahead of the consumer", async () => {
    const SIZE = 20 * 1024 * 1024;
    const PIECE = 64 * 1024;
    const tree = new Map<string, TreeEntry>([
      ["big.bin", { kind: "file", blobId: "b", size: SIZE, mtime: 1 }],
    ]);
    let read = 0;
    async function* open() {
      for (let sent = 0; sent < SIZE; sent += PIECE) {
        read += PIECE;
        yield randomBytes(PIECE);
      }
    }
    let out = 0;
    let ahead = 0;
    for await (const p of zipStream(tree, open)) {
      out += (p as Buffer).length;
      ahead = Math.max(ahead, read - out);
      // A slow consumer: the producer must wait instead of buffering the whole file.
      await new Promise((r) => setImmediate(r));
    }
    expect(read).toBe(SIZE);
    expect(out).toBeGreaterThan(SIZE);
    expect(ahead).toBeLessThan(4 * 1024 * 1024);
  });
});

describe("zip stream failures", () => {
  const tree = new Map<string, TreeEntry>([
    ["a.bin", { kind: "file", blobId: "a", size: 200 * 65536, mtime: 1 }],
    ["b.bin", { kind: "file", blobId: "b", size: 65536, mtime: 1 }],
  ]);

  it("a read error mid-stream fails the stream, never the process", async () => {
    async function* open() {
      yield randomBytes(65536);
      throw new Error("blob gone");
    }
    await expect(toBuffer(zipStream(tree, open))).rejects.toThrow("blob gone");
  });

  it("a size mismatch fails the stream", async () => {
    async function* open() {
      yield randomBytes(10);
    }
    await expect(toBuffer(zipStream(tree, open))).rejects.toThrow();
  });

  it("a cancelled download stops reading blobs", async () => {
    const opened: string[] = [];
    let pieces = 0;
    async function* open(blobId: string, size: number) {
      opened.push(blobId);
      for (let sent = 0; sent < size; sent += 65536) {
        pieces++;
        yield randomBytes(65536);
      }
    }
    const s = zipStream(tree, open);
    await new Promise<void>((ok) => s.once("data", () => ok()));
    s.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(opened).toEqual(["a"]);
    expect(pieces).toBeLessThan(40);
  });
});

describe.skipIf(dockerUnavailable)("zip of a vault", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let n = 0;
  let op = 0;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => {
    await t?.close();
    await pg?.stop();
  });
  beforeEach(async () => {
    await t?.close();
    t = await testApp(await pg.createDatabase(`zip_${++n}`));
  });

  async function commit(d: TestDevice, o: Record<string, unknown>) {
    t.clock.now += 60_000;
    await d.call("POST", `/vaults/${d.vaultId}/commits`, { ops: [{ opId: `o${++op}`, ...o }] });
  }
  async function put(
    d: TestDevice,
    id: string,
    ver: string,
    path: string,
    text: string,
    base: string | null,
  ) {
    const buf = Buffer.from(text);
    const contentHash = await uploadContent(d, buf);
    await commit(d, {
      type: "put",
      fileId: id,
      versionId: ver,
      path,
      baseVersionId: base,
      contentHash,
      size: buf.length,
      mtime: Date.UTC(2026, 0, 1),
    });
  }

  it("contains the vault as it is, or as it was at a date", async () => {
    const d = await linkDevice(t, await user(t, "mario"), undefined, "Mac");
    await put(d, "f1", "v1", "a.md", "alpha", null);
    await put(d, "f2", "v2", "notes/b.md", "beta", null);
    await put(d, "f3", "v3", "{config}/app.json", "{}", null);
    await commit(d, { type: "mkdir", fileId: "d1", path: "empty" });
    const before = new Date(t.clock.now);
    await put(d, "f1", "v4", "a.md", "alpha 2", "v1");
    t.clock.now += 60_000;

    const owner = (await t.vaults.byId(d.vaultId))!.ownerId;
    const { vc } = await ownedVault(t.vaults, owner, d.vaultId);
    const store = new FsBlobStore(t.dirs.blobs);
    const h = new HistoryService(t.db, store, () => t.clock.now);
    const open = (blobId: string, size: number) => readPlain(store, vc, blobId, size, 0, size);

    expect(await unzip(await toBuffer(zipStream(await h.treeAt(vc, null), open)))).toEqual({
      "a.md": "alpha 2",
      "notes/b.md": "beta",
      ".obsidian/app.json": "{}",
      "empty/": null,
    });
    expect((await unzip(await toBuffer(zipStream(await h.treeAt(vc, before), open))))["a.md"]).toBe(
      "alpha",
    );
  });
});

describe("folderNames", () => {
  it("makes vault names safe folders and dedupes them", () => {
    expect(folderNames(["Note", "a/b:c", "note", " .hidden. ", "", "x\u0001y", "Note"])).toEqual([
      "Note",
      "a_b_c",
      "note (2)",
      "hidden",
      "vault",
      "x_y",
      "Note (3)",
    ]);
  });
});
