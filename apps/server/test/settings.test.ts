import { DEFAULT_SYNC_SETTINGS, DeviceSettings, SyncSettings } from "@kamino/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { linkDevice, user, type TestDevice } from "./helpers/sync.js";
import { hello } from "./helpers/ws.js";

const custom: SyncSettings = {
  config: { base: true, appearance: true, hotkeys: false, pluginList: false, plugins: false },
  patterns: ["Segreti/**", ".trash/**"],
};

describe.skipIf(dockerUnavailable)("sync settings", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let a: TestDevice;
  let b: TestDevice;
  let n = 0;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => pg?.stop());
  beforeEach(async () => {
    await t?.close();
    t = await testApp(await pg.createDatabase(`settings_${++n}`));
    const enroll = await user(t, "mario");
    a = await linkDevice(t, enroll);
    b = await linkDevice(t, enroll, a.vaultId, "iPhone");
  });

  it("S-10 defaults until the vault has settings", async () => {
    expect(SyncSettings.parse((await a.call("GET", "/vault/settings")).json())).toEqual(
      DEFAULT_SYNC_SETTINGS,
    );
    expect(DeviceSettings.parse((await a.call("GET", "/device/settings")).json())).toEqual({
      override: null,
      effective: DEFAULT_SYNC_SETTINGS,
    });
  });

  it("changing the vault defaults reaches the other devices: journal entry and websocket", async () => {
    const ws = await t.ws();
    ws.send(hello(b.token));
    await ws.next("welcome");
    expect((await a.call("PUT", "/vault/settings", custom)).statusCode).toBe(200);
    const page = await ws.next("changes");
    expect(page.entries).toMatchObject([
      { seq: 1, type: "vault_settings_changed", fileId: "_vault", path: "_vault", ignorable: true },
    ]);
    expect((await ws.next("vault_settings_changed")).settings).toEqual(custom);
    expect(SyncSettings.parse((await b.call("GET", "/vault/settings")).json())).toEqual(custom);
    // A device without an override follows the defaults.
    expect(
      DeviceSettings.parse((await b.call("GET", "/device/settings")).json()).effective,
    ).toEqual(custom);
    ws.close();
  });

  it("a device override wins until it is cleared", async () => {
    const mine: SyncSettings = { ...DEFAULT_SYNC_SETTINGS, patterns: ["big/**"] };
    const set = await b.call("PUT", "/device/settings", { override: mine });
    expect(DeviceSettings.parse(set.json())).toEqual({ override: mine, effective: mine });
    await a.call("PUT", "/vault/settings", custom);
    expect(
      DeviceSettings.parse((await b.call("GET", "/device/settings")).json()).effective,
    ).toEqual(mine);
    // Only that device: the other one still follows the vault.
    expect(
      DeviceSettings.parse((await a.call("GET", "/device/settings")).json()).effective,
    ).toEqual(custom);
    await b.call("PUT", "/device/settings", { override: null });
    expect(DeviceSettings.parse((await b.call("GET", "/device/settings")).json())).toEqual({
      override: null,
      effective: custom,
    });
  });

  it("encrypted at rest and validated", async () => {
    await a.call("PUT", "/vault/settings", custom);
    await b.call("PUT", "/device/settings", { override: custom });
    const rows = [
      ...(await t.db.$client<{ s: Buffer | null }[]>`select settings_enc as s from vaults`),
      ...(await t.db.$client<
        { s: Buffer | null }[]
      >`select settings_override_enc as s from devices`),
    ];
    const dump = rows.map((r) => r.s?.toString("latin1") ?? "").join("|");
    expect(dump.length).toBeGreaterThan(50);
    expect(dump).not.toContain("Segreti");
    const bad = await a.call("PUT", "/vault/settings", { ...custom, patterns: ["x".repeat(501)] });
    expect(bad.statusCode).toBe(400);
  });
});
