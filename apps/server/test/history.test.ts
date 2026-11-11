import { FileList, FileVersions, TrashList, VersionContent } from "@kamino/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FsBlobStore } from "../src/blobs/fs-store.js";
import { HistoryService } from "../src/history/service.js";
import { ApiError } from "../src/http/errors.js";
import { ownedVault } from "../src/vaults/access.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { linkDevice, uploadContent, user, type TestDevice } from "./helpers/sync.js";

const MIN = 60_000;

describe.skipIf(dockerUnavailable)("history and trash (read only)", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let h: HistoryService;
  let n = 0;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => {
    await t?.close();
    await pg?.stop();
  });
  beforeEach(async () => {
    await t?.close();
    t = await testApp(await pg.createDatabase(`history_${++n}`));
    h = new HistoryService(t.db, new FsBlobStore(t.dirs.blobs), () => t.clock.now);
  });

  let op = 0;
  async function commit(d: TestDevice, o: Record<string, unknown>) {
    t.clock.now += MIN;
    const r = await d.call("POST", `/vaults/${d.vaultId}/commits`, {
      ops: [{ opId: `o${++op}`, ...o }],
    });
    const res = (r.json() as { results: { status: string }[] }).results[0]!;
    expect(res.status).not.toBe("rejected");
    return res;
  }
  async function put(
    d: TestDevice,
    fileId: string,
    versionId: string,
    path: string,
    text: string | Buffer,
    base: string | null,
  ) {
    const buf = Buffer.isBuffer(text) ? text : Buffer.from(text);
    const hash = await uploadContent(d, buf);
    return commit(d, {
      type: "put",
      fileId,
      versionId,
      path,
      baseVersionId: base,
      contentHash: hash,
      size: buf.length,
      mtime: 1,
    });
  }
  async function setup() {
    const enroll = await user(t, "mario");
    const d = await linkDevice(t, enroll, undefined, "Mac");
    const userId = (await t.vaults.byId(d.vaultId))!.ownerId;
    const { vc } = await ownedVault(t.vaults, userId, d.vaultId);
    return { d, vc };
  }
  const textOf = async (vc: Parameters<HistoryService["treeAt"]>[0], at: Date | null) => {
    const tree = await h.treeAt(vc, at);
    const out: Record<string, string | null> = {};
    for (const [p, e] of tree)
      out[p] = e.kind === "folder" ? null : await h.text(vc, e.blobId, e.size);
    return out;
  };

  it("searches decrypted paths, case-insensitively, newest first", async () => {
    const { d, vc } = await setup();
    await put(d, "f1", "v1", "Notes/Ricette.md", "pasta", null);
    await put(d, "f2", "v2", "notes/spesa.md", "latte", null);
    await put(d, "f3", "v3", "diario.md", "oggi", null);
    const r = FileList.parse(await h.search(vc, "NOTES/"));
    expect(r.files.map((f) => f.path)).toEqual(["notes/spesa.md", "Notes/Ricette.md"]);
    expect(r.files[0]).toMatchObject({ fileId: "f2", versions: 1 });
    expect((await h.search(vc, "")).files).toHaveLength(3);
  });

  it("lists versions newest first with the device name, and shows text or binary content", async () => {
    const { d, vc } = await setup();
    await put(d, "f1", "v1", "a.md", "one", null);
    await put(d, "f1", "v2", "a.md", "two", "v1");
    const r = FileVersions.parse(await h.versions(vc, "f1"));
    expect(r.path).toBe("a.md");
    expect(r.versions.map((v) => [v.id, v.current, v.device])).toEqual([
      ["v2", true, "Mac"],
      ["v1", false, "Mac"],
    ]);
    const v1 = VersionContent.parse(await h.version(vc, "v1"));
    expect(v1).toMatchObject({ mime: "text/markdown", text: "one", size: 3, previewUrl: null });

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    await put(d, "f2", "v3", "img/cat.png", png, null);
    expect(await h.version(vc, "v3")).toMatchObject({ mime: "image/png", text: null, size: 8 });
  });

  it("lists deleted files in the trash with a 7-day minimum expiry", async () => {
    const { d, vc } = await setup();
    await put(d, "f1", "v1", "gone.md", "bye", null);
    await commit(d, { type: "delete", fileId: "f1", baseVersionId: "v1" });
    const r = TrashList.parse(await h.trash(vc));
    expect(r.items).toHaveLength(1);
    const item = r.items[0]!;
    expect(item).toMatchObject({ fileId: "f1", path: "gone.md", size: 3 });
    expect(new Date(item.deletedAt).getTime()).toBe(t.clock.now);
    // retention 30 days by default > 7
    expect(new Date(item.expiresAt).getTime() - new Date(item.deletedAt).getTime()).toBe(
      30 * 86_400_000,
    );
    expect((await h.search(vc, "")).files).toHaveLength(0);
  });

  it("rebuilds the tree at a past date across edits, moves, deletions and folders", async () => {
    const { d, vc } = await setup();
    await put(d, "f1", "v1", "a.md", "one", null);
    await commit(d, { type: "mkdir", fileId: "d1", path: "docs" });
    const t1 = new Date(t.clock.now);
    await put(d, "f1", "v2", "a.md", "two", "v1");
    await commit(d, { type: "move", fileId: "f1", fromPath: "a.md", toPath: "docs/a.md" });
    await put(d, "f2", "v3", "b.md", "bee", null);
    const t2 = new Date(t.clock.now);
    await commit(d, { type: "delete", fileId: "f2", baseVersionId: "v3" });
    await commit(d, { type: "mkdir", fileId: "d2", path: "empty" });
    t.clock.now += MIN;

    expect(await textOf(vc, t1)).toEqual({ "a.md": "one", docs: null });
    expect(await textOf(vc, t2)).toEqual({ "docs/a.md": "two", docs: null, "b.md": "bee" });
    expect(await textOf(vc, null)).toEqual({ "docs/a.md": "two", docs: null, empty: null });
    // An edit wins over a deletion: the file comes back (file_restored).
    const t3 = new Date(t.clock.now);
    await put(d, "f2", "v4", "b.md", "back", "v3");
    expect(await textOf(vc, t3)).toEqual({ "docs/a.md": "two", docs: null, empty: null });
    expect((await textOf(vc, null))["b.md"]).toBe("back");
  });

  it("refuses dates outside the history window", async () => {
    const { d, vc } = await setup();
    await put(d, "f1", "v1", "a.md", "one", null);
    const err = await h.treeAt(vc, new Date(t.clock.now - 31 * 86_400_000)).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "history_window", status: 400 });
  });

  it("answers not found for files and versions of another vault", async () => {
    const { d } = await setup();
    await put(d, "f1", "v1", "a.md", "one", null);
    const other = await linkDevice(t, await user(t, "luigi"), undefined, "PC");
    const owner = (await t.vaults.byId(other.vaultId))!.ownerId;
    const { vc } = await ownedVault(t.vaults, owner, other.vaultId);
    await expect(h.version(vc, "v1")).rejects.toMatchObject({ code: "not_found" });
    await expect(h.versions(vc, "f1")).rejects.toMatchObject({ code: "not_found" });
  });
});
