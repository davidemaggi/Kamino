import { LoginResponse, Me, SetupStatus } from "@kamino/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { totpCode } from "../src/auth/totp.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { testApp, type Agent, type TestApp } from "./helpers/app.js";

const PW = "Qp7#vT2!mZx9-long";

describe.skipIf(dockerUnavailable)("auth routes", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let n = 0;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => pg?.stop());
  beforeEach(async () => {
    await t?.close();
    t = await testApp(await pg.createDatabase(`auth_${++n}`));
  });

  async function setupAdmin(agent: Agent) {
    const token = await t.auth.ensureSetupToken();
    return t.call(agent, "POST", "/setup", {
      token,
      username: "admin",
      email: "admin@example.com",
      password: PW,
    });
  }

  it("setup once, with the token; the admin must configure TOTP", async () => {
    const a: Agent = {};
    expect(SetupStatus.parse((await t.call(a, "GET", "/setup/status")).json())).toEqual({
      needed: true,
    });
    expect(
      (
        await t.call(a, "POST", "/setup", {
          token: "wrong",
          username: "x",
          email: "x@example.com",
          password: PW,
        })
      ).json().error.code,
    ).toBe("setup_token_invalid");
    const res = await setupAdmin(a);
    expect(res.statusCode).toBe(200);
    expect(Me.parse(res.json())).toMatchObject({ role: "admin", totpSetupRequired: true });
    expect(res.cookies.find((c) => c.name.endsWith("_session"))).toMatchObject({
      httpOnly: true,
      sameSite: "Lax",
    });
    expect((await t.call(a, "GET", "/me")).statusCode).toBe(200);
    const again = await t.call({}, "POST", "/setup", {
      token: "anything",
      username: "x",
      email: "x@example.com",
      password: PW,
    });
    expect(again.json().error.code).toBe("setup_not_needed");
  });

  it("writes need the CSRF header", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "a", password: "b" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("login: wrong password, success, logout", async () => {
    await setupAdmin({});
    const a: Agent = {};
    expect(
      (await t.call(a, "POST", "/auth/login", { username: "admin", password: "nope" })).json().error
        .code,
    ).toBe("invalid_credentials");
    expect(
      (await t.call(a, "POST", "/auth/login", { username: "ghost", password: "nope" })).json().error
        .code,
    ).toBe("invalid_credentials");
    const ok = LoginResponse.parse(
      (await t.call(a, "POST", "/auth/login", { username: "ADMIN", password: PW })).json(),
    );
    expect(ok.status).toBe("ok");
    expect((await t.call(a, "POST", "/auth/logout")).statusCode).toBe(204);
    expect((await t.call(a, "GET", "/me")).statusCode).toBe(401);
  });

  it("TOTP: setup, confirm, login with a code (no replay) and with a recovery code (single use)", async () => {
    const a: Agent = {};
    await setupAdmin(a);
    const { secret } = (await t.call(a, "POST", "/account/totp/setup")).json() as {
      secret: string;
    };
    const step = Math.floor(t.clock.now / 30_000);
    const { recoveryCodes } = (
      await t.call(a, "POST", "/account/totp/confirm", { code: totpCode(secret, step) })
    ).json() as { recoveryCodes: string[] };
    expect(recoveryCodes).toHaveLength(10);
    const b: Agent = {};
    const ch = LoginResponse.parse(
      (await t.call(b, "POST", "/auth/login", { username: "admin", password: PW })).json(),
    );
    if (ch.status !== "totp_required") throw new Error("expected totp");
    expect(
      (
        await t.call(b, "POST", "/auth/totp", {
          challengeId: ch.challengeId,
          code: totpCode(secret, step),
        })
      ).json().error.code,
    ).toBe("totp_invalid"); // replay
    t.clock.now += 30_000;
    expect(
      (
        await t.call(b, "POST", "/auth/totp", {
          challengeId: ch.challengeId,
          code: totpCode(secret, step + 1),
        })
      ).statusCode,
    ).toBe(200);
    const c: Agent = {};
    const ch2 = LoginResponse.parse(
      (await t.call(c, "POST", "/auth/login", { username: "admin", password: PW })).json(),
    );
    if (ch2.status !== "totp_required") throw new Error("expected totp");
    expect(
      (
        await t.call(c, "POST", "/auth/totp", {
          challengeId: ch2.challengeId,
          code: recoveryCodes[0],
        })
      ).statusCode,
    ).toBe(200);
    const ch3 = LoginResponse.parse(
      (await t.call({}, "POST", "/auth/login", { username: "admin", password: PW })).json(),
    );
    if (ch3.status !== "totp_required") throw new Error("expected totp");
    expect(
      (
        await t.call({}, "POST", "/auth/totp", {
          challengeId: ch3.challengeId,
          code: recoveryCodes[0],
        })
      ).json().error.code,
    ).toBe("totp_invalid");
  });

  it("blocked users and expired sessions", async () => {
    const a: Agent = {};
    await setupAdmin(a);
    t.clock.now += 15 * 86_400_000; // idle > 14 days
    expect((await t.call(a, "GET", "/me")).statusCode).toBe(401);
    await t.db.$client`update users set status = 'blocked'`;
    expect(
      (await t.call({}, "POST", "/auth/login", { username: "admin", password: PW })).json().error
        .code,
    ).toBe("user_blocked");
  });

  it("reset and invitations (tokens from the CLI service)", async () => {
    await setupAdmin({});
    const reset = await t.auth.resetLink("admin", "cli");
    expect(
      (await t.call({}, "POST", "/auth/reset", { token: reset, password: "short" })).statusCode,
    ).toBe(400);
    expect(
      (await t.call({}, "POST", "/auth/reset", { token: reset, password: `${PW}-new` })).statusCode,
    ).toBe(204);
    expect(
      (await t.call({}, "POST", "/auth/reset", { token: reset, password: `${PW}-new` })).json()
        .error.code,
    ).toBe("token_invalid");
    const invite = await t.auth.invite("mario", "mario@example.com", "cli");
    expect((await t.call({}, "GET", `/invites/${invite}`)).json()).toEqual({
      username: "mario",
      email: "mario@example.com",
    });
    const a: Agent = {};
    expect(
      Me.parse((await t.call(a, "POST", `/invites/${invite}/accept`, { password: PW })).json())
        .username,
    ).toBe("mario");
    expect(
      (await t.call({}, "POST", "/auth/forgot", { email: "mario@example.com" })).json(),
    ).toEqual({ smtp: false });
  });

  it("rate limit on login", async () => {
    await setupAdmin({});
    let last = 0;
    for (let i = 0; i < 12; i++)
      last = (await t.call({}, "POST", "/auth/login", { username: "admin", password: "nope" }))
        .statusCode;
    expect(last).toBe(429);
  });
  it("HTTPS public URL: the session cookie is Secure", async () => {
    await t.close();
    t = await testApp(await pg.createDatabase(`auth_${++n}`), {
      publicUrl: "https://kamino.example",
    });
    const res = await setupAdmin({});
    expect(res.cookies.find((c) => c.name.endsWith("_session"))).toMatchObject({
      secure: true,
      httpOnly: true,
    });
  });

  it("logs never contain passwords, session tokens or TOTP secrets", async () => {
    const lines: string[] = [];
    await t.close();
    t = await testApp(await pg.createDatabase(`auth_${++n}`), {
      log: { write: (l) => void lines.push(l) },
    });
    const a: Agent = {};
    await setupAdmin(a);
    const { secret } = (await t.call(a, "POST", "/account/totp/setup")).json() as {
      secret: string;
    };
    await t.call({}, "POST", "/auth/login", { username: "admin", password: "wrong-password-x" });
    await t.call(a, "GET", "/me");
    const invite = await t.auth.invite("mario", "mario@example.com", "cli");
    await t.call({}, "GET", `/invites/${invite}`);
    await t.call({}, "POST", `/invites/${invite}/accept`, { password: PW });
    const all = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const secretValue of [PW, "wrong-password-x", secret, a.cookie!.split("=")[1]!, invite])
      expect(all).not.toContain(secretValue);
  });
});
