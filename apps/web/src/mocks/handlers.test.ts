// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { api } from "../api/endpoints.js";
import { ApiError } from "../api/http.js";
import { db, resetDb, signInAs, TEST_RECOVERY_CODES, TEST_TOTP } from "./db.js";

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof ApiError ? e.code : "?"),
  );

describe("fake API", () => {
  it("setup only on an empty server, with the right token", async () => {
    expect(await api.setupStatus()).toEqual({ needed: false });
    expect(
      await code(
        api.setup({
          token: "setup-token",
          username: "x",
          email: "x@example.com",
          password: "x".repeat(12),
        }),
      ),
    ).toBe("setup_not_needed");
    resetDb("empty");
    expect(await api.setupStatus()).toEqual({ needed: true });
    expect(
      await code(
        api.setup({
          token: "wrong",
          username: "x",
          email: "x@example.com",
          password: "x".repeat(12),
        }),
      ),
    ).toBe("setup_token_invalid");
    const me = await api.setup({
      token: "setup-token",
      username: "boss",
      email: "boss@example.com",
      password: "boss-password-1",
    });
    expect(me).toMatchObject({ username: "boss", role: "admin", totpSetupRequired: true });
  });

  it("login: credentials, blocked user, TOTP and recovery codes", async () => {
    expect(await code(api.login("demo", "nope"))).toBe("invalid_credentials");
    expect(await code(api.login("ghost", "whatever"))).toBe("invalid_credentials");
    expect(await code(api.login("locked", "locked-password-1"))).toBe("user_blocked");
    expect(await api.login("demo", "demo-password-1")).toMatchObject({
      status: "ok",
      me: { username: "demo" },
    });
    const r = await api.login("admin", "admin-password-1");
    if (r.status !== "totp_required") throw new Error("expected totp");
    expect(await code(api.loginTotp(r.challengeId, "000000"))).toBe("totp_invalid");
    expect(await api.loginTotp(r.challengeId, TEST_TOTP)).toMatchObject({ username: "admin" });
    const r2 = await api.login("admin", "admin-password-1");
    if (r2.status !== "totp_required") throw new Error("expected totp");
    await api.loginTotp(r2.challengeId, TEST_RECOVERY_CODES[0]!);
    expect(db.users.find((u) => u.username === "admin")!.recoveryCodes).not.toContain(
      TEST_RECOVERY_CODES[0],
    );
  });

  it("me requires a session; logout ends it", async () => {
    expect(await code(api.me())).toBe("unauthorized");
    signInAs("demo");
    expect((await api.me()).username).toBe("demo");
    await api.logout();
    expect(await code(api.me())).toBe("unauthorized");
  });

  it("forgot gives the same answer for unknown emails", async () => {
    expect(await api.forgot("demo@example.com")).toEqual({ smtp: true });
    expect(await api.forgot("nobody@example.com")).toEqual({ smtp: true });
    db.smtp = false;
    expect(await api.forgot("nobody@example.com")).toEqual({ smtp: false });
  });

  it("reset and invite tokens", async () => {
    expect(await code(api.reset("expired-token", "new-password-123"))).toBe("token_expired");
    expect(await code(api.reset("nope", "new-password-123"))).toBe("token_invalid");
    await api.reset("reset-token", "new-password-123");
    expect(await code(api.reset("reset-token", "new-password-123"))).toBe("token_invalid");
    expect(await api.invite("invite-token")).toEqual({
      username: "invited",
      email: "invited@example.com",
    });
    expect((await api.acceptInvite("invite-token", "invited-pass-1")).username).toBe("invited");
  });

  it("account: profile, password, TOTP rules, sessions, log", async () => {
    signInAs("admin");
    expect((await api.updateProfile({ lang: "en" })).lang).toBe("en");
    expect(await code(api.changePassword("wrong", "another-pass-1"))).toBe("password_wrong");
    await api.changePassword("admin-password-1", "another-pass-1");
    expect(await code(api.totpDisable("another-pass-1"))).toBe("totp_mandatory");
    expect((await api.regenerateRecoveryCodes("another-pass-1")).recoveryCodes).toHaveLength(10);
    const sessions = await api.sessions();
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    await api.endOtherSessions();
    expect(await api.sessions()).toHaveLength(1);
    const page1 = await api.securityLog(1);
    expect(page1.items).toHaveLength(20);
    expect(page1.pages).toBeGreaterThan(1);
  });

  it("TOTP setup for an admin who must configure it", async () => {
    signInAs("newadmin");
    expect((await api.me()).totpSetupRequired).toBe(true);
    const info = await api.totpSetup();
    expect(info.otpauthUrl).toContain("otpauth://totp/");
    expect(await code(api.totpConfirm("000000"))).toBe("totp_invalid");
    expect((await api.totpConfirm(TEST_TOTP)).recoveryCodes).toHaveLength(10);
    expect(await api.me()).toMatchObject({ totpEnabled: true, totpSetupRequired: false });
  });

  it("vault summary for the status in the shell", async () => {
    signInAs("demo");
    const s = await api.vaultsSummary();
    expect(s.vaults.some((v) => v.conflicts > 0)).toBe(true);
  });
});
