import {
  ConfigPatch,
  CreateUserRequest,
  DeleteUserRequest,
  UpdateUserRequest,
  type AdminUser,
  type ErrorCode,
  type SystemConfig,
} from "@kamino/protocol";
import { http, HttpResponse } from "msw";
import { ad, addAudit, defaultMeta } from "./admindata.js";
import { currentUser, db, nextId, type FakeUser } from "./db.js";

const API = "*/api/v1";
const fail = (status: number, code: ErrorCode) =>
  HttpResponse.json({ error: { code, message: code, retryable: false } }, { status });
async function json(req: Request): Promise<unknown> {
  return req.json().catch(() => undefined);
}

/** Admin only; returns the admin or an error response. */
function admin(): FakeUser | Response {
  const u = currentUser();
  if (!u) return fail(401, "unauthorized");
  return u.role === "admin" ? u : fail(403, "forbidden");
}

function toAdminUser(u: FakeUser): AdminUser {
  const m = ad.meta.get(u.id) ?? defaultMeta();
  const status: AdminUser["status"] = m.deletionAt
    ? "deleting"
    : u.locked
      ? "blocked"
      : m.invited
        ? "invited"
        : "active";
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    status,
    totpEnabled: u.totpEnabled,
    createdAt: m.createdAt,
    lastLoginAt: m.lastLoginAt,
    quotaBytes: m.quotaBytes,
    usedBytes: m.usedBytes,
    vaultCount: m.vaultCount,
    deviceCount: m.deviceCount,
    syncLevel: m.syncLevel,
    deletionAt: m.deletionAt,
  };
}

function toConfig(): SystemConfig {
  const { password, ...smtp } = ad.config.smtp;
  return {
    registration: ad.config.registration,
    defaultQuotaBytes: ad.config.defaultQuotaBytes,
    maxRetentionDays: ad.config.maxRetentionDays,
    maxFileBytes: ad.config.maxFileBytes,
    smtp: { ...smtp, passwordSet: password.length > 0 },
    smtpConfigured: db.smtp,
  };
}

const findUser = (id: unknown) => db.users.find((u) => u.id === id);

