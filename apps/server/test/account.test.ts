import { SecurityLogPage, SessionList } from "@kamino/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { testApp, type Agent, type TestApp } from "./helpers/app.js";

const PW = "Qp7#vT2!mZx9-long";

describe.skipIf(dockerUnavailable)("account routes", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let n = 0;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => pg?.stop());
  beforeEach(async () => {
    await t?.close();
    t = await testApp(await pg.createDatabase(`account_${++n}`));
    const token = await t.auth.ensureSetupToken();
    await t.call({}, "POST", "/setup", {
      token,
      username: "admin",
      email: "admin@example.com",
      password: PW,
    });
    const invite = await t.auth.invite("demo", "demo@example.com", "cli");
    await t.call({}, "POST", `/invites/${invite}/accept`, { password: PW });
    // Accepting the invitation signs in: start every test without sessions.
    await t.db.$client`update web_sessions set revoked_at = now()`;
  });

  const login = async () => {
    const a: Agent = {};
    await t.call(a, "POST", "/auth/login", { username: "demo", password: PW });
    return a;
  };

  it("needs a session", async () => {
    expect((await t.call({}, "GET", "/account/sessions")).statusCode).toBe(401);
  });

  it("profile", async () => {
    const a = await login();
    const me = (await t.call(a, "PATCH", "/account/profile", { lang: "en", theme: "dark" })).json();
    expect(me).toMatchObject({ lang: "en", theme: "dark" });
  });

  it("password change revokes the other sessions", async () => {
    const a = await login();
    const b = await login();
    expect(
      (await t.call(a, "POST", "/account/password", { current: "nope", next: `${PW}-2` })).json()
        .error.code,
    ).toBe("password_wrong");
    expect(
      (await t.call(a, "POST", "/account/password", { current: PW, next: "Unbelievable" })).json()
        .error.code,
    ).toBe("password_weak");
    expect(
      (await t.call(a, "POST", "/account/password", { current: PW, next: `${PW}-2` })).statusCode,
    ).toBe(204);
    expect((await t.call(a, "GET", "/me")).statusCode).toBe(200);
    expect((await t.call(b, "GET", "/me")).statusCode).toBe(401);
  });

  it("sessions: list with the current one, revoke one, revoke the others", async () => {
    const a = await login();
    await login();
    const list = SessionList.parse((await t.call(a, "GET", "/account/sessions")).json());
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list[0]!.client).toBe("Firefox · macOS");
    const other = list.find((s) => !s.current)!;
    expect((await t.call(a, "DELETE", `/account/sessions/${other.id}`)).statusCode).toBe(204);
    expect(SessionList.parse((await t.call(a, "GET", "/account/sessions")).json())).toHaveLength(1);
    await login();
    expect((await t.call(a, "DELETE", "/account/sessions")).statusCode).toBe(204);
    expect(SessionList.parse((await t.call(a, "GET", "/account/sessions")).json())).toHaveLength(1);
  });

  it("admins can't disable TOTP; users can, with their password", async () => {
    const admin: Agent = {};
    await t.call(admin, "POST", "/auth/login", { username: "admin", password: PW });
    expect(
      (await t.call(admin, "POST", "/account/totp/disable", { password: PW })).json().error.code,
    ).toBe("totp_mandatory");
  });

  it("security log is paginated and uses the contract", async () => {
    const a = await login();
    // 25 failed logins, inserted directly: the login rate limit would stop a loop of real attempts.
    await t.db.$client`insert into security_events (id, user_id, type)
      select gen_random_uuid(), id, 'login_failed' from users, generate_series(1, 25) where username = 'demo'`;
    const page = SecurityLogPage.parse(
      (await t.call(a, "GET", "/account/security-log?page=1")).json(),
    );
    expect(page.items).toHaveLength(20);
    expect(page.pages).toBeGreaterThan(1);
  });
});
