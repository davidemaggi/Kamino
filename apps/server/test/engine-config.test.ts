import { DEFAULT_SYNC_SETTINGS } from "@kamino/protocol";
import { Engine, MemoryFs } from "@kamino/sync-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { injectHttp, stillClock } from "./helpers/engine.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { linkDevice, user, type TestDevice } from "./helpers/sync.js";

const settings = {
  ...DEFAULT_SYNC_SETTINGS,
  config: { base: true, appearance: true, hotkeys: true, pluginList: true, plugins: true },
};
let ids = 0;
const open = (app: () => FastifyInstance, d: TestDevice, fs: MemoryFs) =>
  Engine.open({
    fs,
    http: injectHttp(app),
    clock: stillClock(),
    newId: () => `cfg-${Date.now().toString(36)}-${++ids}`,
    vaultId: d.vaultId,
    token: () => d.token,
    config: {
      deviceId: d.deviceId,
      platform: "ios",
      configDir: ".obsidian",
      settings,
      batchSize: 50,
    },
  });

// rc.8: phones rewrote app.json as {} on old bases; every put opened a conflict that came back
// as soon as it was resolved.
describe.skipIf(dockerUnavailable)("configuration files against the real server", () => {
  let pg: TestPostgres;
  let t: TestApp;
  beforeAll(async () => {
    pg = await startPostgres();
    t = await testApp(await pg.createDatabase("engine_config"));
  }, 120_000);
  afterAll(async () => {
    await t?.close();
    await pg?.stop();
  });

  it("the same content written on two devices is no conflict", async () => {
    const enroll = await user(t, "ada");
    const a = await linkDevice(t, enroll, undefined, "PC");
    const b = await linkDevice(t, enroll, a.vaultId, "iPhone");
    const fsA = new MemoryFs();
    const fsB = new MemoryFs();
    fsA.put(".obsidian/app.json", '{"pc":true}');
    const pc = await open(() => t.app, a, fsA);
    await pc.syncNow();
    const phone = await open(() => t.app, b, fsB);
    await phone.syncNow();
    fsA.put(".obsidian/app.json", "{}");
    pc.localChange();
    await pc.syncNow();
    fsB.put(".obsidian/app.json", "{}");
    phone.localChange();
    await phone.syncNow();
    expect(phone.conflicts()).toEqual([]);
    fsB.put(".obsidian/app.json", '{"phone":true}');
    phone.localChange();
    await phone.syncNow();
    await pc.syncNow();
    expect(phone.conflicts()).toEqual([]);
    expect(pc.conflicts()).toEqual([]);
    expect(fsA.text(".obsidian/app.json")).toBe('{"phone":true}');
  });
});
