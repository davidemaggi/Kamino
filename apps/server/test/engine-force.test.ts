import { DEFAULT_SYNC_SETTINGS } from "@kamino/protocol";
import { Engine, MemoryFs } from "@kamino/sync-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login } from "./helpers/admin.js";
import { injectHttp, stillClock } from "./helpers/engine.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { linkDevice, user, type TestDevice } from "./helpers/sync.js";

let ids = 0;
const open = (app: () => FastifyInstance, d: TestDevice, fs: MemoryFs) =>
  Engine.open({
    fs,
    http: injectHttp(app),
    clock: stillClock(),
    newId: () => `fs-${Date.now().toString(36)}-${++ids}`,
    vaultId: d.vaultId,
    token: () => d.token,
    config: {
      deviceId: d.deviceId,
      platform: "macos",
      configDir: ".obsidian",
      settings: DEFAULT_SYNC_SETTINGS,
      batchSize: 50,
    },
  });

describe.skipIf(dockerUnavailable)("forced sync against the real server (ADR-0019)", () => {
  let pg: TestPostgres;
  let t: TestApp;
  beforeAll(async () => {
    pg = await startPostgres();
    t = await testApp(await pg.createDatabase("engine_force"));
  }, 120_000);
  afterAll(async () => {
    await t?.close();
    await pg?.stop();
  });

  it("the source's files win on the target; its own copy goes to the history, extras stay", async () => {
    const enroll = await user(t, "ada");
    const a = await linkDevice(t, enroll, undefined, "PC");
    const b = await linkDevice(t, enroll, a.vaultId, "iPhone");
    const fsA = new MemoryFs();
    const fsB = new MemoryFs();
    fsA.put("note.md", "v1");
    const pc = await open(() => t.app, a, fsA);
    await pc.syncNow();
    const phone = await open(() => t.app, b, fsB);
    await phone.syncNow();
    expect(fsB.text("note.md")).toBe("v1");

    // Both edit; the phone's edit lands first, the PC's becomes a conflict.
    fsB.put("note.md", "phone");
    fsB.put("extra.md", "only here");
    phone.localChange();
    await phone.syncNow();
    fsA.put("note.md", "pc");
    pc.localChange();
    await pc.syncNow();
    expect(pc.conflicts().length).toBe(1);

    await pc.forceSyncFrom([b.deviceId]);
    await pc.syncNow();
    await pc.syncNow();
    expect(pc.conflicts()).toEqual([]);
    expect(pc.forcedSync()).toBeNull();
    // A local edit the phone hasn't sent yet: it must not become the head.
    fsB.put("note.md", "phone again");
    phone.localChange();
    await phone.syncNow();
    await phone.syncNow();
    expect(fsB.text("note.md")).toBe("pc");
    expect(fsB.text("extra.md")).toBe("only here");
    expect(phone.forcedSync()).toBeNull();
    expect(phone.conflicts()).toEqual([]);
    await pc.syncNow();
    expect(fsA.text("note.md")).toBe("pc");
    expect(fsA.text("extra.md")).toBe("only here");

    const ada = await login(t, "ada");
    const state = (await t.call(ada, "GET", `/vaults/${a.vaultId}/force-sync`)).json() as {
      request: { source: { done: boolean }; targets: { done: boolean }[] };
    };
    expect(state.request.source.done).toBe(true);
    expect(state.request.targets).toEqual([expect.objectContaining({ done: true })]);
    // "phone again" is in the history of note.md.
    const found = (await t.call(ada, "GET", `/vaults/${a.vaultId}/files?q=note`)).json() as {
      files: { fileId: string }[];
    };
    const versions = JSON.stringify(
      (await t.call(ada, "GET", `/files/${found.files[0]!.fileId}/versions`)).json(),
    );
    expect(versions).toContain(`"size":${"phone again".length}`);
  });
});
