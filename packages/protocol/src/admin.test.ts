import { describe, expect, it } from "vitest";
import {
  AdminUser,
  ConfigPatch,
  CreateUserRequest,
  ErrorCode,
  SmtpTestResult,
  SystemConfig,
  SystemHealth,
} from "./index.js";

const user = {
  id: "u1",
  username: "demo",
  email: "demo@example.com",
  role: "user",
  status: "active",
  totpEnabled: false,
  createdAt: "x",
  lastLoginAt: null,
  quotaBytes: null,
  usedBytes: 1,
  vaultCount: 2,
  deviceCount: 3,
  syncLevel: "safe",
  deletionAt: null,
};
const f = <T>(value: T, source = "ui") => ({ value, source });

describe("admin contract", () => {
  it("admin users carry only aggregates", () => {
    expect(AdminUser.parse(user).vaultCount).toBe(2);
    expect(Object.keys(AdminUser.shape)).not.toContain("vaults");
  });

  it("create user: delivery email or link", () => {
    expect(
      CreateUserRequest.safeParse({
        username: "a",
        email: "a@example.com",
        role: "user",
        delivery: "link",
      }).success,
    ).toBe(true);
    expect(
      CreateUserRequest.safeParse({
        username: "a",
        email: "a@example.com",
        role: "user",
        delivery: "password",
      }).success,
    ).toBe(false);
  });

  it("config fields know their source; the SMTP password never comes back", () => {
    const cfg = {
      registration: f("closed"),
      defaultQuotaBytes: f(null, "default"),
      maxRetentionDays: f(30),
      maxFileBytes: f(1, "env"),
      smtp: {
        host: f("smtp.example", "env"),
        port: f(587),
        security: f("starttls"),
        username: f(""),
        from: f("k@example.com"),
        allowInvalidCerts: f(false),
        passwordSet: true,
        passwordSource: "ui",
      },
      smtpConfigured: true,
    };
    expect(SystemConfig.parse(cfg).maxFileBytes.source).toBe("env");
    expect(Object.keys(SystemConfig.shape.smtp.shape)).not.toContain("password");
    expect(ConfigPatch.safeParse({ smtp: { password: "secret" } }).success).toBe(true);
    expect(ConfigPatch.safeParse({ maxRetentionDays: 120 }).success).toBe(false);
  });

  it("smtp test result and health", () => {
    expect(SmtpTestResult.parse({ ok: false, error: "535 auth failed" })).toMatchObject({
      ok: false,
    });
    const health = {
      status: "degraded",
      version: "0.0.0",
      codename: "Ash",
      uptimeSeconds: 10,
      checks: [{ name: "disk", status: "warn", value: 0.85 }],
      totals: {
        users: 5,
        vaults: 7,
        devices: 9,
        storageBytes: 1,
        devicesByLevel: { safe: 5, working: 1, attention: 2, decision: 1, blocked: 0 },
      },
    };
    expect(SystemHealth.parse(health).status).toBe("degraded");
  });

  it("new error codes", () => {
    for (const c of [
      "smtp_not_configured",
      "last_admin",
      "config_locked",
      "username_taken",
      "email_taken",
      "invalid_request",
    ])
      expect(ErrorCode.options).toContain(c);
  });
});
