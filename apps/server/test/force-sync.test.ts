import { ForcedResponse, ForceSyncResponse } from "@kamino/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { login } from "./helpers/admin.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { linkDevice, user, type TestDevice } from "./helpers/sync.js";

const forced = async (d: TestDevice) =>
  ForcedResponse.parse((await d.call("GET", "/vault/force-sync")).json()).forced;
const changes = async (d: TestDevice) =>
  (
    (await d.call("GET", `/vaults/${d.vaultId}/changes?after=0`)).json() as {
      entries: { type: string; fileId: string; deviceId: string; ignorable?: boolean }[];
    }
  ).entries;

describe.skipIf(dockerUnavailable)("forced sync (ADR-0019)", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let pc: TestDevice;
  let phone: TestDevice;
  let tablet: TestDevice;
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
    t = await testApp(await pg.createDatabase(`force_${++n}`));
    const enroll = await user(t, "ada");
    pc = await linkDevice(t, enroll, undefined, "PC");
    phone = await linkDevice(t, enroll, pc.vaultId, "iPhone");
    tablet = await linkDevice(t, enroll, pc.vaultId, "iPad");
  });

  it("source first, then the targets; each reports done", async () => {
    const r = await phone.call("POST", "/vault/force-sync", {
      sourceDeviceId: pc.deviceId,
      targetDeviceIds: [phone.deviceId, tablet.deviceId],
    });
    expect(r.statusCode).toBe(200);
    const req = ForceSyncResponse.parse(r.json()).request!;
    expect(req.source).toEqual({ id: pc.deviceId, name: "PC", done: false });
    expect(await forced(pc)).toEqual({ requestId: req.id, role: "source" });
    // Targets wait for the source.
    expect(await forced(phone)).toBeNull();
    expect(await changes(pc)).toEqual([
      expect.objectContaining({
        type: "force_push",
        fileId: req.id,
        deviceId: pc.deviceId,
        ignorable: true,
      }),
    ]);

    const done = (d: TestDevice, role: string) =>
      d.call("POST", `/vault/force-sync/${req.id}/done`, { role });
    expect((await done(pc, "source")).statusCode).toBe(204);
    expect((await done(pc, "source")).statusCode).toBe(204); // idempotent
    expect(await forced(pc)).toBeNull();
    expect(await forced(phone)).toEqual({ requestId: req.id, role: "target" });
    const realign = (await changes(pc)).filter((e) => e.type === "realign");
    expect(realign.map((e) => e.deviceId).sort()).toEqual([phone.deviceId, tablet.deviceId].sort());

    await done(phone, "target");
    expect(await forced(phone)).toBeNull();
    expect(await forced(tablet)).toEqual({ requestId: req.id, role: "target" });
  });

  it("from the web app, own vaults only; a new request replaces the old one", async () => {
    const ada = await login(t, "ada");
    const body = { sourceDeviceId: phone.deviceId, targetDeviceIds: [pc.deviceId] };
    const first = ForceSyncResponse.parse(
      (await t.call(ada, "POST", `/vaults/${pc.vaultId}/force-sync`, body)).json(),
    ).request!;
    const second = ForceSyncResponse.parse(
      (
        await t.call(ada, "POST", `/vaults/${pc.vaultId}/force-sync`, {
          sourceDeviceId: pc.deviceId,
          targetDeviceIds: [tablet.deviceId],
        })
      ).json(),
    ).request!;
    expect(second.id).not.toBe(first.id);
    expect(await forced(phone)).toBeNull();
    expect(await forced(pc)).toEqual({ requestId: second.id, role: "source" });
    const got = ForceSyncResponse.parse(
      (await t.call(ada, "GET", `/vaults/${pc.vaultId}/force-sync`)).json(),
    ).request!;
    expect(got.targets).toEqual([{ id: tablet.deviceId, name: "iPad", done: false }]);

    await user(t, "bob");
    const bob = await login(t, "bob");
    expect((await t.call(bob, "POST", `/vaults/${pc.vaultId}/force-sync`, body)).statusCode).toBe(
      404,
    );
    expect((await t.call(bob, "GET", `/vaults/${pc.vaultId}/force-sync`)).statusCode).toBe(404);
  });

  it("rejects devices of other vaults, revoked ones and the source as a target", async () => {
    const other = await linkDevice(t, await user(t, "bob"), undefined, "Bob");
    const post = (body: unknown) => pc.call("POST", "/vault/force-sync", body);
    expect(
      (await post({ sourceDeviceId: pc.deviceId, targetDeviceIds: [other.deviceId] })).statusCode,
    ).toBe(400);
    expect(
      (await post({ sourceDeviceId: pc.deviceId, targetDeviceIds: [pc.deviceId] })).statusCode,
    ).toBe(400);
    const ada = await login(t, "ada");
    await t.call(ada, "POST", `/devices/${tablet.deviceId}/revoke`);
    expect(
      (await post({ sourceDeviceId: pc.deviceId, targetDeviceIds: [tablet.deviceId] })).statusCode,
    ).toBe(400);
  });
});
