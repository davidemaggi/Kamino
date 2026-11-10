import { Device, DeviceList } from "@kamino/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { testApp, type Agent, type TestApp } from "./helpers/app.js";
import { linkDevice, putFile, PW, user, type TestDevice } from "./helpers/sync.js";
import { hello } from "./helpers/ws.js";

describe.skipIf(dockerUnavailable)("devices", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let a: TestDevice;
  let b: TestDevice;
  let web: Agent;
  let n = 0;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => pg?.stop());
  beforeEach(async () => {
    await t?.close();
    t = await testApp(await pg.createDatabase(`devices_${++n}`));
    const enroll = await user(t, "mario");
    a = await linkDevice(t, enroll, undefined, "Mac");
    b = await linkDevice(t, enroll, a.vaultId, "iPhone");
    web = {};
    await t.call(web, "POST", "/auth/login", { username: "mario", password: PW });
  });

  it("the web list follows the contract: lag, pending, level", async () => {
    await putFile(a, "a.md");
    await a.call("POST", `/vaults/${a.vaultId}/ack`, { seq: 1 });
    await b.call("POST", `/vaults/${a.vaultId}/status`, {
      pendingOps: 4,
      pendingBytes: 10,
      deferredFiles: 0,
    });
    const list = DeviceList.parse((await t.call(web, "GET", "/devices")).json());
    const byName = Object.fromEntries(list.map((d) => [d.name, d]));
    expect(byName["Mac"]).toMatchObject({
      vaultId: a.vaultId,
      vaultName: "Note",
      platform: "macos",
      lag: 0,
      pending: 0,
      level: "safe",
      revoked: false,
    });
    expect(byName["iPhone"]).toMatchObject({ lag: 1, pending: 4, level: "working" });
    const one = Device.parse((await t.call(web, "GET", `/devices/${b.deviceId}`)).json());
    expect(one.id).toBe(b.deviceId);
  });

  it("rename and revoke from the web; the revoked device is cut off everywhere", async () => {
    const renamed = await t.call(web, "PATCH", `/devices/${b.deviceId}`, { name: "Phone" });
    expect(Device.parse(renamed.json()).name).toBe("Phone");
    const ws = await t.ws();
    ws.send(hello(b.token));
    await ws.next("welcome");
    const revoked = await t.call(web, "POST", `/devices/${b.deviceId}/revoke`);
    expect(Device.parse(revoked.json())).toMatchObject({ revoked: true, level: "blocked" });
    await ws.next("device_revoked");
    expect((await ws.closed()).code).toBe(4403);
    expect((await b.call("GET", "/device")).json().error.code).toBe("device_revoked");
    // Idempotent, and visible in the list.
    expect((await t.call(web, "POST", `/devices/${b.deviceId}/revoke`)).statusCode).toBe(200);
    const list = DeviceList.parse((await t.call(web, "GET", "/devices")).json());
    expect(list.find((d) => d.id === b.deviceId)).toMatchObject({
      revoked: true,
      level: "blocked",
    });
  });

  it("unlinking from the plugin closes the device's other sockets", async () => {
    const ws = await t.ws();
    ws.send(hello(b.token));
    await ws.next("welcome");
    expect((await b.call("DELETE", "/device")).statusCode).toBe(204);
    await ws.next("device_revoked");
  });

  it("the plugin sees itself and its vault's devices only", async () => {
    expect(Device.parse((await a.call("GET", "/device")).json()).name).toBe("Mac");
    const other = await linkDevice(t, await user(t, "luigi"));
    const mine = DeviceList.parse((await a.call("GET", "/vault/devices")).json());
    expect(mine.map((d) => d.name).sort()).toEqual(["Mac", "iPhone"]);
    expect(mine.some((d) => d.id === other.deviceId)).toBe(false);
  });

  it("another user's devices are not found, admin included", async () => {
    const other = await linkDevice(t, await user(t, "luigi"));
    await t.db
      .$client`update users set role = 'admin', totp_enabled_at = now() where username = 'mario'`;
    expect((await t.call(web, "GET", `/devices/${other.deviceId}`)).statusCode).toBe(404);
    expect(
      (await t.call(web, "PATCH", `/devices/${other.deviceId}`, { name: "x" })).statusCode,
    ).toBe(404);
    expect((await t.call(web, "POST", `/devices/${other.deviceId}/revoke`)).statusCode).toBe(404);
    const list = DeviceList.parse((await t.call(web, "GET", "/devices")).json());
    expect(list.some((d) => d.id === other.deviceId)).toBe(false);
    expect((await t.call({}, "GET", "/devices")).statusCode).toBe(401);
  });
});
