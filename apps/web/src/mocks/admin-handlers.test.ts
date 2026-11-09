// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { api } from "../api/endpoints.js";
import { ApiError } from "../api/http.js";
import { ad, simulateSmtpFailure } from "./admindata.js";
import { db, signInAs } from "./db.js";

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof ApiError ? e.code : "?"),
  );
const id = (username: string) => db.users.find((u) => u.username === username)!.id;

describe("admin fake API", () => {
  it("only admins", async () => {
    signInAs("demo");
    expect(await code(api.adminUsers())).toBe("forbidden");
  });

  it("users: list, create with link or email, smtp off", async () => {
    signInAs("admin");
    expect((await api.adminUsers()).length).toBe(5);
    const r = await api.createUser({
      username: "nuovo",
      email: "nuovo@example.com",
      role: "user",
      delivery: "link",
    });
    expect(r.link).toContain("/invite/");
    expect(r.user.status).toBe("invited");
    db.smtp = false;
    expect(
      await code(
        api.createUser({
          username: "altro",
          email: "altro@example.com",
          role: "user",
          delivery: "email",
        }),
      ),
    ).toBe("smtp_not_configured");
  });

  it("quota, role, last admin, block, reset link", async () => {
    signInAs("admin");
    expect((await api.updateUser(id("demo"), { quotaBytes: 1024 })).quotaBytes).toBe(1024);
    await api.updateUser(id("newadmin"), { role: "user" });
    expect(await code(api.updateUser(id("admin"), { role: "user" }))).toBe("last_admin");
    expect((await api.blockUser(id("demo"))).status).toBe("blocked");
    expect(await code(api.blockUser(id("admin")))).toBe("forbidden");
    expect((await api.unblockUser(id("demo"))).status).toBe("active");
    expect((await api.resetLink(id("demo"))).link).toContain("/reset/");
    expect(db.users.find((u) => u.username === "demo")!.adminResetAt).not.toBeNull();
  });

  it("delete: exact username, zip only with smtp, never self", async () => {
    signInAs("admin");
    expect(await code(api.deleteUser(id("demo"), "Demo", false))).toBe("confirm_mismatch");
    expect(await code(api.deleteUser(id("admin"), "admin", false))).toBe("forbidden");
    db.smtp = false;
    expect(await code(api.deleteUser(id("demo"), "demo", true))).toBe("smtp_not_configured");
    await api.deleteUser(id("demo"), "demo", false);
    expect((await api.adminUser(id("demo"))).status).toBe("deleting");
  });

  it("config: env fields locked; password write-only; smtp test", async () => {
    signInAs("admin");
    const cfg = await api.adminConfig();
    expect(cfg.maxFileBytes.source).toBe("env");
    expect(JSON.stringify(cfg)).not.toContain("secret");
    expect(await code(api.updateConfig({ maxFileBytes: 1 }))).toBe("config_locked");
    expect(await code(api.updateConfig({ smtp: { host: "x" } }))).toBe("config_locked");
    expect(
      (await api.updateConfig({ registration: "open", smtp: { port: 465 } })).smtp.port.value,
    ).toBe(465);
    expect(await api.smtpTest()).toEqual({ ok: true });
    simulateSmtpFailure();
    expect((await api.smtpTest()).ok).toBe(false);
  });

  it("health and audit (with new entries)", async () => {
    signInAs("admin");
    expect((await api.health()).checks.some((c) => c.status === "warn")).toBe(true);
    const before = ad.audit.length;
    await api.updateUser(id("demo"), { quotaBytes: null });
    expect(ad.audit.length).toBe(before + 1);
    const page = await api.audit(1);
    expect(page.items).toHaveLength(20);
    expect(page.items[0]!.action).toBe("quota_changed");
  });
  it("create refuses duplicates and invalid bodies", async () => {
    signInAs("admin");
    expect(
      await code(
        api.createUser({
          username: "Demo",
          email: "x@example.com",
          role: "user",
          delivery: "link",
        }),
      ),
    ).toBe("username_taken");
    expect(
      await code(
        api.createUser({
          username: "x",
          email: "DEMO@example.com",
          role: "user",
          delivery: "link",
        }),
      ),
    ).toBe("email_taken");
    expect(await code(api.updateUser(id("demo"), { quotaBytes: -1 }))).toBe("invalid_request");
  });

  it("last admin counts only active admins", async () => {
    signInAs("admin");
    db.users.find((u) => u.username === "newadmin")!.locked = true;
    expect(await code(api.updateUser(id("admin"), { role: "user" }))).toBe("last_admin");
  });

  it("a user being deleted can't be unblocked or get a reset link", async () => {
    signInAs("admin");
    await api.deleteUser(id("demo"), "demo", false);
    expect(await code(api.unblockUser(id("demo")))).toBe("forbidden");
    expect(await code(api.resetLink(id("demo")))).toBe("forbidden");
  });
});
