import { ConflictDetail, ConflictList } from "@kamino/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FsBlobStore } from "../src/blobs/fs-store.js";
import { ConflictService } from "../src/conflicts/service.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { linkDevice, uploadContent, user, type TestDevice } from "./helpers/sync.js";

describe.skipIf(dockerUnavailable)("conflicts (read only)", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let c: ConflictService;
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
    t = await testApp(await pg.createDatabase(`conflicts_${++n}`));
    c = new ConflictService(t.db, new FsBlobStore(t.dirs.blobs), t.vaults);
  });

  async function put(d: TestDevice, ver: string, path: string, body: Buffer, base: string | null) {
    t.clock.now += 60_000;
    const hash = await uploadContent(d, body);
    const r = await d.call("POST", `/vaults/${d.vaultId}/commits`, {
      ops: [
        {
          type: "put",
          opId: `o${++op}`,
          fileId: `f-${path}`,
          versionId: ver,
          path,
          baseVersionId: base,
          contentHash: hash,
          size: body.length,
          mtime: 1,
        },
      ],
    });
    return (r.json() as { results: { status: string }[] }).results[0]!.status;
  }

  async function conflicted(path: string, a: Buffer, b: Buffer) {
    const enroll = await user(t, "mario");
    const mac = await linkDevice(t, enroll, undefined, "Mac");
    const phone = await linkDevice(t, enroll, mac.vaultId, "iPhone");
    expect(await put(mac, "v0", path, Buffer.from("base"), null)).toBe("accepted");
    expect(await put(mac, "v1", path, a, "v0")).toBe("accepted");
    expect(await put(phone, "v2", path, b, "v0")).toBe("conflict");
    const ownerId = (await t.vaults.byId(mac.vaultId))!.ownerId;
    return { ownerId, vault: (await t.vaults.byId(mac.vaultId))! };
  }

  it("lists open conflicts with path, vault name and both sides, and shows text", async () => {
    const { ownerId, vault } = await conflicted("a.md", Buffer.from("mac"), Buffer.from("phone"));
    const list = ConflictList.parse(await c.list(ownerId));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      vaultId: vault.id,
      vaultName: "Note",
      path: "a.md",
      kind: "concurrent_edit",
      binary: false,
      mine: { device: "Mac" },
      incoming: { device: "iPhone" },
    });
    const d = ConflictDetail.parse(await c.detail(vault, list[0]!.id));
    expect(d).toMatchObject({ binary: false, mineText: "mac", incomingText: "phone" });
    expect((await c.vaultOf(ownerId, list[0]!.id)).id).toBe(vault.id);
  });

  it("shows binary conflicts as metadata", async () => {
    const { ownerId, vault } = await conflicted(
      "cat.png",
      Buffer.from([1, 2, 3]),
      Buffer.from([4, 5, 6, 7]),
    );
    const [s] = await c.list(ownerId);
    expect(s!.binary).toBe(true);
    const d = ConflictDetail.parse(await c.detail(vault, s!.id));
    expect(d).toMatchObject({
      binary: true,
      mineFile: { size: 3, mime: "image/png", previewUrl: null },
      incomingFile: { size: 4, mime: "image/png", previewUrl: null },
    });
  });

  it("keeps other users' conflicts out of the list and answers not found", async () => {
    const { vault } = await conflicted("a.md", Buffer.from("x"), Buffer.from("y"));
    const [s] = await c.list(vault.ownerId);
    await linkDevice(t, await user(t, "luigi"), undefined, "PC");
    const luigi = (await t.db.query.users.findFirst({
      where: (u, { eq }) => eq(u.username, "luigi"),
    }))!;
    expect(await c.list(luigi.id)).toEqual([]);
    await expect(c.vaultOf(luigi.id, s!.id)).rejects.toMatchObject({ code: "not_found" });
  });
});
