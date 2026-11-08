import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  LoginResponse,
  Me,
  PASSWORD_MIN,
  RecoveryCodes,
  SecurityLogPage,
  SetupRequest,
  TotpConfirm,
  VaultsSummary,
} from "./index.js";

const me = {
  id: "u1",
  username: "admin",
  email: "admin@example.com",
  role: "admin",
  lang: "it",
  theme: "system",
  totpEnabled: true,
  totpSetupRequired: false,
  adminResetAt: null,
};

describe("auth contract", () => {
  it("Me accepts a valid user and rejects unknown roles", () => {
    expect(Me.parse(me)).toEqual(me);
    expect(Me.safeParse({ ...me, role: "root" }).success).toBe(false);
  });

  it("passwords need at least PASSWORD_MIN characters", () => {
    expect(PASSWORD_MIN).toBe(12);
    const base = { token: "t", username: "a", email: "a@example.com" };
    expect(SetupRequest.safeParse({ ...base, password: "x".repeat(11) }).success).toBe(false);
    expect(SetupRequest.safeParse({ ...base, password: "x".repeat(12) }).success).toBe(true);
    expect(
      SetupRequest.safeParse({ ...base, password: "x".repeat(12), email: "nope" }).success,
    ).toBe(false);
  });

  it("login answers ok or totp_required", () => {
    expect(LoginResponse.parse({ status: "ok", me })).toMatchObject({ status: "ok" });
    expect(LoginResponse.parse({ status: "totp_required", challengeId: "c" })).toMatchObject({
      status: "totp_required",
    });
    expect(LoginResponse.safeParse({ status: "maybe" }).success).toBe(false);
  });

  it("TOTP confirm takes 6 digits; recovery codes are exactly 10", () => {
    expect(TotpConfirm.safeParse({ code: "123456" }).success).toBe(true);
    expect(TotpConfirm.safeParse({ code: "12345a" }).success).toBe(false);
    expect(RecoveryCodes.safeParse({ recoveryCodes: Array(10).fill("AAAA-1111") }).success).toBe(
      true,
    );
    expect(RecoveryCodes.safeParse({ recoveryCodes: Array(9).fill("AAAA-1111") }).success).toBe(
      false,
    );
  });

  it("security log pages and vault summary", () => {
    expect(
      SecurityLogPage.safeParse({
        items: [{ id: "e", type: "login", at: "2026-11-08T10:00:00Z" }],
        page: 1,
        pages: 1,
      }).success,
    ).toBe(true);
    expect(
      SecurityLogPage.safeParse({ items: [{ id: "e", type: "hack", at: "x" }], page: 1, pages: 1 })
        .success,
    ).toBe(false);
    expect(
      VaultsSummary.safeParse({
        vaults: [{ id: "v", name: "Note", level: "decision", conflicts: 2 }],
      }).success,
    ).toBe(true);
  });

  it("error catalogue has the auth codes", () => {
    for (const c of [
      "invalid_credentials",
      "totp_invalid",
      "challenge_expired",
      "setup_not_needed",
      "setup_token_invalid",
      "token_invalid",
      "token_expired",
      "password_weak",
      "password_wrong",
      "totp_mandatory",
      "forbidden",
    ]) {
      expect(ErrorCode.options).toContain(c);
    }
  });
});
