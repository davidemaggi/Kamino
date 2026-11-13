import {
  AdminUser,
  AdminUserList,
  AuditPage,
  CreateUserResponse,
  SystemConfig,
  SystemHealth,
} from "@kamino/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { totpCode } from "../src/auth/totp.js";
import type { SystemEnv } from "../src/config/schema.js";
import { testApp, type Agent, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { linkDevice, putFile, user } from "./helpers/sync.js";
import { hello } from "./helpers/ws.js";

const PW = "Qp7#vT2!mZx9-long";
const SMTP = { smtp: { host: "smtp.example.com", from: "noreply@example.com" } };

describe.skipIf(dockerUnavailable)("admin routes", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let n = 0;
  let admin: Agent;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => {
    await t?.close();
    await pg?.stop();
  });

  async function fresh(system?: SystemEnv) {
    await t?.close();
    t = await testApp(await pg.createDatabase(`admin_${++n}`), system ? { system } : {});
    admin = {};
    await t.call(admin, "POST", "/setup", {
      token: await t.auth.ensureSetupToken(),
      username: "root",
      email: "root@example.com",
      password: PW,
    });
    const { secret } = (await t.call(admin, "POST", "/account/totp/setup")).json() as {
      secret: string;
    };
    const r = await t.call(admin, "POST", "/account/totp/confirm", {
      code: totpCode(secret, Math.floor(t.clock.now / 30_000)),
    });
    expect(r.statusCode).toBe(200);
  }
  beforeEach(() => fresh());

  async function login(username: string): Promise<Agent> {
    const a: Agent = {};
    const r = await t.call(a, "POST", "/auth/login", { username, password: PW });
    expect(r.statusCode).toBe(200);
    return a;
  }
  const idOf = async (username: string) => (await t.auth.byUsername(username))!.id;
  const codeOf = (r: { json(): unknown }) => (r.json() as { error: { code: string } }).error.code;

  it("only admins with TOTP get in: 401 signed out, 403 for users and admins without TOTP", async () => {
    expect((await t.call({}, "GET", "/admin/users")).statusCode).toBe(401);
    await user(t, "mario");
    const mario = await login("mario");
    const r = await t.call(mario, "GET", "/admin/users");
    expect([r.statusCode, codeOf(r)]).toEqual([403, "forbidden"]);
    // A second admin who hasn't enabled TOTP yet is stopped before any admin route.
    await t.call(admin, "PATCH", `/admin/users/${await idOf("mario")}`, { role: "admin" });
    const r2 = await t.call(await login("mario"), "GET", "/admin/health");
    expect(r2.statusCode).toBe(403);
    for (const path of ["/admin/users", "/admin/config", "/admin/health", "/admin/audit"])
      expect((await t.call(admin, "GET", path)).statusCode).toBe(200);
  });

  it("creates users with a link (no SMTP) and refuses email delivery without SMTP", async () => {
    const r = await t.call(admin, "POST", "/admin/users", {
      username: "anna",
      email: "anna@example.com",
      role: "user",
      delivery: "link",
    });
    expect(r.statusCode).toBe(200);
    const body = CreateUserResponse.parse(r.json());
    expect(body.user).toMatchObject({ username: "anna", status: "invited", role: "user" });
    expect(body.link).toMatch(/^http:\/\/localhost:8080\/invite\/[\w-]+$/);
    const token = body.link!.split("/").pop()!;
    expect((await t.call({}, "GET", `/invites/${token}`)).statusCode).toBe(200);
    const dup = await t.call(admin, "POST", "/admin/users", {
      username: "ANNA",
      email: "x@example.com",
      role: "user",
      delivery: "link",
    });
    expect([dup.statusCode, codeOf(dup)]).toEqual([409, "username_taken"]);
    const mail = await t.call(admin, "POST", "/admin/users", {
      username: "bea",
      email: "bea@example.com",
      role: "user",
      delivery: "email",
    });
    expect([mail.statusCode, codeOf(mail)]).toEqual([409, "smtp_not_configured"]);
    expect(await t.auth.byUsername("bea")).toBeUndefined();
    const audit = AuditPage.parse((await t.call(admin, "GET", "/admin/audit")).json());
    expect(audit.items[0]).toMatchObject({ actor: "root", action: "user_created", target: "anna" });
  });

  it("with SMTP the invitation goes by email and no link comes back", async () => {
    await fresh(SMTP);
    const r = await t.call(admin, "POST", "/admin/users", {
      username: "bea",
      email: "bea@example.com",
      role: "admin",
      delivery: "email",
    });
    expect(CreateUserResponse.parse(r.json())).toMatchObject({
      link: null,
      user: { role: "admin", status: "invited" },
    });
    await t.outbox.drain();
    expect(t.mail).toHaveLength(1);
    expect(t.mail[0]!.to).toBe("bea@example.com");
    expect(t.mail[0]!.text).toMatch(/\/invite\/[\w-]+/);
    const audit = AuditPage.parse((await t.call(admin, "GET", "/admin/audit")).json());
    expect(audit.items[0]).toMatchObject({ action: "user_invited", target: "bea" });
  });

  it("role and quota changes are audited; the last active admin can't be demoted", async () => {
    await user(t, "mario");
    const id = await idOf("mario");
    const rootId = await idOf("root");
    const last = await t.call(admin, "PATCH", `/admin/users/${rootId}`, { role: "user" });
    expect([last.statusCode, codeOf(last)]).toEqual([409, "last_admin"]);
    const r = await t.call(admin, "PATCH", `/admin/users/${id}`, { quotaBytes: 5000 });
    expect(AdminUser.parse(r.json()).quotaBytes).toBe(5000);
    // An admin that is blocked doesn't count: root stays the last active one.
    await t.call(admin, "PATCH", `/admin/users/${id}`, { role: "admin" });
    await t.call(admin, "POST", `/admin/users/${id}/block`);
    expect(
      (await t.call(admin, "PATCH", `/admin/users/${rootId}`, { role: "user" })).statusCode,
    ).toBe(409);
    const audit = AuditPage.parse((await t.call(admin, "GET", "/admin/audit")).json());
    expect(audit.items.map((i) => [i.action, i.target])).toEqual([
      ["user_blocked", "mario"],
      ["role_changed", "mario: user → admin"],
      ["quota_changed", "mario: none → 5000"],
      ["user_invited", "mario"],
    ]);
    // Without a quota of their own, the user sees the system default as their limit.
    await t.call(admin, "PATCH", "/admin/config", { defaultQuotaBytes: 7000 });
    await t.call(admin, "PATCH", `/admin/users/${id}`, { quotaBytes: null });
    expect(
      AdminUser.parse((await t.call(admin, "GET", `/admin/users/${id}`)).json()).quotaBytes,
    ).toBe(7000);
  });

  it("block ends sessions, closes sockets and refuses device tokens; unblock lets the user back", async () => {
    const d = await linkDevice(t, await user(t, "mario"));
    const web = await login("mario");
    const ws = await t.ws();
    ws.send(hello(d.token));
    await ws.next("welcome");
    const id = await idOf("mario");
    const self = await t.call(admin, "POST", `/admin/users/${await idOf("root")}/block`);
    expect(self.statusCode).toBe(403);
    const r = await t.call(admin, "POST", `/admin/users/${id}/block`);
    expect(AdminUser.parse(r.json()).status).toBe("blocked");
    expect(await ws.closed()).toMatchObject({ code: 4403 });
    expect((await t.call(web, "GET", "/me")).statusCode).toBe(401);
    const sync = await d.call("GET", `/vaults/${d.vaultId}/changes?after=0`);
    expect([sync.statusCode, codeOf(sync)]).toEqual([403, "user_blocked"]);
    const no = await t.call({}, "POST", "/auth/login", { username: "mario", password: PW });
    expect(no.statusCode).toBe(403);
    const back = await t.call(admin, "POST", `/admin/users/${id}/unblock`);
    expect(AdminUser.parse(back.json()).status).toBe("active");
    expect((await d.call("GET", `/vaults/${d.vaultId}/changes?after=0`)).statusCode).toBe(200);
    await login("mario");
  });

  it("a reset link is visible to the user and emailed to them when SMTP is on", async () => {
    await fresh(SMTP);
    await user(t, "mario");
    const id = await idOf("mario");
    const r = await t.call(admin, "POST", `/admin/users/${id}/reset-link`);
    expect(r.json().link).toMatch(/^http:\/\/localhost:8080\/reset\/[\w-]+$/);
    const web = await login("mario");
    expect((await t.call(web, "GET", "/me")).json().adminResetAt).not.toBeNull();
    const log = (await t.call(web, "GET", "/account/security-log")).json() as {
      items: { type: string }[];
    };
    expect(log.items.map((i) => i.type)).toContain("admin_reset");
    await t.outbox.drain();
    expect(t.mail.map((m) => m.to)).toEqual(["mario@example.com"]);
    expect(t.mail[0]!.text).not.toContain("/reset/"); // the link goes only to the admin
  });

  it("health reports checks and totals; smtp is off without configuration", async () => {
    await linkDevice(t, await user(t, "mario"));
    const h = SystemHealth.parse((await t.call(admin, "GET", "/admin/health")).json());
    expect(h.checks.find((c) => c.name === "database")?.status).toBe("ok");
    expect(h.checks.find((c) => c.name === "smtp")?.status).toBe("off");
    expect(h.totals).toMatchObject({ users: 2, vaults: 1, devices: 1 });
    expect(h.totals.devicesByLevel.working).toBe(1);
  });

  it("the audit log pages by 20, newest first, and hides actions the UI doesn't know", async () => {
    for (let i = 0; i < 25; i++) {
      t.clock.now += 1000;
      await t.call(admin, "PATCH", "/admin/config", { maxRetentionDays: 30 + (i % 2) });
    }
    const p1 = AuditPage.parse((await t.call(admin, "GET", "/admin/audit")).json());
    expect([p1.page, p1.pages, p1.items.length]).toEqual([1, 2, 20]);
    expect(p1.items.some((i) => (i.action as string) === "setup")).toBe(false);
    const p2 = AuditPage.parse((await t.call(admin, "GET", "/admin/audit?page=9")).json());
    expect([p2.page, p2.items.length]).toEqual([2, 5]);
    expect(p1.items[0]!.at >= p2.items[0]!.at).toBe(true);
  });

  it("config: GET, PATCH and the SMTP test (409 without SMTP)", async () => {
    const c = SystemConfig.parse(
      (await t.call(admin, "PATCH", "/admin/config", { registration: "open" })).json(),
    );
    expect(c.registration).toEqual({ value: "open", source: "ui" });
    const r = await t.call(admin, "POST", "/admin/config/smtp-test");
    expect([r.statusCode, codeOf(r)]).toEqual([409, "smtp_not_configured"]);
    await fresh(SMTP);
    const ok = await t.call(admin, "POST", "/admin/config/smtp-test");
    expect(ok.json()).toEqual({ ok: true });
    expect(t.mail.map((m) => m.to)).toEqual(["root@example.com"]);
    const locked = await t.call(admin, "PATCH", "/admin/config", { smtp: { host: "x" } });
    expect([locked.statusCode, codeOf(locked)]).toEqual([409, "config_locked"]);
  });

  it("no vault, file or device name appears in any admin response", async () => {
    const d = await linkDevice(t, await user(t, "mario"), undefined, "Secret-Phone-Name");
    await putFile(d, "secret-folder/diary.md", Buffer.from("hello"));
    const id = await idOf("mario");
    const bodies = await Promise.all(
      ["/admin/users", `/admin/users/${id}`, "/admin/health", "/admin/audit", "/admin/config"].map(
        async (p) => (await t.call(admin, "GET", p)).body,
      ),
    );
    for (const b of bodies) expect(b).not.toMatch(/Note|Secret-Phone|secret-folder|diary/);
    const list = AdminUserList.parse(JSON.parse(bodies[0]!));
    expect(list.find((u) => u.username === "mario")).toMatchObject({
      vaultCount: 1,
      deviceCount: 1,
      usedBytes: 5,
    });
  });

  it("forgot password: with SMTP a link is emailed, same answer for an unknown address", async () => {
    expect(
      (await t.call({}, "POST", "/auth/forgot", { email: "root@example.com" })).json(),
    ).toEqual({ smtp: false });
    await fresh(SMTP);
    await user(t, "mario");
    for (const email of ["mario@example.com", "nobody@example.com"])
      expect((await t.call({}, "POST", "/auth/forgot", { email })).json()).toEqual({ smtp: true });
    await t.outbox.drain();
    expect(t.mail.map((m) => m.to)).toEqual(["mario@example.com"]);
    const token = /\/reset\/([\w-]+)/.exec(t.mail[0]!.text)![1]!;
    const r = await t.call({}, "POST", "/auth/reset", { token, password: `${PW}-new` });
    expect(r.statusCode).toBe(204);
    // A self-service reset is not an admin reset: nothing to warn about on the account page.
    const web: Agent = {};
    await t.call(web, "POST", "/auth/login", { username: "mario", password: `${PW}-new` });
    expect((await t.call(web, "GET", "/me")).json().adminResetAt).toBeNull();
  });
});
