import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { blobKeyOf } from "../src/blobs/uploads.js";
import { applyRetention } from "../src/jobs/retention.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { linkDevice, uploadContent, user, type TestDevice } from "./helpers/sync.js";

const DAY = 86_400_000;

describe.skipIf(dockerUnavailable)("history retention and blob GC (M3a)", () => {
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
    t = await testApp(await pg.createDatabase(`retention_${++n}`));
    // Blob rows are dated by the database: keep the app clock on the same time.
    t.clock.now = Date.now();
  });

  async function commit(d: TestDevice, o: object) {
    const r = await d.call("POST", `/vaults/${d.vaultId}/commits`, { ops: [o] });
    return (r.json() as { results: { status: string }[] }).results[0]!.status;
  }
  async function put(
    d: TestDevice,
    fileId: string,
    ver: string,
    body: string,
    base: string | null,
  ) {
    const contentHash = await uploadContent(d, Buffer.from(body));
    return commit(d, {
      type: "put",
      opId: `o${++op}`,
      fileId,
      versionId: ver,
      path: `${fileId}.md`,
      baseVersionId: base,
      contentHash,
      size: Buffer.byteLength(body),
      mtime: 1,
    });
  }
  const versionIds = async () =>
    (await t.db.$client<{ id: string }[]>`select id from file_versions order by id`).map(
      (r) => r.id,
    );
  const blobCount = async () =>
    Number((await t.db.$client<{ n: string }[]>`select count(*) as n from blobs`)[0]!.n);

  async function world() {
    const enroll = await user(t, "mario");
    const mac = await linkDevice(t, enroll, undefined, "Mac");
    const phone = await linkDevice(t, enroll, mac.vaultId, "iPhone");
    await t.db.$client`update vaults set retention_days = 1`;
    return { mac, phone };
  }

  it("drops old versions that are not current, keeps what open conflicts need", async () => {
    const { mac, phone } = await world();
    await put(mac, "a", "a1", "a one", null);
    await put(mac, "a", "a2", "a two", "a1");
    await put(mac, "b", "b1", "b one", null);
    await put(mac, "b", "b2", "b two", "b1");
    expect(await put(phone, "b", "b3", "b three", "b1")).toBe("conflict");
    const before = await t.quota.usage((await t.vaults.byId(mac.vaultId))!.ownerId);

    // Within the window: nothing goes.
    let r = await applyRetention(t.db, t.blobStore, t.clock.now + DAY / 2);
    expect(r).toEqual({ versions: 0, files: 0, blobs: 0 });

    r = await applyRetention(t.db, t.blobStore, t.clock.now + 2 * DAY);
    expect(r).toMatchObject({ versions: 1, files: 0, blobs: 1 });
    expect(await versionIds()).toEqual(["a2", "b1", "b2", "b3"]);
    const after = await t.quota.usage((await t.vaults.byId(mac.vaultId))!.ownerId);
    expect(before.usedBytes - after.usedBytes).toBe(Buffer.byteLength("a one"));
  });

  it("the system maximum caps a vault's retention", async () => {
    const { mac } = await world();
    await t.db.$client`update vaults set retention_days = 30`;
    await put(mac, "a", "a1", "one", null);
    await put(mac, "a", "a2", "two", "a1");
    expect((await applyRetention(t.db, t.blobStore, t.clock.now + 2 * DAY)).versions).toBe(0);
    expect((await applyRetention(t.db, t.blobStore, t.clock.now + 2 * DAY, 1)).versions).toBe(1);
  });

  it("empties the trash after max(7 days, retention), with every version", async () => {
    const { mac, phone } = await world();
    await put(mac, "g", "g1", "bye", null);
    await put(mac, "g", "g2", "bye bye", "g1");
    expect(await put(phone, "g", "gp", "from phone", "g1")).toBe("conflict");
    const [c] = await t.db.$client<{ id: string }[]>`select id from conflicts`;
    expect(
      await commit(phone, {
        type: "resolve",
        opId: `o${++op}`,
        conflictId: c!.id,
        expectedHeadVersionId: "g2",
        keep: { kind: "head" },
      }),
    ).toBe("accepted");
    await commit(mac, { type: "delete", opId: `o${++op}`, fileId: "g", baseVersionId: "g2" });
    // Retention 1 day, but the trash keeps a file at least 7.
    let r = await applyRetention(t.db, t.blobStore, t.clock.now + 6 * DAY);
    expect(r.files).toBe(0);
    expect(await versionIds()).toEqual(["g2"]);
    r = await applyRetention(t.db, t.blobStore, t.clock.now + 8 * DAY);
    expect(r).toMatchObject({ files: 1, versions: 1, blobs: 1 });
    expect(await versionIds()).toEqual([]);
    expect(await blobCount()).toBe(0);
    const orphans = await t.db.$client<{ n: string }[]>`
      select (select count(*) from conflicts) + (select count(*) from conflict_candidates) as n`;
    expect(Number(orphans[0]!.n)).toBe(0);
    // The device that still had it creates it again: nothing is lost.
    expect(await put(mac, "g", "g3", "back", "g2")).toBe("rejected");
    expect(await put(mac, "g", "g4", "back", null)).toBe("accepted");
  });

  it("GC spares blobs that are young, referenced or being uploaded, and removes the object", async () => {
    const { mac } = await world();
    await put(mac, "a", "a1", "kept", null);
    await uploadContent(mac, Buffer.from("orphan"));
    await uploadContent(mac, Buffer.from("uploading"));
    const rows = await t.db.$client<{ blob_id: string; size: string }[]>`
      select blob_id, size from blobs order by size`;
    const uploading = rows.find((x) => Number(x.size) === 9)!.blob_id;
    const orphan = rows.find((x) => Number(x.size) === 6)!.blob_id;
    await t.db.$client`insert into upload_sessions
      (id, vault_id, device_id, content_hash_enc, blob_id, size, chunk_size, salt, state, expires_at)
      values (gen_random_uuid(), ${mac.vaultId}, ${mac.deviceId}, '\\x00', ${uploading}, 9, 1024,
        '\\x00', 'open', now() + interval '30 days')`;
    expect((await applyRetention(t.db, t.blobStore, t.clock.now + DAY / 2)).blobs).toBe(0);
    expect((await applyRetention(t.db, t.blobStore, t.clock.now + 2 * DAY)).blobs).toBe(1);
    expect(await blobCount()).toBe(2);
    const key = blobKeyOf(mac.vaultId, orphan);
    await expect(
      (async () => {
        for await (const _ of t.blobStore.getRange(key, 0, 1)) void _;
      })(),
    ).rejects.toThrow();
  });
});
