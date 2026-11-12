import { readdirSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FsBlobStore } from "../src/blobs/fs-store.js";
import { purgeDeletedVaults } from "../src/jobs/purge.js";
import { VaultGone } from "../src/sync/commit.js";
import { deleteVault } from "../src/vaults/delete.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { linkDevice, putFile, user } from "./helpers/sync.js";
import { hello } from "./helpers/ws.js";

function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

describe.skipIf(dockerUnavailable)("vault deletion", () => {
  let pg: TestPostgres;
  let t: TestApp;
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
    t = await testApp(await pg.createDatabase(`vdel_${++n}`));
  });

  it("a wrong name changes nothing", async () => {
    const d = await linkDevice(t, await user(t, "mario"));
    const v = (await t.vaults.byId(d.vaultId))!;
    await expect(deleteVault(t.db, t.hub, t.vaults, v, "Nope", t.clock.now)).rejects.toMatchObject({
      code: "confirm_mismatch",
      status: 400,
    });
    expect((await t.vaults.byId(d.vaultId))!.dekWrapped).not.toBeNull();
    expect((await putFile(d, "a.md")).results[0]!.status).toBe("accepted");
  });

  it("destroys the key, revokes devices, closes sockets; the purge removes the blobs", async () => {
    const enroll = await user(t, "mario");
    const d = await linkDevice(t, enroll);
    const keep = await linkDevice(t, enroll, undefined, "Other");
    await putFile(d, "a.md", Buffer.from("alpha"));
    await putFile(keep, "b.md", Buffer.from("beta"));
    const ws = await t.ws();
    ws.send(hello(d.token));
    await ws.next("welcome");
    const vaultDir = `${t.dirs.blobs}/${d.vaultId}`;
    expect(filesUnder(vaultDir).length).toBe(1);

    const v = (await t.vaults.byId(d.vaultId))!;
    await deleteVault(t.db, t.hub, t.vaults, v, " Note ", t.clock.now);

    const after = (await t.vaults.byId(d.vaultId))!;
    expect(after).toMatchObject({ status: "deleted", dekWrapped: null });
    expect(() => t.vaults.cryptoOf(after)).toThrow();
    expect((await t.vaults.listForUser(v.ownerId)).map((x) => x.id)).toEqual([keep.vaultId]);
    const r = await d.call("GET", `/vaults/${d.vaultId}/changes?after=0`);
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ error: { code: "device_revoked" } });
    expect((await ws.closed()).code).toBe(4403);

    const store = new FsBlobStore(t.dirs.blobs);
    expect((await purgeDeletedVaults(t.db, store)).blobs).toBe(1);
    expect(filesUnder(vaultDir)).toEqual([]);
    expect(filesUnder(`${t.dirs.blobs}/${keep.vaultId}`).length).toBe(1);
    // Idempotent.
    expect((await purgeDeletedVaults(t.db, store)).blobs).toBe(0);
    expect((await putFile(keep, "c.md")).results[0]!.status).toBe("accepted");
  });

  it("a commit or upload already past the checks writes nothing into the deleted vault", async () => {
    const d = await linkDevice(t, await user(t, "mario"));
    const v = (await t.vaults.byId(d.vaultId))!;
    // Taken before the deletion, as by a request that passed its checks just before.
    const vc = t.vaults.cryptoOf(v);
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update("abc").digest("hex");
    const upload = await t.uploads.create(vc, d.deviceId, hash, 3);
    await t.uploads.putChunk(vc, upload.uploadId, 0, Buffer.from("abc"));
    expect(upload.chunkSize).toBeGreaterThanOrEqual(3);
    await deleteVault(t.db, t.hub, t.vaults, v, "Note", t.clock.now);

    await expect(
      t.sync.commit(vc, d.deviceId, [
        { type: "mkdir", opId: "late", fileId: "d1", path: "late" } as never,
      ]),
    ).rejects.toBeInstanceOf(VaultGone);
    await expect(t.uploads.complete(vc, upload.uploadId)).rejects.toMatchObject({ status: 404 });
    const rows = await t.db.$client`select
      (select count(*) from journal where vault_id = ${v.id})::int as journal,
      (select count(*) from files where vault_id = ${v.id})::int as files,
      (select count(*) from blobs where vault_id = ${v.id})::int as blobs`;
    expect(rows[0]).toEqual({ journal: 0, files: 0, blobs: 0 });
  });
});
