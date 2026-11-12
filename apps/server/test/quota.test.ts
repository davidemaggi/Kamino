import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { linkDevice, putFile, uploadContent, user, type TestDevice } from "./helpers/sync.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const bytes = (n: number, fill: string) => Buffer.alloc(n, fill);

describe.skipIf(dockerUnavailable)("quotas", () => {
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
    t = await testApp(await pg.createDatabase(`quota_${++n}`));
  });

  const setQuota = (username: string, q: number | null) =>
    t.db.update(users).set({ quotaBytes: q }).where(eq(users.username, username));
  const createUpload = (d: TestDevice, b: Buffer) =>
    d.call("POST", `/vaults/${d.vaultId}/uploads`, { contentHash: sha(b), size: b.length });

  it("an upload past the quota → 413 quota_exceeded; open sessions reserve space", async () => {
    const d = await linkDevice(t, await user(t, "mario"));
    await setQuota("mario", 100);
    await putFile(d, "a.md", bytes(60, "a"));
    const r = await createUpload(d, bytes(41, "b"));
    expect(r.statusCode).toBe(413);
    expect(r.json()).toMatchObject({ error: { code: "quota_exceeded" } });
    expect((await createUpload(d, bytes(40, "c"))).statusCode).toBe(200);
    // The 40 bytes still being uploaded count: another 1 doesn't fit.
    expect((await createUpload(d, bytes(1, "d"))).statusCode).toBe(413);
  });

  it("with a full quota, deletes, renames and already stored content still go through", async () => {
    const d = await linkDevice(t, await user(t, "mario"));
    const a = bytes(50, "a");
    const commit = async (op: Record<string, unknown>) =>
      (await d.call("POST", `/vaults/${d.vaultId}/commits`, { ops: [op] })).json().results[0];
    const hash = await uploadContent(d, a);
    const put = { type: "put", fileId: "f1", baseVersionId: null, contentHash: hash, size: 50 };
    expect(
      await commit({ ...put, opId: "p1", versionId: "v1", path: "a.md", mtime: 1 }),
    ).toMatchObject({ status: "accepted" });
    await setQuota("mario", 50);
    expect((await createUpload(d, bytes(1, "z"))).statusCode).toBe(413);
    // Content the vault already has: no new bytes, so a copy of it goes through.
    expect((await createUpload(d, a)).statusCode).toBe(200);
    expect(
      await commit({ ...put, fileId: "f2", opId: "p2", versionId: "v2", path: "c.md", mtime: 1 }),
    ).toMatchObject({ status: "accepted" });
    expect(
      await commit({ type: "move", opId: "m1", fileId: "f1", fromPath: "a.md", toPath: "b.md" }),
    ).toMatchObject({ status: "accepted" });
    expect(
      await commit({ type: "delete", opId: "d1", fileId: "f1", baseVersionId: "v1" }),
    ).toMatchObject({ status: "accepted" });
  });

  it("usage counts what is stored once per vault, across the user's vaults", async () => {
    const enroll = await user(t, "mario");
    const d1 = await linkDevice(t, enroll);
    const d2 = await linkDevice(t, enroll);
    const a = bytes(30, "a");
    await uploadContent(d1, a);
    await uploadContent(d1, a); // same vault: deduplicated
    await uploadContent(d2, a); // another vault: its own encrypted copy
    const id = (await t.db.select().from(users).where(eq(users.username, "mario")))[0]!.id;
    expect(await t.quota.usage(id)).toEqual({ usedBytes: 60, limitBytes: null });
  });

  it("/vaults reports the limit: the user's own, else the system default", async () => {
    const d = await linkDevice(t, await user(t, "mario"));
    await putFile(d, "a.md", bytes(10, "a"));
    const web = { cookie: undefined as string | undefined };
    await t.call(web, "POST", "/auth/login", { username: "mario", password: "Qp7#vT2!mZx9-long" });
    expect((await t.call(web, "GET", "/vaults")).json().quota).toEqual({
      usedBytes: 10,
      limitBytes: null,
    });
    await t.config.patch({ defaultQuotaBytes: 5000 }, "root");
    expect((await t.call(web, "GET", "/vaults")).json().quota.limitBytes).toBe(5000);
    await setQuota("mario", 20);
    expect((await t.call(web, "GET", "/vaults")).json().quota.limitBytes).toBe(20);
  });

  it("the file size limit changed from the UI applies to new uploads", async () => {
    const d = await linkDevice(t, await user(t, "mario"));
    await t.config.patch({ maxFileBytes: 10 }, "root");
    const r = await createUpload(d, bytes(11, "a"));
    expect(r.statusCode).toBe(413);
    expect(r.json()).toMatchObject({ error: { code: "file_too_large" } });
  });
});
