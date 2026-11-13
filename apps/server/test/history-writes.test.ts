import { createHash } from "node:crypto";
import { ConflictList, FileVersions, TrashList, type JournalEntry } from "@kamino/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testApp, type Agent, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { linkDevice, PW, uploadContent, user, type TestDevice } from "./helpers/sync.js";

const sha = (s: string) => createHash("sha256").update(Buffer.from(s)).digest("hex");

describe.skipIf(dockerUnavailable)("conflict resolution and restores (M3a)", () => {
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
    t = await testApp(await pg.createDatabase(`hwrites_${++n}`));
  });

  async function commit(d: TestDevice, o: object) {
    const r = await d.call("POST", `/vaults/${d.vaultId}/commits`, { ops: [o] });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json() as { results: { status: string; code?: string }[] }).results[0]!;
  }
  async function put(
    d: TestDevice,
    fileId: string,
    ver: string,
    path: string,
    body: string,
    base: string | null,
  ) {
    t.clock.now += 60_000;
    const contentHash = await uploadContent(d, Buffer.from(body));
    return (
      await commit(d, {
        type: "put",
        opId: `o${++op}`,
        fileId,
        versionId: ver,
        path,
        baseVersionId: base,
        contentHash,
        size: Buffer.byteLength(body),
        mtime: 1,
      })
    ).status;
  }
  async function login(username: string): Promise<Agent> {
    const a: Agent = {};
    expect((await t.call(a, "POST", "/auth/login", { username, password: PW })).statusCode).toBe(
      200,
    );
    return a;
  }
  async function journal(d: TestDevice): Promise<JournalEntry[]> {
    return (
      (await d.call("GET", `/vaults/${d.vaultId}/changes?after=0`)).json() as {
        entries: JournalEntry[];
      }
    ).entries;
  }

  /** mario: a.md at v2 ("mac") with a conflict from the iPhone (v3, "phone"). */
  async function world() {
    const enroll = await user(t, "mario");
    const mac = await linkDevice(t, enroll, undefined, "Mac");
    const phone = await linkDevice(t, enroll, mac.vaultId, "iPhone");
    await put(mac, "f1", "v1", "a.md", "base", null);
    await put(mac, "f1", "v2", "a.md", "mac", "v1");
    expect(await put(phone, "f1", "v3", "a.md", "phone", "v1")).toBe("conflict");
    t.clock.now += 60_000;
    const mario = await login("mario");
    const [c] = ConflictList.parse((await t.call(mario, "GET", "/conflicts")).json());
    return { mac, phone, mario, c: c! };
  }
  const resolve = (a: Agent, id: string, resolution: unknown, expectedIncomingAt: string) =>
    t.call(a, "POST", `/conflicts/${id}/resolve`, { resolution, expectedIncomingAt });

  it("keep mine: the head stays, the conflict closes, devices hear conflict_resolved", async () => {
    const { mac, mario, c } = await world();
    const r = await resolve(mario, c.id, "keep_mine", c.incoming.at);
    expect(r.statusCode, r.body).toBe(204);
    expect((await t.call(mario, "GET", "/conflicts")).json()).toEqual([]);
    const last = (await journal(mac)).at(-1)!;
    expect(last).toMatchObject({
      type: "conflict_resolved",
      conflictId: c.id,
      versionId: "v2",
      contentHash: sha("mac"),
      deviceId: "00000000-0000-0000-0000-000000000000",
    });
  });

  it("keep mine on a file deleted meanwhile brings it back instead of leaving it to expire", async () => {
    const { mac, mario, c } = await world();
    t.clock.now += 60_000;
    await commit(mac, { type: "delete", opId: `o${++op}`, fileId: "f1", baseVersionId: "v2" });
    expect((await resolve(mario, c.id, "keep_mine", c.incoming.at)).statusCode).toBe(204);
    expect((await journal(mac)).slice(-2).map((e) => e.type)).toEqual([
      "file_restored",
      "conflict_resolved",
    ]);
    const trash = TrashList.parse(
      (await t.call(mario, "GET", `/vaults/${mac.vaultId}/trash`)).json(),
    );
    expect(trash.items).toEqual([]);
  });

  it("keep incoming: a new current version with the incoming content", async () => {
    const { mac, mario, c } = await world();
    expect((await resolve(mario, c.id, "keep_incoming", c.incoming.at)).statusCode).toBe(204);
    const [put1, resolved] = (await journal(mac)).slice(-2);
    expect(put1).toMatchObject({ type: "file_put", fileId: "f1", contentHash: sha("phone") });
    expect(resolved).toMatchObject({ type: "conflict_resolved", versionId: put1!.versionId });
    const versions = FileVersions.parse((await t.call(mario, "GET", "/files/f1/versions")).json());
    expect(versions.versions[0]).toMatchObject({ current: true, device: "—" });
  });

  it("keep both: the incoming side becomes a copy named in the user's language", async () => {
    const { mac, mario, c } = await world();
    expect((await resolve(mario, c.id, "keep_both", c.incoming.at)).statusCode).toBe(204);
    const [copy, resolved] = (await journal(mac)).slice(-2);
    expect(copy).toMatchObject({ type: "file_put", contentHash: sha("phone") });
    expect(copy!.path).toMatch(/^a \(conflitto - iPhone - \d{4}-\d\d-\d\d \d{4}\)\.md$/);
    expect(resolved).toMatchObject({ type: "conflict_resolved", fileId: "f1", versionId: "v2" });
  });

  it("manual: the server stores the merged text as the new version", async () => {
    const { mac, mario, c } = await world();
    const r = await resolve(mario, c.id, { manual: "mac + phone" }, c.incoming.at);
    expect(r.statusCode, r.body).toBe(204);
    const [put1] = (await journal(mac)).slice(-2);
    expect(put1).toMatchObject({ type: "file_put", contentHash: sha("mac + phone"), size: 11 });
    const text = await t.call(mario, "GET", `/versions/${put1!.versionId}`);
    expect(text.json()).toMatchObject({ text: "mac + phone" });
  });

  it("manual over quota: 413, the conflict stays open", async () => {
    const { mario, c } = await world();
    await t.db.$client`update users set quota_bytes = 1 where username = 'mario'`;
    const r = await resolve(mario, c.id, { manual: "too big for the quota" }, c.incoming.at);
    expect([r.statusCode, r.json().error.code]).toEqual([413, "quota_exceeded"]);
    expect(ConflictList.parse((await t.call(mario, "GET", "/conflicts")).json())).toHaveLength(1);
  });

  it("stale: another incoming version, a moved head, or already resolved → 409", async () => {
    const { mac, phone, mario, c } = await world();
    const old = await resolve(mario, c.id, "keep_mine", "2000-01-01T00:00:00.000Z");
    expect([old.statusCode, old.json().error.code]).toEqual([409, "stale_resolution"]);
    const mineAt = await t.call(mario, "POST", `/conflicts/${c.id}/resolve`, {
      resolution: "keep_mine",
      expectedIncomingAt: c.incoming.at,
      expectedMineAt: "2000-01-01T00:00:00.000Z",
    });
    expect(mineAt.statusCode).toBe(409);
    // The phone resolves first, through its own commit: the web app's choice is now stale.
    const dev = await commit(phone, {
      type: "resolve",
      opId: `o${++op}`,
      conflictId: c.id,
      expectedHeadVersionId: "v2",
      keep: { kind: "candidate", candidateVersionId: "v3", versionId: "v4" },
    });
    expect(dev.status).toBe("accepted");
    const late = await resolve(mario, c.id, "keep_mine", c.incoming.at);
    expect([late.statusCode, late.json().error.code]).toEqual([409, "stale_resolution"]);
    const again = await commit(mac, {
      type: "resolve",
      opId: `o${++op}`,
      conflictId: c.id,
      expectedHeadVersionId: "v4",
      keep: { kind: "head" },
    });
    expect(again).toMatchObject({ status: "rejected", code: "stale_resolution" });
  });

  it("resolve-all: only those seen as seen, skipping unknown, closed or changed ones", async () => {
    const { mac, phone, mario, c } = await world();
    await put(mac, "f2", "w1", "b.md", "b", null);
    await put(mac, "f2", "w2", "b.md", "b mac", "w1");
    expect(await put(phone, "f2", "w3", "b.md", "b phone", "w1")).toBe("conflict");
    await put(mac, "f3", "x1", "c.md", "c", null);
    await put(mac, "f3", "x2", "c.md", "c mac", "x1");
    expect(await put(phone, "f3", "x3", "c.md", "c phone", "x1")).toBe("conflict");
    const list = ConflictList.parse((await t.call(mario, "GET", "/conflicts")).json());
    const item = (x: (typeof list)[number]) => ({
      id: x.id,
      expectedIncomingAt: x.incoming.at,
      expectedMineAt: x.mine.at,
    });
    // A newer incoming version on c.md after the list was shown: it must not be resolved blind.
    expect(await put(phone, "f3", "x4", "c.md", "c phone 2", "x1")).toBe("conflict");
    const r = await t.call(mario, "POST", "/conflicts/resolve-all", {
      strategy: "keep_incoming",
      items: [
        ...list.map(item),
        { id: "nope", expectedIncomingAt: c.incoming.at },
        item(list.find((x) => x.id === c.id)!),
      ],
    });
    expect([r.statusCode, r.json()]).toEqual([200, { resolved: 2 }]);
    const left = ConflictList.parse((await t.call(mario, "GET", "/conflicts")).json());
    expect(left.map((x) => x.path)).toEqual(["c.md"]);
  });

  it("restores an old version and a deleted file (next to a taken path)", async () => {
    const { mac, mario, c } = await world();
    await resolve(mario, c.id, "keep_mine", c.incoming.at);
    const r = await t.call(mario, "POST", "/versions/v1/restore");
    expect(r.statusCode, r.body).toBe(204);
    expect((await journal(mac)).at(-1)).toMatchObject({
      type: "file_put",
      fileId: "f1",
      contentHash: sha("base"),
    });

    await put(mac, "g", "g1", "gone.md", "bye", null);
    t.clock.now += 60_000;
    await commit(mac, { type: "delete", opId: `o${++op}`, fileId: "g", baseVersionId: "g1" });
    await put(mac, "h", "h1", "gone.md", "new one", null);
    const trash = TrashList.parse(
      (await t.call(mario, "GET", `/vaults/${mac.vaultId}/trash`)).json(),
    );
    expect(trash.items.map((i) => i.fileId)).toEqual(["g"]);
    expect((await t.call(mario, "POST", "/trash/g/restore")).statusCode).toBe(204);
    expect((await journal(mac)).at(-1)).toMatchObject({
      type: "file_restored",
      fileId: "g",
      path: "gone (1).md",
      contentHash: sha("bye"),
    });
    const after = TrashList.parse(
      (await t.call(mario, "GET", `/vaults/${mac.vaultId}/trash`)).json(),
    );
    expect(after.items).toEqual([]);
    // A live file is not in the trash.
    expect((await t.call(mario, "POST", "/trash/g/restore")).statusCode).toBe(404);
  });

  it("someone else's conflicts, versions and trash are a 404", async () => {
    const { c } = await world();
    await user(t, "luigi");
    const luigi = await login("luigi");
    for (const [url, body] of [
      [
        `/conflicts/${c.id}/resolve`,
        { resolution: "keep_mine", expectedIncomingAt: c.incoming.at },
      ],
      ["/versions/v1/restore", undefined],
      ["/trash/f1/restore", undefined],
    ] as const) {
      const r = await t.call(luigi, "POST", url, body);
      expect([url, r.statusCode]).toEqual([url, 404]);
    }
    const all = await t.call(luigi, "POST", "/conflicts/resolve-all", {
      strategy: "keep_mine",
      items: [{ id: c.id, expectedIncomingAt: c.incoming.at }],
    });
    expect(all.json()).toEqual({ resolved: 0 });
  });
});