export const adminHandlers = [
  http.get(`${API}/admin/users`, () => {
    const a = admin();
    return a instanceof Response ? a : HttpResponse.json(db.users.map(toAdminUser));
  }),
  http.get(`${API}/admin/users/:id`, ({ params }) => {
    const a = admin();
    if (a instanceof Response) return a;
    const u = findUser(params["id"]);
    return u ? HttpResponse.json(toAdminUser(u)) : fail(404, "not_found");
  }),
  http.post(`${API}/admin/users`, async ({ request }) => {
    const a = admin();
    if (a instanceof Response) return a;
    const b = CreateUserRequest.safeParse(await json(request));
    if (!b.success) return fail(400, "invalid_request");
    const lower = (x: string) => x.toLowerCase();
    if (db.users.some((x) => lower(x.username) === lower(b.data.username)))
      return fail(409, "username_taken");
    if (db.users.some((x) => lower(x.email) === lower(b.data.email)))
      return fail(409, "email_taken");
    if (b.data.delivery === "email" && !db.smtp) return fail(409, "smtp_not_configured");
    const u: FakeUser = {
      id: nextId("u"),
      username: b.data.username,
      email: b.data.email,
      password: "",
      role: b.data.role,
      lang: "it",
      theme: "system",
      totpEnabled: false,
      totpSetupRequired: b.data.role === "admin",
      adminResetAt: null,
      locked: false,
      recoveryCodes: [],
    };
    db.users.push(u);
    ad.meta.set(u.id, defaultMeta({ invited: true }));
    const token = `${u.id}-invite`;
    db.invites.set(token, { username: u.username, email: u.email });
    addAudit(a.username, b.data.delivery === "email" ? "user_invited" : "user_created", u.username);
    return HttpResponse.json({
      user: toAdminUser(u),
      link: b.data.delivery === "link" ? `${location.origin}/invite/${token}` : null,
    });
  }),
  http.patch(`${API}/admin/users/:id`, async ({ request, params }) => {
    const a = admin();
    if (a instanceof Response) return a;
    const u = findUser(params["id"]);
    if (!u) return fail(404, "not_found");
    const b = UpdateUserRequest.safeParse(await json(request));
    if (!b.success) return fail(400, "invalid_request");
    // Only active admins count: a blocked or deleting admin can't sign in to administer.
    const activeAdmins = db.users.filter(
      (x) => x.role === "admin" && toAdminUser(x).status === "active",
    );
    if (b.data.role === "user" && u.role === "admin" && activeAdmins.every((x) => x.id === u.id))
      return fail(409, "last_admin");
    if (b.data.role !== undefined && b.data.role !== u.role) {
      u.role = b.data.role;
      addAudit(a.username, "role_changed", u.username);
    }
    if (b.data.quotaBytes !== undefined) {
      const m = ad.meta.get(u.id) ?? defaultMeta();
      m.quotaBytes = b.data.quotaBytes;
      ad.meta.set(u.id, m);
      addAudit(a.username, "quota_changed", u.username);
    }
    return HttpResponse.json(toAdminUser(u));
  }),
  ...(["block", "unblock"] as const).map((action) =>
    http.post(`${API}/admin/users/:id/${action}`, ({ params }) => {
      const a = admin();
      if (a instanceof Response) return a;
      const u = findUser(params["id"]);
      if (!u) return fail(404, "not_found");
      if (u.id === a.id) return fail(403, "forbidden");
      if (toAdminUser(u).status === "deleting") return fail(409, "forbidden");
      u.locked = action === "block";
      addAudit(a.username, action === "block" ? "user_blocked" : "user_unblocked", u.username);
      return HttpResponse.json(toAdminUser(u));
    }),
  ),
  http.post(`${API}/admin/users/:id/reset-link`, ({ params }) => {
    const a = admin();
    if (a instanceof Response) return a;
    const u = findUser(params["id"]);
    if (!u) return fail(404, "not_found");
    if (toAdminUser(u).status === "deleting") return fail(409, "forbidden");
    const token = `${u.id}-reset-${++ad.seq}`;
    db.resets.set(token, u.id);
    u.adminResetAt = new Date().toISOString(); // U-09: always visible to the user
    addAudit(a.username, "reset_link_created", u.username);
    return HttpResponse.json({ link: `${location.origin}/reset/${token}` });
  }),
  http.delete(`${API}/admin/users/:id`, async ({ request, params }) => {
    const a = admin();
    if (a instanceof Response) return a;
    const u = findUser(params["id"]);
    if (!u) return fail(404, "not_found");
    if (u.id === a.id) return fail(403, "forbidden");
    const b = DeleteUserRequest.safeParse(await json(request));
    if (!b.success || b.data.confirmUsername !== u.username) return fail(400, "confirm_mismatch");
    if (b.data.sendZip && !db.smtp) return fail(409, "smtp_not_configured");
    const m = ad.meta.get(u.id) ?? defaultMeta();
    m.deletionAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    ad.meta.set(u.id, m);
    u.locked = true;
    addAudit(a.username, "user_deleted", u.username);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`${API}/admin/config`, () => {
    const a = admin();
    return a instanceof Response ? a : HttpResponse.json(toConfig());
  }),
  http.patch(`${API}/admin/config`, async ({ request }) => {
    const a = admin();
    if (a instanceof Response) return a;
    const b = ConfigPatch.safeParse(await json(request));
    if (!b.success) return fail(400, "invalid_request");
    const c = ad.config;
    const top = ["registration", "defaultQuotaBytes", "maxRetentionDays", "maxFileBytes"] as const;
    const smtpKeys = ["host", "port", "security", "username", "from", "allowInvalidCerts"] as const;
    // E-03: environment wins — any attempt to change an env field is refused, nothing applied.
    if (top.some((k) => b.data[k] !== undefined && c[k].source === "env"))
      return fail(409, "config_locked");
    if (smtpKeys.some((k) => b.data.smtp?.[k] !== undefined && c.smtp[k].source === "env"))
      return fail(409, "config_locked");
    if (b.data.smtp?.password !== undefined && c.smtp.passwordSource === "env")
      return fail(409, "config_locked");
    for (const k of top)
      if (b.data[k] !== undefined)
        (c[k] as { value: unknown; source: string }) = { value: b.data[k], source: "ui" };
    for (const k of smtpKeys)
      if (b.data.smtp?.[k] !== undefined)
        (c.smtp[k] as { value: unknown; source: string }) = { value: b.data.smtp[k], source: "ui" };
    if (b.data.smtp?.password !== undefined) c.smtp.password = b.data.smtp.password;
    addAudit(a.username, "config_changed", Object.keys(b.data).join(","));
    return HttpResponse.json(toConfig());
  }),
  http.post(`${API}/admin/config/smtp-test`, () => {
    const a = admin();
    if (a instanceof Response) return a;
    addAudit(a.username, "smtp_test", a.email);
    if (!db.smtp) return fail(409, "smtp_not_configured");
    if (ad.smtpFails) {
      ad.smtpFails = false;
      return HttpResponse.json({
        ok: false,
        error: "535 5.7.8 Authentication credentials invalid (smtp.example.com:587, STARTTLS)",
      });
    }
    return HttpResponse.json({ ok: true });
  }),
  http.get(`${API}/admin/health`, () => {
    const a = admin();
    if (a instanceof Response) return a;
    return HttpResponse.json({
      status: "degraded",
      version: "0.0.0",
      codename: "Ash",
      uptimeSeconds: 3 * 86_400 + 4 * 3_600,
      checks: [
        { name: "database", status: "ok" },
        { name: "storage", status: "ok" },
        { name: "disk", status: "warn", value: 0.85 },
        { name: "jobs", status: "ok", value: 0 },
        { name: "smtp", status: db.smtp ? "ok" : "off" },
      ],
      totals: {
        users: db.users.length,
        vaults: 7,
        devices: 12,
        storageBytes: 18.4 * 1024 ** 3,
        devicesByLevel: { safe: 8, working: 1, attention: 2, decision: 1, blocked: 0 },
      },
    });
  }),
  http.get(`${API}/admin/audit`, ({ request }) => {
    const a = admin();
    if (a instanceof Response) return a;
    const pages = Math.max(1, Math.ceil(ad.audit.length / 20));
    const page = Math.min(
      pages,
      Math.max(1, Number(new URL(request.url).searchParams.get("page")) || 1),
    );
    return HttpResponse.json({ items: ad.audit.slice((page - 1) * 20, page * 20), page, pages });
  }),
];
