import { VaultList, VaultsSummary } from "@kamino/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { testApp, type Agent, type TestApp } from "./helpers/app.js";
import { linkDevice, PW, uploadContent, user } from "./helpers/sync.js";

describe.skipIf(dockerUnavailable)("web vault routes", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let n = 0;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => pg?.stop());
  beforeEach(async () => {
    await t?.close();
    t = await testApp(await pg.createDatabase(`vweb_${++n}`));
  });

  it("list and summary follow the contract; levels, sizes, isolation", async () => {
    const a = await linkDevice(t, await user(t, "mario"));
    const b = await linkDevice(
      t,
      (await t.vaults.createEnrollToken((await t.auth.byUsername("mario"))!.id)).token,
      a.vaultId,
      "iPhone",
    );
    await linkDevice(t, await user(t, "luigi"));
    const base = `/vaults/${a.vaultId}`;
    const content = Buffer.from("twelve bytes");
    const h = await uploadContent(a, content);
    const put = {
      type: "put",
      opId: "o1",
      fileId: "f1",
      versionId: "v1",
      path: "a.md",
      baseVersionId: null,
      contentHash: h,
      size: content.length,
      mtime: 1,
    };
    await a.call("POST", `${base}/commits`, { ops: [put] });
    await a.call("POST", `${base}/ack`, { seq: 1 });

    const web: Agent = {};
    await t.call(web, "POST", "/auth/login", { username: "mario", password: PW });
    // B hasn't acked yet → working.
    let list = VaultList.parse((await t.call(web, "GET", "/vaults")).json());
    expect(list.vaults).toHaveLength(1);
    expect(list.vaults[0]).toMatchObject({
      id: a.vaultId,
      name: "Note",
      fileCount: 1,
      deviceCount: 2,
      level: "working",
      usedBytes: 12,
      conflicts: 0,
    });
    expect(list.quota).toEqual({ usedBytes: 12, limitBytes: null });
    await b.call("POST", `${base}/ack`, { seq: 1 });
    const level = async () =>
      VaultsSummary.parse((await t.call(web, "GET", "/vaults/summary")).json()).vaults[0]!.level;
    expect(await level()).toBe("safe");
    // Local changes still queued on a device → not safe yet.
    const report = { pendingOps: 3, pendingBytes: 10, deferredFiles: 0 };
    await b.call("POST", `${base}/status`, report);
    expect(await level()).toBe("working");
    await b.call("POST", `${base}/status`, { ...report, pendingOps: 0 });
    expect(await level()).toBe("safe");

    // A stale edit → open conflict → decision; the candidate counts as history.
    const other = Buffer.from("other text");
    const h2 = await uploadContent(b, other);
    await b.call("POST", `${base}/commits`, {
      ops: [
        {
          ...put,
          opId: "o2",
          versionId: "v2",
          baseVersionId: "stale",
          contentHash: h2,
          size: other.length,
        },
      ],
    });
    list = VaultList.parse((await t.call(web, "GET", "/vaults")).json());
    expect(list.vaults[0]).toMatchObject({ level: "decision", conflicts: 1, historyBytes: 10 });
    expect((await t.call({}, "GET", "/vaults")).statusCode).toBe(401);

    // A vault whose only device never synced is not safe either.
    const mario = (await t.auth.byUsername("mario"))!.id;
    await linkDevice(t, (await t.vaults.createEnrollToken(mario)).token);
    list = VaultList.parse((await t.call(web, "GET", "/vaults")).json());
    expect(list.vaults.find((v) => v.id !== a.vaultId)?.level).toBe("working");
  });
});
