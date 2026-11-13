import { LoginResponse } from "@kamino/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthError, CHALLENGE_ATTEMPTS } from "../src/auth/service.js";
import { CSRF_VALUE } from "../src/auth/http.js";
import { totpCode } from "../src/auth/totp.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { testApp, type Agent, type TestApp } from "./helpers/app.js";

const PW = "Qp7#vT2!mZx9-long";
const DAY = 86_400_000;

/** Regressions for the M1b final review. */
describe.skipIf(dockerUnavailable)("auth security", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let n = 0;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => pg?.stop());
  beforeEach(async () => {
    await t?.close();
    t = await testApp(await pg.createDatabase(`sec_${++n}`));
  });

  async function admin(agent: Agent = {}) {
    const token = await t.auth.ensureSetupToken();
    await t.call(agent, "POST", "/setup", {
      token,
      username: "admin",
      email: "admin@example.com",
      password: PW,
    });
    return agent;
  }
  async function adminWithTotp() {
    const a = await admin();
    const { secret } = (await t.call(a, "POST", "/account/totp/setup")).json() as {
      secret: string;
    };
    const step = Math.floor(t.clock.now / 30_000);
    const { recoveryCodes } = (
      await t.call(a, "POST", "/account/totp/confirm", { code: totpCode(secret, step) })
    ).json() as {
      recoveryCodes: string[];
    };
    t.clock.now += 30_000; // past the step used at confirm
    return { secret, recoveryCodes };
  }
  async function challenge(): Promise<string> {
    const r = LoginResponse.parse(
      (await t.call({}, "POST", "/auth/login", { username: "admin", password: PW })).json(),
    );
    if (r.status !== "totp_required") throw new Error("expected totp");
    return r.challengeId;
  }

  it("C1: a spoofed X-Forwarded-For does not bypass the login rate limit", async () => {
    await admin();
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await t.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { "x-requested-with": CSRF_VALUE, "x-forwarded-for": `203.0.113.${i}` },
        payload: { username: "admin", password: "nope" },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });

  it("C1: a TOTP challenge is dropped after a few wrong codes", async () => {
    await adminWithTotp();
    const id = await challenge();
    for (let i = 0; i < CHALLENGE_ATTEMPTS; i++)
      expect(
        (await t.call({}, "POST", "/auth/totp", { challengeId: id, code: "000000" })).json().error
          .code,
      ).toBe("totp_invalid");
    expect(
      (await t.call({}, "POST", "/auth/totp", { challengeId: id, code: "000000" })).json().error
        .code,
    ).toBe("challenge_expired");
  });

  it("I1/I2: the same TOTP code or recovery code can't be used twice concurrently", async () => {
    const { secret, recoveryCodes } = await adminWithTotp();
    const code = totpCode(secret, Math.floor(t.clock.now / 30_000));
    const [c1, c2] = [await challenge(), await challenge()];
    const totp = await Promise.all([
      t.call({}, "POST", "/auth/totp", { challengeId: c1, code }),
      t.call({}, "POST", "/auth/totp", { challengeId: c2, code }),
    ]);
    expect(totp.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    const [c3, c4] = [await challenge(), await challenge()];
    const rec = await Promise.all([
      t.call({}, "POST", "/auth/totp", { challengeId: c3, code: recoveryCodes[0] }),
      t.call({}, "POST", "/auth/totp", { challengeId: c4, code: recoveryCodes[0] }),
    ]);
    expect(rec.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  });

  it("I3: two concurrent setups create one admin", async () => {
    const token = await t.auth.ensureSetupToken();
    const body = (u: string) => ({ token, username: u, email: `${u}@example.com`, password: PW });
    const res = await Promise.all([
      t.call({}, "POST", "/setup", body("a1")),
      t.call({}, "POST", "/setup", body("a2")),
    ]);
    expect(res.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(await t.auth.userCount()).toBe(1);
  });

  it("I4: an admin without TOTP can only enable it (server-side)", async () => {
    const a = await admin();
    expect((await t.call(a, "GET", "/me")).statusCode).toBe(200);
    expect((await t.call(a, "GET", "/account/sessions")).json().error.code).toBe("totp_mandatory");
    expect(
      (await t.call(a, "POST", "/account/password", { current: PW, next: `${PW}-2` })).statusCode,
    ).toBe(403);
    expect((await t.call(a, "POST", "/account/totp/setup")).statusCode).toBe(200);
  });

  it("I4: right after the setup, the new admin's web app can still load (setup status)", async () => {
    const a = await admin();
    const r = await t.call(a, "GET", "/setup/status");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ needed: false });
  });

  it("I5: taken usernames and emails are 409 with their own code", async () => {
    await adminWithTotp();
    const invite = await t.auth.invite("mario", "mario@example.com", "cli");
    const m: Agent = {};
    await t.call(m, "POST", `/invites/${invite}/accept`, { password: PW });
    expect(
      (await t.call(m, "PATCH", "/account/profile", { email: "ADMIN@example.com" })).json(),
    ).toMatchObject({
      error: { code: "email_taken", retryable: false },
    });
    await expect(t.auth.invite("Mario", "other@example.com", "cli")).rejects.toMatchObject(
      new AuthError("username_taken", 409),
    );
  });

  it("expiry: reset tokens (1 h), challenges (5 min), sessions (90 days absolute)", async () => {
    const a = await admin();
    const reset = await t.auth.resetLink("admin", "cli");
    t.clock.now += 3_600_001;
    expect(
      (await t.call({}, "POST", "/auth/reset", { token: reset, password: `${PW}-x` })).json().error
        .code,
    ).toBe("token_expired");
    // Absolute expiry: active every 10 days (never idle), still out after 90 days.
    await t.call(a, "POST", "/account/totp/setup");
    for (let d = 0; d < 9; d++) {
      t.clock.now += 10 * DAY;
      expect((await t.call(a, "GET", "/me")).statusCode, `day ${(d + 1) * 10}`).toBe(
        d < 8 ? 200 : 401,
      );
    }
  });

  it("challenges expire after 5 minutes", async () => {
    const { secret } = await adminWithTotp();
    const id = await challenge();
    t.clock.now += 5 * 60_000 + 1;
    const code = totpCode(secret, Math.floor(t.clock.now / 30_000));
    expect(
      (await t.call({}, "POST", "/auth/totp", { challengeId: id, code })).json().error.code,
    ).toBe("challenge_expired");
  });

  it("CSRF on account writes; a blocked user's live session stops working", async () => {
    await adminWithTotp();
    const invite = await t.auth.invite("mario", "mario@example.com", "cli");
    const m: Agent = {};
    await t.call(m, "POST", `/invites/${invite}/accept`, { password: PW });
    const res = await t.app.inject({
      method: "PATCH",
      url: "/api/v1/account/profile",
      headers: { cookie: m.cookie! },
      payload: { lang: "en" },
    });
    expect(res.statusCode).toBe(403);
    await t.db.$client`update users set status = 'blocked' where username = 'mario'`;
    expect((await t.call(m, "GET", "/me")).statusCode).toBe(401);
  });

  it("I8: malformed bodies are invalid_request, not password_weak", async () => {
    expect((await t.call({}, "POST", "/auth/login", { username: "admin" })).json().error.code).toBe(
      "invalid_request",
    );
    expect(
      (await t.call({}, "POST", "/auth/reset", { token: "x", password: "short" })).json().error
        .code,
    ).toBe("password_weak");
  });

  it("C2: tokens in web URLs never reach the logs", async () => {
    const lines: string[] = [];
    await t.close();
    t = await testApp(await pg.createDatabase(`sec_${++n}`), {
      log: { write: (l) => void lines.push(l) },
    });
    await t.app.inject({ method: "GET", url: "/reset/SECRET-RESET-TOKEN" });
    await t.app.inject({ method: "GET", url: "/invite/SECRET-INVITE-TOKEN" });
    expect(lines.join("\n")).not.toContain("SECRET-");
  });
});
