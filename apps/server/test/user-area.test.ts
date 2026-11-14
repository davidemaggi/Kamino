import {
  DEFAULT_SYNC_SETTINGS,
  type SyncSettings,
  ConflictDetail,
  ConflictList,
  FileList,
  FileVersions,
  TrashList,
  Vault,
  VaultList,
  VersionContent,
} from "@kamino/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import yauzl from "yauzl";
import { testApp, type Agent, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { linkDevice, PW, uploadContent, user, type TestDevice } from "./helpers/sync.js";

function entriesOf(buf: Buffer): Promise<string[]> {
  return new Promise((ok, ko) =>
    yauzl.fromBuffer(buf, { lazyEntries: true }, (e, z) => {
      if (e) return ko(e);
      const names: string[] = [];
      z.on("entry", (en: yauzl.Entry) => {
        names.push(en.fileName);
        z.readEntry();
      });
      z.on("end", () => ok(names.sort()));
      z.on("error", ko);
      z.readEntry();
    }),
  );
}

describe.skipIf(dockerUnavailable)("user area routes", () => {
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
    t = await testApp(await pg.createDatabase(`uarea_${++n}`));
  });

  async function put(
    d: TestDevice,
    fileId: string,
    ver: string,
    path: string,
    body: string,
    base: string | null,
  ) {
    t.clock.now += 60_000;
    const buf = Buffer.from(body);
    const contentHash = await uploadContent(d, buf);
    const r = await d.call("POST", `/vaults/${d.vaultId}/commits`, {
      ops: [
        {
          type: "put",
          opId: `o${++op}`,
          fileId,
          versionId: ver,
          path,
          baseVersionId: base,
          contentHash,
          size: buf.length,
          mtime: 1,
        },
      ],
    });
    return (r.json() as { results: { status: string }[] }).results[0]!.status;
  }
  async function login(username: string): Promise<Agent> {
    const a: Agent = {};
    const r = await t.call(a, "POST", "/auth/login", { username, password: PW });
    expect(r.statusCode).toBe(200);
    return a;
  }

  /** mario: a vault with a.md (2 versions), a conflict and a deleted file; luigi: an admin with TOTP. */
  async function world() {
    const enroll = await user(t, "mario");
    const mac = await linkDevice(t, enroll, undefined, "Mac");
    const phone = await linkDevice(t, enroll, mac.vaultId, "iPhone");
    await put(mac, "f1", "v1", "a.md", "one", null);
    await put(mac, "f1", "v2", "a.md", "two", "v1");
    expect(await put(phone, "f1", "v3", "a.md", "three", "v1")).toBe("conflict");
    await put(mac, "f2", "v4", "gone.md", "bye", null);
    t.clock.now += 60_000;
    await mac.call("POST", `/vaults/${mac.vaultId}/commits`, {
      ops: [{ type: "delete", opId: `o${++op}`, fileId: "f2", baseVersionId: "v4" }],
    });
    await user(t, "luigi");
    const luigi = await login("luigi");
    // Promoted after signing in (an admin signs in with TOTP): a fully signed-in admin session.
    await t.db
      .$client`update users set role = 'admin', totp_enabled_at = now() where username = 'luigi'`;
    return { mac, mario: await login("mario"), luigi, vaultId: mac.vaultId };
  }

  it("serves the owner every read route, following the contract", async () => {
    const { mario, vaultId } = await world();
    const get = async (url: string) => {
      const r = await t.call(mario, "GET", url);
      expect(r.statusCode, url).toBe(200);
      return r.json();
    };
    expect(Vault.parse(await get(`/vaults/${vaultId}`))).toMatchObject({
      name: "Note",
      fileCount: 1,
    });
    const files = FileList.parse(await get(`/vaults/${vaultId}/files?q=A.MD`));
    expect(files.files.map((f) => f.path)).toEqual(["a.md"]);
    const versions = FileVersions.parse(await get(`/files/f1/versions`));
    expect(versions.versions.map((v) => [v.id, v.current])).toEqual([
      ["v3", false],
      ["v2", true],
      ["v1", false],
    ]);
    expect(VersionContent.parse(await get(`/versions/v1`)).text).toBe("one");
    expect(TrashList.parse(await get(`/vaults/${vaultId}/trash`)).items.map((i) => i.path)).toEqual(
      ["gone.md"],
    );
    const conflicts = ConflictList.parse(await get(`/conflicts`));
    expect(conflicts).toHaveLength(1);
    expect(ConflictDetail.parse(await get(`/conflicts/${conflicts[0]!.id}`))).toMatchObject({
      binary: false,
      mineText: "two",
      incomingText: "three",
    });
  });

  it("streams the zip with a dated name, also as of a past date", async () => {
    const { mario, vaultId } = await world();
    const r = await t.call(mario, "GET", `/vaults/${vaultId}/zip`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("application/zip");
    expect(r.headers["content-disposition"]).toBe('attachment; filename="vault-2026-11-09.zip"');
    expect(await entriesOf(r.rawPayload)).toEqual(["a.md"]);
    const past = new Date(Date.UTC(2026, 10, 9, 12, 4, 30)).toISOString();
    const old = await t.call(mario, "GET", `/vaults/${vaultId}/zip?at=${past}`);
    expect(await entriesOf(old.rawPayload)).toEqual(["a.md", "gone.md"]);
    const tooOld = await t.call(mario, "GET", `/vaults/${vaultId}/zip?at=2020-01-01T00:00:00Z`);
    expect([tooOld.statusCode, tooOld.json().error.code]).toEqual([400, "history_window"]);
    const bad = await t.call(mario, "GET", `/vaults/${vaultId}/zip?at=yesterday`);
    expect(bad.statusCode).toBe(400);
  });

  it("limits ZIP exports per user (M7a A2)", async () => {
    const { mario, vaultId } = await world();
    for (let i = 0; i < 10; i++)
      expect((await t.call(mario, "GET", `/vaults/${vaultId}/zip`)).statusCode).toBe(200);
    const r = await t.call(mario, "GET", `/vaults/${vaultId}/zip`);
    expect([r.statusCode, r.json().error.code]).toEqual([429, "rate_limited"]);
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    t.clock.now += 15 * 60_000;
    expect((await t.call(mario, "GET", `/vaults/${vaultId}/zip`)).statusCode).toBe(200);
  });

  // rc.8: the plugin's "Use the vault settings" follows defaults that only a device could set.
  it("the owner reads and changes the vault's sync settings; devices follow", async () => {
    const { mario, mac, vaultId } = await world();
    const url = `/vaults/${vaultId}/sync-settings`;
    expect((await t.call(mario, "GET", url)).json()).toEqual(DEFAULT_SYNC_SETTINGS);
    const next: SyncSettings = {
      config: { base: true, appearance: false, hotkeys: false, pluginList: true, plugins: true },
      patterns: [...DEFAULT_SYNC_SETTINGS.patterns, "Privato/**"],
    };
    const r = await t.call(mario, "PUT", url, next);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(next);
    expect((await mac.call("GET", "/device/settings")).json().effective).toEqual(next);
    const changes = (await mac.call("GET", `/vaults/${vaultId}/changes?after=0`)).json() as {
      entries: { type: string }[];
    };
    expect(changes.entries.at(-1)?.type).toBe("vault_settings_changed");
    expect((await t.call(mario, "PUT", url, { config: {} })).statusCode).toBe(400);
  });

  it("answers 404 to everyone else, admins included (T-02)", async () => {
    const { luigi, vaultId } = await world();
    const conflictId = (await t.db.$client<{ id: string }[]>`select id from conflicts`)[0]!.id;
    for (const [method, url, body] of [
      ["GET", `/vaults/${vaultId}`],
      ["PATCH", `/vaults/${vaultId}`, { name: "x" }],
      ["DELETE", `/vaults/${vaultId}`, { confirmName: "Note" }],
      ["GET", `/vaults/${vaultId}/files?q=`],
      ["GET", `/files/f1/versions`],
      ["GET", `/versions/v1`],
      ["GET", `/vaults/${vaultId}/trash`],
      ["GET", `/conflicts/${conflictId}`],
      ["GET", `/vaults/${vaultId}/zip`],
      ["GET", `/vaults/${vaultId}/sync-settings`],
      ["PUT", `/vaults/${vaultId}/sync-settings`, DEFAULT_SYNC_SETTINGS],
      ["GET", `/vaults/not-a-uuid`],
    ] as const) {
      const r = await t.call(luigi, method, url, body);
      expect([url, r.statusCode, r.json().error?.code]).toEqual([url, 404, "not_found"]);
    }
    expect(ConflictList.parse((await t.call(luigi, "GET", "/conflicts")).json())).toEqual([]);
    expect((await t.vaults.byId(vaultId))!.status).toBe("active");
    // Without a session: 401.
    expect((await t.call({}, "GET", `/vaults/${vaultId}`)).statusCode).toBe(401);
  });

  it("renames (re-encrypting the name) and deletes with the name as confirmation", async () => {
    const { mario, mac, vaultId } = await world();
    const before = (await t.vaults.byId(vaultId))!.nameEnc;
    const r = await t.call(mario, "PATCH", `/vaults/${vaultId}`, { name: "Diario" });
    expect(Vault.parse(r.json()).name).toBe("Diario");
    expect(Buffer.compare(before, (await t.vaults.byId(vaultId))!.nameEnc)).not.toBe(0);
    const wrong = await t.call(mario, "DELETE", `/vaults/${vaultId}`, { confirmName: "Note" });
    expect([wrong.statusCode, wrong.json().error.code]).toEqual([400, "confirm_mismatch"]);
    const ok = await t.call(mario, "DELETE", `/vaults/${vaultId}`, { confirmName: "Diario" });
    expect(ok.statusCode).toBe(204);
    expect(VaultList.parse((await t.call(mario, "GET", "/vaults")).json()).vaults).toEqual([]);
    expect((await t.call(mario, "GET", `/vaults/${vaultId}`)).statusCode).toBe(404);
    expect((await mac.call("GET", `/vaults/${vaultId}/changes?after=0`)).statusCode).toBe(401);
  });
});
