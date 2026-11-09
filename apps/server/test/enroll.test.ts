import { DeviceLoginResponse, EnrollVaultList, LinkDeviceResponse } from "@kamino/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { totpCode } from "../src/auth/totp.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { linkDevice, PW, raw, user } from "./helpers/sync.js";

describe.skipIf(dockerUnavailable)("device enrollment", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let n = 0;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => pg?.stop());
  beforeEach(async () => {
    await t?.close();
    t = await testApp(await pg.createDatabase(`enroll_${++n}`));
  });

  it("login → vault → device; the first device is the origin", async () => {
    const enroll = await user(t, "mario");
    const auth = { authorization: `Bearer ${enroll}` };
    expect(
      EnrollVaultList.parse((await raw(t, "GET", "/enroll/vaults", undefined, auth)).json()).vaults,
    ).toEqual([]);
    const d1 = await linkDevice(t, enroll);
    const list = EnrollVaultList.parse(
      (await raw(t, "GET", "/enroll/vaults", undefined, auth)).json(),
    ).vaults;
    expect(list).toEqual([{ id: d1.vaultId, name: "Note", fileCount: 0, deviceCount: 1 }]);
    const r = await raw(
      t,
      "POST",
      `/enroll/vaults/${d1.vaultId}/devices`,
      { name: "iPhone", platform: "ios", pluginVersion: "0.1.0", protocolVersion: 1 },
      auth,
    );
    expect(LinkDeviceResponse.parse(r.json()).vault.name).toBe("Note");
    const rows = await t.db.$client<
      { is_origin: boolean; name: string }[]
    >`select is_origin, name from devices order by created_at`;
    expect(rows.map((x) => x.is_origin)).toEqual([true, false]);
  });

  it("TOTP in the same request; wrong code refused", async () => {
    const enroll = await user(t, "mario");
    void enroll;
    const u = (await t.auth.byUsername("mario"))!;
    const { secret } = await t.auth.totpSetup(u);
    const step = Math.floor(t.clock.now / 30_000);
    await t.auth.totpConfirm((await t.auth.byUsername("mario"))!, totpCode(secret, step), {
      ip: undefined,
      userAgent: undefined,
    });
    t.clock.now += 30_000;
    expect(
      DeviceLoginResponse.parse(
        (await raw(t, "POST", "/devices/login", { username: "mario", password: PW })).json(),
      ),
    ).toEqual({ status: "totp_required" });
    expect(
      (
        await raw(t, "POST", "/devices/login", { username: "mario", password: PW, totp: "000000" })
      ).json().error.code,
    ).toBe("totp_invalid");
    const ok = DeviceLoginResponse.parse(
      (
        await raw(t, "POST", "/devices/login", {
          username: "mario",
          password: PW,
          totp: totpCode(secret, step + 1),
        })
      ).json(),
    );
    expect(ok.status).toBe("ok");
  });

  it("enrollment tokens expire after 10 minutes", async () => {
    const enroll = await user(t, "mario");
    t.clock.now += 11 * 60_000;
    expect(
      (
        await raw(t, "GET", "/enroll/vaults", undefined, { authorization: `Bearer ${enroll}` })
      ).json().error.code,
    ).toBe("token_expired");
  });

  it("isolation: another user's vault, revoked devices, blocked users, protocol version", async () => {
    const d = await linkDevice(t, await user(t, "mario"));
    const other = await user(t, "luigi");
    const r = await raw(
      t,
      "POST",
      `/enroll/vaults/${d.vaultId}/devices`,
      { name: "X", platform: "linux", pluginVersion: "0", protocolVersion: 1 },
      { authorization: `Bearer ${other}` },
    );
    expect(r.json().error.code).toBe("not_found");
    expect((await d.call("PATCH", "/device", { name: "Mac mini" })).statusCode).toBe(204);
    expect(
      (await d.call("PATCH", "/device", { name: "x" }, { "kamino-protocol": "99" })).statusCode,
    ).toBe(426);
    await t.db.$client`update users set status = 'blocked' where username = 'mario'`;
    expect((await d.call("PATCH", "/device", { name: "y" })).json().error.code).toBe(
      "user_blocked",
    );
    await t.db.$client`update users set status = 'active' where username = 'mario'`;
    expect((await d.call("DELETE", "/device")).statusCode).toBe(204);
    expect((await d.call("PATCH", "/device", { name: "z" })).json().error.code).toBe(
      "device_revoked",
    );
  });
});
