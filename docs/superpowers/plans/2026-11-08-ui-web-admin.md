# Fase UI, sotto-fase 4c — Web app: area admin — piano di implementazione

> **For agentic workers:** standard del progetto (`CLAUDE.md`): superpowers:executing-plans nella sessione corrente, a blocchi. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** area admin della web app: utenti (elenco, creazione con invito o link, quota, ruolo, blocco, link di reset, eliminazione), sistema (configurazione con campi da ambiente bloccati ed email di prova, salute, audit log), solo metriche aggregate.

**Architecture:** come 4a/4b: contratto zod `packages/protocol/src/admin.ts`; endpoint in `apps/web/src/api/endpoints.ts`; MSW con `src/mocks/admindata.ts` e `src/mocks/admin-handlers.ts`; pagine in `src/pages/admin/`.

**Spec:** `docs/superpowers/specs/2026-11-08-ui-web-admin-design.md`.

**Blocchi:** (A) Task 1–2 contratto e MSW; (B) Task 3–4 utenti e sistema; (C) Task 5 documenti → prova del committente.

## Global Constraints

- TypeScript strict; testi solo da i18n (it/en); nome prodotto da `@kamino/brand`; lessico a tema vietato.
- Mai nomi di vault, file o cartelle nell'area admin (U-03); mai password di altri utenti (U-10); link di attivazione/reset mostrati una volta.
- Campi `source: "env"` sempre bloccati con "Impostato dall'ambiente".
- Azioni distruttive con conferma; bottoni disattivati durante l'invio; errori sempre mostrati.
- `pnpm format:check` prima di ogni push.

## Review Focus

1. Eliminazione solo con username esatto; ZIP solo con SMTP; mai su sé stessi. → Task 2–3.
2. Campo da ambiente: disattivato in UI e rifiutato dal server (`config_locked`). → Task 2, 4.
3. Togliere il ruolo all'ultimo admin → `last_admin` spiegato. → Task 2–3.
4. Nessun campo del contratto o della UI admin espone nomi di vault/file. → Task 1, 3.

---

### Task 1: Contratto

**Files:** Create `packages/protocol/src/admin.ts`, `packages/protocol/src/admin.test.ts`; Modify `packages/protocol/src/errors.ts` (`smtp_not_configured`, `last_admin`, `config_locked`), `packages/protocol/src/index.ts`.

- [ ] **Step 1: Test** — `packages/protocol/src/admin.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AdminUser, ConfigPatch, CreateUserRequest, ErrorCode, SmtpTestResult, SystemConfig, SystemHealth } from "./index.js";

const user = {
  id: "u1", username: "demo", email: "demo@example.com", role: "user", status: "active", totpEnabled: false,
  createdAt: "x", lastLoginAt: null, quotaBytes: null, usedBytes: 1, vaultCount: 2, deviceCount: 3, syncLevel: "safe", deletionAt: null,
};
const f = <T>(value: T, source = "ui") => ({ value, source });

describe("admin contract", () => {
  it("admin users carry only aggregates", () => {
    expect(AdminUser.parse(user).vaultCount).toBe(2);
    expect(Object.keys(AdminUser.shape)).not.toContain("vaults");
  });

  it("create user: delivery email or link", () => {
    expect(CreateUserRequest.safeParse({ username: "a", email: "a@example.com", role: "user", delivery: "link" }).success).toBe(true);
    expect(CreateUserRequest.safeParse({ username: "a", email: "a@example.com", role: "user", delivery: "password" }).success).toBe(false);
  });

  it("config fields know their source; the SMTP password never comes back", () => {
    const cfg = {
      registration: f("closed"), defaultQuotaBytes: f(null, "default"), maxRetentionDays: f(30), maxFileBytes: f(1, "env"),
      smtp: { host: f("smtp.example", "env"), port: f(587), security: f("starttls"), username: f(""), from: f("k@example.com"), allowInvalidCerts: f(false), passwordSet: true, passwordSource: "ui" },
      smtpConfigured: true,
    };
    expect(SystemConfig.parse(cfg).maxFileBytes.source).toBe("env");
    expect(Object.keys(SystemConfig.shape.smtp.shape)).not.toContain("password");
    expect(ConfigPatch.safeParse({ smtp: { password: "secret" } }).success).toBe(true);
    expect(ConfigPatch.safeParse({ maxRetentionDays: 120 }).success).toBe(false);
  });

  it("smtp test result and health", () => {
    expect(SmtpTestResult.parse({ ok: false, error: "535 auth failed" })).toMatchObject({ ok: false });
    const health = {
      status: "degraded", version: "0.0.0", codename: "Ash", uptimeSeconds: 10,
      checks: [{ name: "disk", status: "warn", value: 0.85 }],
      totals: { users: 5, vaults: 7, devices: 9, storageBytes: 1, devicesByLevel: { safe: 5, working: 1, attention: 2, decision: 1, blocked: 0 } },
    };
    expect(SystemHealth.parse(health).status).toBe("degraded");
  });

  it("new error codes", () => {
    for (const c of ["smtp_not_configured", "last_admin", "config_locked"]) expect(ErrorCode.options).toContain(c);
  });
});
```

- [ ] **Step 2: Implementazione** — `packages/protocol/src/admin.ts`:

```ts
import { z } from "zod";
import { Level } from "./account.js";
import { Email, Role, Username } from "./auth.js";

/** U-03: aggregates only — no vault, file or folder names anywhere in the admin API. */
export const AdminUserStatus = z.enum(["active", "invited", "blocked", "deleting"]);
export const AdminUser = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string(),
  role: Role,
  status: AdminUserStatus,
  totpEnabled: z.boolean(),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
  quotaBytes: z.number().min(0).nullable(),
  usedBytes: z.number().min(0),
  vaultCount: z.number().int().min(0),
  deviceCount: z.number().int().min(0),
  syncLevel: Level,
  deletionAt: z.string().nullable(),
});
export type AdminUser = z.infer<typeof AdminUser>;
export const AdminUserList = z.array(AdminUser);

/** U-10: the admin never sets another user's password: invitation email or activation link. */
export const CreateUserRequest = z.object({ username: Username, email: Email, role: Role, delivery: z.enum(["email", "link"]) });
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;
export const CreateUserResponse = z.object({ user: AdminUser, link: z.string().nullable() });
export const UpdateUserRequest = z.object({ role: Role.optional(), quotaBytes: z.number().min(0).nullable().optional() });
export type UpdateUserRequest = z.infer<typeof UpdateUserRequest>;
export const ResetLink = z.object({ link: z.string() });
export const DeleteUserRequest = z.object({ confirmUsername: z.string(), sendZip: z.boolean() });

/** E-03: where a value comes from; "env" values are locked in the UI. */
export const ConfigSource = z.enum(["env", "ui", "default"]);
export type ConfigSource = z.infer<typeof ConfigSource>;
const field = <T extends z.ZodType>(t: T) => z.object({ value: t, source: ConfigSource });
export const SmtpSecurity = z.enum(["none", "starttls", "tls"]);
export const SystemConfig = z.object({
  registration: field(z.enum(["closed", "open"])),
  defaultQuotaBytes: field(z.number().min(0).nullable()),
  maxRetentionDays: field(z.number().int().min(0).max(90)),
  maxFileBytes: field(z.number().int().min(1)),
  smtp: z.object({
    host: field(z.string()),
    port: field(z.number().int().min(1).max(65535)),
    security: field(SmtpSecurity),
    username: field(z.string()),
    from: field(z.string()),
    allowInvalidCerts: field(z.boolean()),
    /** The password is write-only: the client only knows whether one is set. */
    passwordSet: z.boolean(),
    passwordSource: ConfigSource,
  }),
  smtpConfigured: z.boolean(),
});
export type SystemConfig = z.infer<typeof SystemConfig>;
export const ConfigPatch = z.object({
  registration: z.enum(["closed", "open"]).optional(),
  defaultQuotaBytes: z.number().min(0).nullable().optional(),
  maxRetentionDays: z.number().int().min(0).max(90).optional(),
  maxFileBytes: z.number().int().min(1).optional(),
  smtp: z
    .object({
      host: z.string().optional(),
      port: z.number().int().min(1).max(65535).optional(),
      security: SmtpSecurity.optional(),
      username: z.string().optional(),
      from: z.string().optional(),
      allowInvalidCerts: z.boolean().optional(),
      password: z.string().optional(),
    })
    .optional(),
});
export type ConfigPatch = z.infer<typeof ConfigPatch>;
/** E-04: detailed technical error (never the password). */
export const SmtpTestResult = z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), error: z.string() })]);

export const HealthCheck = z.object({
  name: z.enum(["database", "storage", "disk", "jobs", "smtp"]),
  status: z.enum(["ok", "warn", "error", "off"]),
  /** disk: used ratio 0..1; jobs: queued jobs. The UI builds the text. */
  value: z.number().optional(),
});
export type HealthCheck = z.infer<typeof HealthCheck>;
export const SystemHealth = z.object({
  status: z.enum(["ok", "degraded", "down"]),
  version: z.string(),
  codename: z.string(),
  uptimeSeconds: z.number().min(0),
  checks: z.array(HealthCheck),
  totals: z.object({
    users: z.number().int().min(0),
    vaults: z.number().int().min(0),
    devices: z.number().int().min(0),
    storageBytes: z.number().min(0),
    devicesByLevel: z.record(Level, z.number().int().min(0)),
  }),
});
export type SystemHealth = z.infer<typeof SystemHealth>;

export const AuditAction = z.enum([
  "user_created", "user_invited", "user_blocked", "user_unblocked", "user_deleted",
  "quota_changed", "role_changed", "reset_link_created", "config_changed", "smtp_test",
]);
export const AuditEntry = z.object({ id: z.string(), at: z.string(), actor: z.string(), action: AuditAction, target: z.string() });
export type AuditEntry = z.infer<typeof AuditEntry>;
export const AuditPage = z.object({ items: z.array(AuditEntry), page: z.number().int().min(1), pages: z.number().int().min(1) });
```

`errors.ts`: aggiungere `"smtp_not_configured", "last_admin", "config_locked",` prima di `"unauthorized"`; `index.ts`: `export * from "./admin.js";`.

Run test/build/typecheck/lint del pacchetto; commit `feat(protocol): add admin contract`.

---

### Task 2: Endpoint e MSW

**Files:** Modify `apps/web/src/api/endpoints.ts`, `apps/web/src/mocks/db.ts` (`seedAdminData()` in `resetDb`), `apps/web/src/mocks/handlers.ts` (aggiunge `adminHandlers`), `apps/web/src/mocks/DevPanel.tsx` ("Email di prova fallisce"); Create `apps/web/src/mocks/admindata.ts`, `apps/web/src/mocks/admin-handlers.ts`; Test `apps/web/src/mocks/admin-handlers.test.ts`.

**Produces (api):** `adminUsers()`, `adminUser(id)`, `createUser(body)`, `updateUser(id, body)`, `blockUser(id)`, `unblockUser(id)`, `resetLink(id)`, `deleteUser(id, confirmUsername, sendZip)`, `adminConfig()`, `updateConfig(patch)`, `smtpTest()`, `health()`, `audit(page)`. **Mock:** `ad` (stato), `seedAdminData()`, `simulateSmtpFailure()`.

- [ ] **Step 1: Endpoint** — aggiungere a `api` (con gli import di `AdminUser`, `AdminUserList`, `AuditPage`, `CreateUserResponse`, `ResetLink`, `SmtpTestResult`, `SystemConfig`, `SystemHealth`, `type ConfigPatch`, `type CreateUserRequest`, `type UpdateUserRequest`):

```ts
  adminUsers: () => request(AdminUserList, "/admin/users"),
  adminUser: (id: string) => request(AdminUser, `/admin/users/${encodeURIComponent(id)}`),
  createUser: (body: CreateUserRequest) => request(CreateUserResponse, "/admin/users", { method: "POST", body }),
  updateUser: (id: string, body: UpdateUserRequest) =>
    request(AdminUser, `/admin/users/${encodeURIComponent(id)}`, { method: "PATCH", body }),
  blockUser: (id: string) => request(AdminUser, `/admin/users/${encodeURIComponent(id)}/block`, { method: "POST" }),
  unblockUser: (id: string) => request(AdminUser, `/admin/users/${encodeURIComponent(id)}/unblock`, { method: "POST" }),
  resetLink: (id: string) => request(ResetLink, `/admin/users/${encodeURIComponent(id)}/reset-link`, { method: "POST" }),
  deleteUser: (id: string, confirmUsername: string, sendZip: boolean) =>
    requestVoid(`/admin/users/${encodeURIComponent(id)}`, { method: "DELETE", body: { confirmUsername, sendZip } }),
  adminConfig: () => request(SystemConfig, "/admin/config"),
  updateConfig: (patch: ConfigPatch) => request(SystemConfig, "/admin/config", { method: "PATCH", body: patch }),
  smtpTest: () => request(SmtpTestResult, "/admin/config/smtp-test", { method: "POST" }),
  health: () => request(SystemHealth, "/admin/health"),
  audit: (page: number) => request(AuditPage, `/admin/audit?page=${page}`),
```

- [ ] **Step 2: Dati finti** — `apps/web/src/mocks/admindata.ts`:

```ts
import type { AuditEntry, ConfigSource, Level } from "@kamino/protocol";
import { db } from "./db.js";

// Fake admin-side data (dev/tests). Per-user aggregates only (U-03).
const NOW = Date.UTC(2026, 10, 8, 10, 0);
const DAY = 86_400_000;
const GB = 1024 ** 3;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

export interface UserMeta {
  createdAt: string;
  lastLoginAt: string | null;
  quotaBytes: number | null;
  usedBytes: number;
  vaultCount: number;
  deviceCount: number;
  syncLevel: Level;
  invited: boolean;
  deletionAt: string | null;
}

type F<T> = { value: T; source: ConfigSource };
interface Config {
  registration: F<"closed" | "open">;
  defaultQuotaBytes: F<number | null>;
  maxRetentionDays: F<number>;
  maxFileBytes: F<number>;
  smtp: {
    host: F<string>; port: F<number>; security: F<"none" | "starttls" | "tls">; username: F<string>; from: F<string>;
    allowInvalidCerts: F<boolean>; password: string; passwordSource: ConfigSource;
  };
}

interface AdminData {
  meta: Map<string, UserMeta>;
  config: Config;
  audit: AuditEntry[];
  smtpFails: boolean;
  seq: number;
}

export const ad: AdminData = { meta: new Map(), config: undefined as unknown as Config, audit: [], smtpFails: false, seq: 0 };

export function defaultMeta(over: Partial<UserMeta> = {}): UserMeta {
  return { createdAt: iso(0), lastLoginAt: null, quotaBytes: 10 * GB, usedBytes: 0, vaultCount: 0, deviceCount: 0, syncLevel: "safe", invited: false, deletionAt: null, ...over };
}

export function seedAdminData(): void {
  ad.seq = 0;
  ad.smtpFails = false;
  ad.meta = new Map();
  const levels: Level[] = ["decision", "safe", "working", "safe", "attention"];
  db.users.forEach((u, i) => {
    ad.meta.set(u.id, defaultMeta({
      createdAt: iso((60 - i) * DAY),
      lastLoginAt: iso(i * DAY),
      quotaBytes: u.username === "demo" ? null : 10 * GB,
      usedBytes: (i + 1) * 0.7 * GB,
      vaultCount: (i % 3) + 1,
      deviceCount: (i % 4) + 1,
      syncLevel: levels[i % levels.length]!,
    }));
  });
  ad.config = {
    registration: { value: "closed", source: "default" },
    defaultQuotaBytes: { value: 10 * GB, source: "ui" },
    maxRetentionDays: { value: 90, source: "default" },
    maxFileBytes: { value: 500 * 1024 ** 2, source: "env" },
    smtp: {
      host: { value: "smtp.example.com", source: "env" },
      port: { value: 587, source: "ui" },
      security: { value: "starttls", source: "ui" },
      username: { value: "kamino", source: "ui" },
      from: { value: "kamino@example.com", source: "ui" },
      allowInvalidCerts: { value: false, source: "default" },
      password: "secret",
      passwordSource: "ui",
    },
  };
  const actions: AuditEntry["action"][] = ["user_created", "quota_changed", "config_changed", "user_blocked", "reset_link_created"];
  ad.audit = Array.from({ length: 30 }, (_, i) => ({
    id: `a-${i}`, at: iso(i * 7_200_000), actor: "admin", action: actions[i % actions.length]!, target: i % 5 === 2 ? "smtp.port" : "demo",
  }));
}

export function addAudit(actor: string, action: AuditEntry["action"], target: string): void {
  ad.audit.unshift({ id: `a-new-${++ad.seq}`, at: new Date().toISOString(), actor, action, target });
}

/** Dev panel: the next SMTP test fails with a detailed error. */
export function simulateSmtpFailure(): void {
  ad.smtpFails = true;
}
```

In `db.ts`: importare `seedAdminData` da `./admindata.js`; in `resetDb` sostituire `if (preset === "empty") return;` con `if (preset === "empty") { seedAdminData(); return; }` e aggiungere `seedAdminData();` come ultima riga della funzione.

- [ ] **Step 3: Test degli handler** — `apps/web/src/mocks/admin-handlers.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { api } from "../api/endpoints.js";
import { ApiError } from "../api/http.js";
import { ad, simulateSmtpFailure } from "./admindata.js";
import { db, signInAs } from "./db.js";

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ApiError ? e.code : "?"));
const id = (username: string) => db.users.find((u) => u.username === username)!.id;

describe("admin fake API", () => {
  it("only admins", async () => {
    signInAs("demo");
    expect(await code(api.adminUsers())).toBe("forbidden");
  });

  it("users: list, create with link or email, smtp off", async () => {
    signInAs("admin");
    expect((await api.adminUsers()).length).toBe(5);
    const r = await api.createUser({ username: "nuovo", email: "nuovo@example.com", role: "user", delivery: "link" });
    expect(r.link).toContain("/invite/");
    expect(r.user.status).toBe("invited");
    db.smtp = false;
    expect(await code(api.createUser({ username: "altro", email: "altro@example.com", role: "user", delivery: "email" }))).toBe("smtp_not_configured");
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
    expect((await api.updateConfig({ registration: "open", smtp: { port: 465 } })).smtp.port.value).toBe(465);
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
});
```

- [ ] **Step 4: Handler** — `apps/web/src/mocks/admin-handlers.ts`:

```ts
import {
  ConfigPatch, CreateUserRequest, DeleteUserRequest, UpdateUserRequest, type AdminUser, type ErrorCode, type SystemConfig,
} from "@kamino/protocol";
import { http, HttpResponse } from "msw";
import { ad, addAudit, defaultMeta } from "./admindata.js";
import { currentUser, db, nextId, type FakeUser } from "./db.js";

const API = "*/api/v1";
const fail = (status: number, code: ErrorCode) => HttpResponse.json({ error: { code, message: code, retryable: false } }, { status });
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
  const status: AdminUser["status"] = m.deletionAt ? "deleting" : u.locked ? "blocked" : m.invited ? "invited" : "active";
  return {
    id: u.id, username: u.username, email: u.email, role: u.role, status, totpEnabled: u.totpEnabled,
    createdAt: m.createdAt, lastLoginAt: m.lastLoginAt, quotaBytes: m.quotaBytes, usedBytes: m.usedBytes,
    vaultCount: m.vaultCount, deviceCount: m.deviceCount, syncLevel: m.syncLevel, deletionAt: m.deletionAt,
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
    if (!b.success) return fail(400, "internal");
    if (b.data.delivery === "email" && !db.smtp) return fail(409, "smtp_not_configured");
    const u: FakeUser = {
      id: nextId("u"), username: b.data.username, email: b.data.email, password: "", role: b.data.role, lang: "it", theme: "system",
      totpEnabled: false, totpSetupRequired: b.data.role === "admin", adminResetAt: null, locked: false, recoveryCodes: [],
    };
    db.users.push(u);
    ad.meta.set(u.id, defaultMeta({ invited: true }));
    const token = `${u.id}-invite`;
    db.invites.set(token, { username: u.username, email: u.email });
    addAudit(a.username, b.data.delivery === "email" ? "user_invited" : "user_created", u.username);
    return HttpResponse.json({ user: toAdminUser(u), link: b.data.delivery === "link" ? `${location.origin}/invite/${token}` : null });
  }),
  http.patch(`${API}/admin/users/:id`, async ({ request, params }) => {
    const a = admin();
    if (a instanceof Response) return a;
    const u = findUser(params["id"]);
    if (!u) return fail(404, "not_found");
    const b = UpdateUserRequest.safeParse(await json(request));
    if (!b.success) return fail(400, "internal");
    if (b.data.role === "user" && u.role === "admin" && db.users.filter((x) => x.role === "admin").length <= 1) return fail(409, "last_admin");
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
      if (u.id === a.id) return fail(409, "forbidden");
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
    if (u.id === a.id) return fail(409, "forbidden");
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
    if (!b.success) return fail(400, "internal");
    const c = ad.config;
    const top = ["registration", "defaultQuotaBytes", "maxRetentionDays", "maxFileBytes"] as const;
    const smtpKeys = ["host", "port", "security", "username", "from", "allowInvalidCerts"] as const;
    // E-03: environment wins — any attempt to change an env field is refused, nothing applied.
    if (top.some((k) => b.data[k] !== undefined && c[k].source === "env")) return fail(409, "config_locked");
    if (smtpKeys.some((k) => b.data.smtp?.[k] !== undefined && c.smtp[k].source === "env")) return fail(409, "config_locked");
    if (b.data.smtp?.password !== undefined && c.smtp.passwordSource === "env") return fail(409, "config_locked");
    for (const k of top) if (b.data[k] !== undefined) (c[k] as { value: unknown; source: string }) = { value: b.data[k], source: "ui" };
    for (const k of smtpKeys) if (b.data.smtp?.[k] !== undefined) (c.smtp[k] as { value: unknown; source: string }) = { value: b.data.smtp[k], source: "ui" };
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
      return HttpResponse.json({ ok: false, error: "535 5.7.8 Authentication credentials invalid (smtp.example.com:587, STARTTLS)" });
    }
    return HttpResponse.json({ ok: true });
  }),
  http.get(`${API}/admin/health`, () => {
    const a = admin();
    if (a instanceof Response) return a;
    return HttpResponse.json({
      status: "degraded", version: "0.0.0", codename: "Ash", uptimeSeconds: 3 * 86_400 + 4 * 3_600,
      checks: [
        { name: "database", status: "ok" },
        { name: "storage", status: "ok" },
        { name: "disk", status: "warn", value: 0.85 },
        { name: "jobs", status: "ok", value: 0 },
        { name: "smtp", status: db.smtp ? "ok" : "off" },
      ],
      totals: { users: db.users.length, vaults: 7, devices: 12, storageBytes: 18.4 * 1024 ** 3, devicesByLevel: { safe: 8, working: 1, attention: 2, decision: 1, blocked: 0 } },
    });
  }),
  http.get(`${API}/admin/audit`, ({ request }) => {
    const a = admin();
    if (a instanceof Response) return a;
    const pages = Math.max(1, Math.ceil(ad.audit.length / 20));
    const page = Math.min(pages, Math.max(1, Number(new URL(request.url).searchParams.get("page")) || 1));
    return HttpResponse.json({ items: ad.audit.slice((page - 1) * 20, page * 20), page, pages });
  }),
];
```

(Le assegnazioni tipizzate in modo largo su `c[k]` possono servire un cast `as never` per il typecheck: usare `Object.assign(c[k], { value: b.data[k], source: "ui" })` se più semplice.)

In `handlers.ts`: `export const handlers = [...authHandlers, ...userHandlers, ...adminHandlers];`. In `DevPanel.tsx`: bottone `dev.smtpFail` → `simulateSmtpFailure()` (it "Email di prova fallisce", en "Test email fails").

Run test/typecheck/lint; commit `feat(web): add admin API calls and fake data`.

---

### Task 3: Utenti

**Files:** Create `apps/web/src/pages/admin/{UsersPage,CreateUserDialog,UserPage,LinkOnce}.tsx`; Test `apps/web/src/pages/admin/users.test.tsx`; Modify `apps/web/src/router.tsx` (`adminUsersRoute` → `UsersPage`, nuova `adminUserRoute` `/admin/users/$userId`), i18n.

- [ ] **Step 1: Testi** (`it.json` / `en.json`, oggetto `admin`):

```json
"admin": {
  "users": {
    "title": "Utenti",
    "create": "Crea utente",
    "username": "Nome utente",
    "email": "Email",
    "role": "Ruolo",
    "status": "Stato",
    "space": "Spazio",
    "vaults": "Vault",
    "devices": "Dispositivi",
    "sync": "Sync",
    "lastLogin": "Ultimo accesso",
    "never": "mai",
    "unlimited": "illimitata",
    "statuses": { "active": "Attivo", "invited": "Invitato", "blocked": "Bloccato", "deleting": "In cancellazione" },
    "privacy": "Per privacy non vedi nomi di vault né file degli utenti: solo numeri e stato complessivo."
  },
  "create": {
    "title": "Crea utente",
    "delivery": "Come ricevere l'accesso",
    "byEmail": "Invia invito via email",
    "byLink": "Genera un link di attivazione",
    "noSmtp": "L'invio di email non è configurato: usa il link.",
    "submit": "Crea",
    "invited": "Invito inviato a {{email}}.",
    "linkHint": "Consegna questo link all'utente: sceglierà lui la password. Scade tra 7 giorni e lo vedi solo ora.",
    "copy": "Copia",
    "copied": "Copiato.",
    "done": "Fatto"
  },
  "user": {
    "notFound": "Utente non trovato.",
    "created": "Creato il",
    "totp": "Verifica in due passaggi",
    "yes": "attiva",
    "no": "non attiva",
    "quota": "Quota",
    "quotaUnlimited": "Illimitata",
    "quotaGb": "Quota in GB",
    "quotaBelow": "La quota è sotto lo spazio già usato: non cancella nulla, ma l'utente non potrà caricare finché non libera spazio.",
    "save": "Salva",
    "saved": "Salvato.",
    "roles": { "user": "Utente", "admin": "Amministratore" },
    "block": "Blocca",
    "unblock": "Sblocca",
    "blockTitle": "Bloccare {{name}}?",
    "blockText": "Niente accesso né sync finché non lo sblocchi. I dati restano intatti e contano nella quota.",
    "unblockTitle": "Sbloccare {{name}}?",
    "unblockText": "L'utente potrà di nuovo accedere e sincronizzare.",
    "reset": "Link per reimpostare la password",
    "resetTitle": "Generare un link di reset per {{name}}?",
    "resetText": "L'utente vedrà un avviso al prossimo accesso e la voce nel suo registro di sicurezza. Sessioni e dispositivi non vengono chiusi.",
    "resetHint": "Consegna questo link all'utente. Lo vedi solo ora.",
    "generate": "Genera",
    "danger": "Zona pericolosa",
    "delete": "Elimina l'utente",
    "deleteTitle": "Eliminare {{name}}?",
    "deleteText": "Per 7 giorni l'account resta “in cancellazione” (niente accesso né sync), poi utente e vault vengono eliminati in modo definitivo.",
    "sendZip": "Invia all'utente un link allo ZIP dei suoi vault (arriva solo a lui, valido 7 giorni)",
    "sendZipOff": "Serve l'invio di email per mandare lo ZIP.",
    "deleteConfirmLabel": "Scrivi il nome utente per confermare",
    "deleteConfirm": "Elimina",
    "deleted": "Utente in cancellazione.",
    "self": "Questo sei tu: non puoi bloccarti né eliminarti.",
    "cancel": "Annulla"
  }
}
```

`en.json` (stesse chiavi):

```json
"admin": {
  "users": {
    "title": "Users",
    "create": "Create user",
    "username": "Username",
    "email": "Email",
    "role": "Role",
    "status": "Status",
    "space": "Storage",
    "vaults": "Vaults",
    "devices": "Devices",
    "sync": "Sync",
    "lastLogin": "Last sign-in",
    "never": "never",
    "unlimited": "unlimited",
    "statuses": { "active": "Active", "invited": "Invited", "blocked": "Blocked", "deleting": "Being deleted" },
    "privacy": "For privacy you don't see users' vault or file names: only numbers and overall status."
  },
  "create": {
    "title": "Create user",
    "delivery": "How they get access",
    "byEmail": "Send an invitation email",
    "byLink": "Generate an activation link",
    "noSmtp": "Email is not configured: use the link.",
    "submit": "Create",
    "invited": "Invitation sent to {{email}}.",
    "linkHint": "Give this link to the user: they choose their own password. It expires in 7 days and you only see it now.",
    "copy": "Copy",
    "copied": "Copied.",
    "done": "Done"
  },
  "user": {
    "notFound": "User not found.",
    "created": "Created on",
    "totp": "Two-step verification",
    "yes": "on",
    "no": "off",
    "quota": "Quota",
    "quotaUnlimited": "Unlimited",
    "quotaGb": "Quota in GB",
    "quotaBelow": "The quota is below the space already used: nothing is deleted, but the user can't upload until they free some space.",
    "save": "Save",
    "saved": "Saved.",
    "roles": { "user": "User", "admin": "Administrator" },
    "block": "Block",
    "unblock": "Unblock",
    "blockTitle": "Block {{name}}?",
    "blockText": "No sign-in or sync until you unblock them. Data stays intact and counts toward the quota.",
    "unblockTitle": "Unblock {{name}}?",
    "unblockText": "The user can sign in and sync again.",
    "reset": "Password reset link",
    "resetTitle": "Generate a reset link for {{name}}?",
    "resetText": "The user will see a notice at the next sign-in and an entry in their security log. Sessions and devices are not signed out.",
    "resetHint": "Give this link to the user. You only see it now.",
    "generate": "Generate",
    "danger": "Danger zone",
    "delete": "Delete the user",
    "deleteTitle": "Delete {{name}}?",
    "deleteText": "For 7 days the account stays “being deleted” (no sign-in or sync), then the user and their vaults are permanently deleted.",
    "sendZip": "Send the user a link to a ZIP of their vaults (only they receive it, valid 7 days)",
    "sendZipOff": "Email must be configured to send the ZIP.",
    "deleteConfirmLabel": "Type the username to confirm",
    "deleteConfirm": "Delete",
    "deleted": "User being deleted.",
    "self": "This is you: you can't block or delete yourself.",
    "cancel": "Cancel"
  }
}
```

Aggiungere a `errors` (it/en): `smtp_not_configured` ("L'invio di email non è configurato." / "Email is not configured."), `last_admin` ("Serve almeno un amministratore." / "At least one administrator is required."), `config_locked` ("Questo valore è impostato dall'ambiente e non si può cambiare qui." / "This value is set by the environment and can't be changed here.").

- [ ] **Step 2: Test** — `apps/web/src/pages/admin/users.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ad } from "../../mocks/admindata.js";
import { db, signInAs } from "../../mocks/db.js";
import { ud } from "../../mocks/userdata.js";
import { renderRoute } from "../../test/render.js";

afterEach(cleanup);
const idOf = (u: string) => db.users.find((x) => x.username === u)!.id;

describe("Admin users", () => {
  it("list shows aggregates and never vault names", async () => {
    signInAs("admin");
    await renderRoute("/admin/users");
    expect(await screen.findByText("demo")).toBeDefined();
    expect(screen.getAllByText("illimitata").length).toBeGreaterThan(0);
    expect(screen.getByText(/Per privacy non vedi nomi di vault/)).toBeDefined();
    for (const v of ud.vaults) expect(screen.queryByText(v.name)).toBeNull();
  });

  it("create with a link shown once; email disabled without SMTP", async () => {
    db.smtp = false;
    signInAs("admin");
    await renderRoute("/admin/users");
    fireEvent.click(await screen.findByRole("button", { name: "Crea utente" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Invia invito via email") as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Nome utente"), { target: { value: "nuovo" } });
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "nuovo@example.com" } });
    fireEvent.click(within(dialog).getByLabelText("Genera un link di attivazione"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Crea" }));
    const link = (await within(dialog).findByLabelText("Link")) as HTMLInputElement;
    expect(link.value).toContain("/invite/");
  });

  it("detail: quota warning, role last admin, block with confirmation", async () => {
    signInAs("admin");
    await renderRoute(`/admin/users/${idOf("demo")}`);
    expect(await screen.findByRole("heading", { name: "demo" })).toBeDefined();
    fireEvent.click(screen.getByLabelText("Illimitata"));
    fireEvent.change(screen.getByLabelText("Quota in GB"), { target: { value: "0.1" } });
    expect(screen.getByText(/sotto lo spazio già usato/)).toBeDefined();
    fireEvent.click(screen.getAllByRole("button", { name: "Salva" })[0]!);
    await waitFor(() => expect(ad.meta.get(idOf("demo"))!.quotaBytes).toBeCloseTo(0.1 * 1024 ** 3, -3));
    fireEvent.click(screen.getByRole("button", { name: "Blocca" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/I dati restano intatti/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Blocca" }));
    await waitFor(() => expect(db.users.find((u) => u.username === "demo")!.locked).toBe(true));
  });

  it("removing admin from the last admin is explained", async () => {
    db.users.find((u) => u.username === "newadmin")!.role = "user";
    signInAs("admin");
    await renderRoute(`/admin/users/${idOf("admin")}`);
    fireEvent.change(await screen.findByLabelText("Ruolo"), { target: { value: "user" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Salva" })[1]!);
    expect(await screen.findByText("Serve almeno un amministratore.")).toBeDefined();
  });

  it("self: no block or delete", async () => {
    signInAs("admin");
    await renderRoute(`/admin/users/${idOf("admin")}`);
    expect(await screen.findByText(/non puoi bloccarti né eliminarti/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Elimina l'utente" })).toBeNull();
  });

  it("reset link after confirmation, shown once", async () => {
    signInAs("admin");
    await renderRoute(`/admin/users/${idOf("demo")}`);
    fireEvent.click(await screen.findByRole("button", { name: "Link per reimpostare la password" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Genera" }));
    expect(((await screen.findByLabelText("Link")) as HTMLInputElement).value).toContain("/reset/");
  });

  it("delete needs the exact username; ZIP only with SMTP", async () => {
    signInAs("admin");
    const { router } = await renderRoute(`/admin/users/${idOf("demo")}`);
    fireEvent.click(await screen.findByRole("button", { name: "Elimina l'utente" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Elimina" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Scrivi il nome utente per confermare"), { target: { value: "demo" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/users"));
    expect(ad.meta.get(idOf("demo"))!.deletionAt).not.toBeNull();
  });
});
```

- [ ] **Step 3: Implementazione**

`apps/web/src/pages/admin/LinkOnce.tsx`:

```tsx
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";

/** A one-time link (activation/reset): shown once, copyable. */
export function LinkOnce({ link, hint }: { link: string; hint: string }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="space-y-2">
      <p className="text-sm">{hint}</p>
      <Label htmlFor={id}>Link</Label>
      <Input id={id} readOnly value={link} className="font-mono text-xs" />
      <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(link).then(() => toast(t("admin.create.copied")))}>
        {t("admin.create.copy")}
      </Button>
    </div>
  );
}
```

(La parola "Link" dell'etichetta è identica in it/en; se il lint del lessico la segnala come testo scritto a mano, usare una chiave `admin.create.link`.)

`apps/web/src/pages/admin/CreateUserDialog.tsx`:

```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { TextField } from "../../components/TextField.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { ErrorText } from "../auth/AuthCard.js";
import { LinkOnce } from "./LinkOnce.js";

export function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const smtp = useQuery({ queryKey: ["admin-config"], queryFn: api.adminConfig, enabled: open }).data?.smtpConfigured ?? false;
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [delivery, setDelivery] = useState<"email" | "link">("link");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ link: string | null; email: string } | null>(null);

  const close = (o: boolean) => {
    if (!o) {
      setUsername(""); setEmail(""); setRole("user"); setDelivery("link"); setError(null); setDone(null);
    }
    onOpenChange(o);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.createUser({ username, email, role, delivery });
      setDone({ link: r.link, email });
      void qc.invalidateQueries({ queryKey: ["admin-users"] });
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("admin.create.title")}</DialogTitle></DialogHeader>
        {done ? (
          <div className="space-y-3">
            {done.link ? <LinkOnce link={done.link} hint={t("admin.create.linkHint")} /> : <p role="status">{t("admin.create.invited", { email: done.email })}</p>}
            <Button onClick={() => close(false)}>{t("admin.create.done")}</Button>
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="space-y-3">
            <TextField label={t("admin.users.username")} value={username} onChange={setUsername} required autoComplete="off" />
            <TextField label={t("admin.users.email")} value={email} onChange={setEmail} type="email" required autoComplete="off" />
            <label className="block space-y-1 text-sm">
              <span className="font-medium">{t("admin.users.role")}</span>
              <select value={role} onChange={(e) => setRole(e.target.value as "user" | "admin")} className="bg-background block rounded-md border px-2 py-1">
                <option value="user">{t("admin.user.roles.user")}</option>
                <option value="admin">{t("admin.user.roles.admin")}</option>
              </select>
            </label>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">{t("admin.create.delivery")}</legend>
              <label className="flex items-center gap-2"><input type="radio" name="delivery" disabled={!smtp} checked={delivery === "email"} onChange={() => setDelivery("email")} />{t("admin.create.byEmail")}</label>
              {!smtp && <p className="text-muted-foreground text-sm">{t("admin.create.noSmtp")}</p>}
              <label className="flex items-center gap-2"><input type="radio" name="delivery" checked={delivery === "link"} onChange={() => setDelivery("link")} />{t("admin.create.byLink")}</label>
            </fieldset>
            <ErrorText>{error}</ErrorText>
            <Button type="submit" disabled={busy}>{t("admin.create.submit")}</Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

`apps/web/src/pages/admin/UsersPage.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { LevelBadge } from "../../components/status/LevelBadge.js";
import { Button } from "../../components/ui/button.js";
import { formatAgo, formatBytes } from "../../lib/format.js";
import { CreateUserDialog } from "./CreateUserDialog.js";

export function UsersPage() {
  const { t, i18n } = useTranslation();
  useDocumentTitle(t("admin.users.title"));
  const users = useQuery({ queryKey: ["admin-users"], queryFn: api.adminUsers });
  const [createOpen, setCreateOpen] = useState(false);
  const lang = i18n.language;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-serif text-2xl font-semibold">{t("admin.users.title")}</h1>
        <Button onClick={() => setCreateOpen(true)}>{t("admin.users.create")}</Button>
      </div>
      <p className="text-muted-foreground text-sm">{t("admin.users.privacy")}</p>
      {users.isError && <p role="alert">{errorMessage(users.error, t)}</p>}
      <div className="bg-card overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground text-left">
            <tr>
              {["username", "role", "status", "space", "vaults", "devices", "sync", "lastLogin"].map((k) => (
                <th key={k} scope="col" className="p-3 font-medium">{t(`admin.users.${k}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {users.data?.map((u) => (
              <tr key={u.id}>
                <th scope="row" className="p-3 text-left font-medium">
                  <Link to="/admin/users/$userId" params={{ userId: u.id }} className="text-link underline">{u.username}</Link>
                  <span className="text-muted-foreground block text-xs font-normal">{u.email}</span>
                </th>
                <td className="p-3">{t(`admin.user.roles.${u.role}`)}</td>
                <td className="p-3">{t(`admin.users.statuses.${u.status}`)}</td>
                <td className="p-3 whitespace-nowrap">
                  {formatBytes(u.usedBytes, lang)} / {u.quotaBytes === null ? t("admin.users.unlimited") : formatBytes(u.quotaBytes, lang)}
                </td>
                <td className="p-3">{u.vaultCount}</td>
                <td className="p-3">{u.deviceCount}</td>
                <td className="p-3"><LevelBadge level={u.syncLevel} /></td>
                <td className="p-3 whitespace-nowrap">{u.lastLoginAt ? formatAgo(u.lastLoginAt, lang) : t("admin.users.never")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
```

`apps/web/src/pages/admin/UserPage.tsx`:

```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { LevelBadge } from "../../components/status/LevelBadge.js";
import { TextField } from "../../components/TextField.js";
import { Button } from "../../components/ui/button.js";
import { formatBytes, formatDateTime } from "../../lib/format.js";
import { adminUserRoute } from "../../router.js";
import { ErrorText } from "../auth/AuthCard.js";
import { LinkOnce } from "./LinkOnce.js";

const GB = 1024 ** 3;
type Dialog = "block" | "unblock" | "reset" | "delete" | null;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bg-card space-y-3 rounded-xl border p-4">
      <h2 className="font-serif text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function UserPage() {
  const { t, i18n } = useTranslation();
  const { userId } = adminUserRoute.useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const lang = i18n.language;
  const user = useQuery({ queryKey: ["admin-user", userId], queryFn: () => api.adminUser(userId) });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me }).data;
  const smtp = useQuery({ queryKey: ["admin-config"], queryFn: api.adminConfig }).data?.smtpConfigured ?? false;
  const u = user.data;
  useDocumentTitle(u?.username ?? t("admin.users.title"));
  const [unlimited, setUnlimited] = useState(true);
  const [gb, setGb] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [resetLink, setResetLink] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [sendZip, setSendZip] = useState(false);
  useEffect(() => {
    if (!u) return;
    setUnlimited(u.quotaBytes === null);
    setGb(u.quotaBytes === null ? "" : String(Math.round((u.quotaBytes / GB) * 10) / 10));
    setRole(u.role);
  }, [u?.id]); // only when another user is loaded

  if (user.isError) return <p>{t("admin.user.notFound")}</p>;
  if (!u) return null;
  const self = me?.id === u.id;
  const quotaBytes = unlimited ? null : Math.max(0, Number(gb) * GB);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["admin-user", userId] }), qc.invalidateQueries({ queryKey: ["admin-users"] })]);
  const act = async (fn: () => Promise<unknown>, done?: string, onError?: (msg: string) => void) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      if (done) toast(t(done));
      await refresh();
    } catch (err) {
      if (onError) onError(errorMessage(err, t));
      else toast.error(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-serif text-2xl font-semibold">{u.username}</h1>
        <LevelBadge level={u.syncLevel} />
      </div>
      <p className="text-muted-foreground text-sm">{t("admin.users.privacy")}</p>
      <dl className="bg-card grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-xl border p-4 text-sm">
        {([
          [t("admin.users.email"), u.email],
          [t("admin.users.status"), t(`admin.users.statuses.${u.status}`)],
          [t("admin.user.totp"), u.totpEnabled ? t("admin.user.yes") : t("admin.user.no")],
          [t("admin.user.created"), formatDateTime(u.createdAt, lang)],
          [t("admin.users.lastLogin"), u.lastLoginAt ? formatDateTime(u.lastLoginAt, lang) : t("admin.users.never")],
          [t("admin.users.space"), `${formatBytes(u.usedBytes, lang)} / ${u.quotaBytes === null ? t("admin.users.unlimited") : formatBytes(u.quotaBytes, lang)}`],
          [t("admin.users.vaults"), String(u.vaultCount)],
          [t("admin.users.devices"), String(u.deviceCount)],
        ] as Array<[string, string]>).map(([k, v]) => (
          <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>

      <Section title={t("admin.user.quota")}>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} />
          {t("admin.user.quotaUnlimited")}
        </label>
        {!unlimited && <TextField label={t("admin.user.quotaGb")} value={gb} onChange={setGb} type="number" min={0} step={0.1} />}
        {quotaBytes !== null && quotaBytes < u.usedBytes && <p className="bg-status-attention-surface text-status-attention rounded-md p-2 text-sm">{t("admin.user.quotaBelow")}</p>}
        <Button disabled={busy || (!unlimited && gb === "")} onClick={() => void act(() => api.updateUser(u.id, { quotaBytes }), "admin.user.saved")}>{t("admin.user.save")}</Button>
      </Section>

      <Section title={t("admin.users.role")}>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">{t("admin.users.role")}</span>
          <select value={role} onChange={(e) => setRole(e.target.value as "user" | "admin")} className="bg-background block rounded-md border px-2 py-1">
            <option value="user">{t("admin.user.roles.user")}</option>
            <option value="admin">{t("admin.user.roles.admin")}</option>
          </select>
        </label>
        <ErrorText>{roleError}</ErrorText>
        <Button disabled={busy} onClick={() => { setRoleError(null); void act(() => api.updateUser(u.id, { role }), "admin.user.saved", setRoleError); }}>{t("admin.user.save")}</Button>
      </Section>

      <Section title={t("admin.user.reset")}>
        {resetLink ? <LinkOnce link={resetLink} hint={t("admin.user.resetHint")} /> : <Button variant="outline" onClick={() => setDialog("reset")}>{t("admin.user.reset")}</Button>}
      </Section>

      <Section title={t("admin.user.danger")}>
        {self ? (
          <p className="text-muted-foreground text-sm">{t("admin.user.self")}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {u.status === "blocked" ? (
              <Button variant="outline" onClick={() => setDialog("unblock")}>{t("admin.user.unblock")}</Button>
            ) : (
              u.status !== "deleting" && <Button variant="outline" onClick={() => setDialog("block")}>{t("admin.user.block")}</Button>
            )}
            {u.status !== "deleting" && <Button variant="destructive" onClick={() => { setConfirmName(""); setSendZip(false); setDialog("delete"); }}>{t("admin.user.delete")}</Button>}
          </div>
        )}
      </Section>

      <ConfirmDialog open={dialog === "block"} onOpenChange={(o) => !o && setDialog(null)} title={t("admin.user.blockTitle", { name: u.username })} text={t("admin.user.blockText")}
        confirmText={t("admin.user.block")} cancelText={t("admin.user.cancel")} destructive busy={busy}
        onConfirm={() => void act(() => api.blockUser(u.id)).then(() => setDialog(null))} />
      <ConfirmDialog open={dialog === "unblock"} onOpenChange={(o) => !o && setDialog(null)} title={t("admin.user.unblockTitle", { name: u.username })} text={t("admin.user.unblockText")}
        confirmText={t("admin.user.unblock")} cancelText={t("admin.user.cancel")} busy={busy}
        onConfirm={() => void act(() => api.unblockUser(u.id)).then(() => setDialog(null))} />
      <ConfirmDialog open={dialog === "reset"} onOpenChange={(o) => !o && setDialog(null)} title={t("admin.user.resetTitle", { name: u.username })} text={t("admin.user.resetText")}
        confirmText={t("admin.user.generate")} cancelText={t("admin.user.cancel")} busy={busy}
        onConfirm={() => void act(async () => setResetLink((await api.resetLink(u.id)).link)).then(() => setDialog(null))} />
      <ConfirmDialog open={dialog === "delete"} onOpenChange={(o) => !o && setDialog(null)} title={t("admin.user.deleteTitle", { name: u.username })} text={t("admin.user.deleteText")}
        confirmText={t("admin.user.deleteConfirm")} cancelText={t("admin.user.cancel")} destructive busy={busy || confirmName !== u.username}
        onConfirm={() => void (async () => {
          if (busy) return;
          setBusy(true);
          try {
            await api.deleteUser(u.id, confirmName, sendZip);
            toast(t("admin.user.deleted"));
            setDialog(null);
            await navigate({ to: "/admin/users" });
            await qc.invalidateQueries({ queryKey: ["admin-users"] });
          } catch (err) {
            toast.error(errorMessage(err, t));
          } finally {
            setBusy(false);
          }
        })()}>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" disabled={!smtp} checked={sendZip} onChange={(e) => setSendZip(e.target.checked)} />
          <span>{t("admin.user.sendZip")}{!smtp && <span className="text-muted-foreground block">{t("admin.user.sendZipOff")}</span>}</span>
        </label>
        <TextField label={t("admin.user.deleteConfirmLabel")} value={confirmName} onChange={setConfirmName} autoComplete="off" />
      </ConfirmDialog>
    </div>
  );
}
```

Route in `router.tsx`: `adminUsersRoute` con `component: UsersPage`; nuova

```tsx
export const adminUserRoute = createRoute({ getParentRoute: () => adminRoute, path: "/users/$userId", component: UserPage });
```

aggiunta a `adminRoute.addChildren([...])`.

Run test/typecheck/lint; commit `feat(web): add admin users pages`.

---

### Task 4: Sistema (configurazione, salute, registro)

**Files:** Create `apps/web/src/pages/admin/{SystemPage,ConfigTab,HealthTab,AuditTab}.tsx`; Test `apps/web/src/pages/admin/system.test.tsx`; Modify `apps/web/src/router.tsx` (`adminSystemRoute` con ricerca `{ tab: "config" | "health" | "audit" }`), i18n.

- [ ] **Step 1: Testi** — aggiungere in `admin` (it):

```json
"system": {
  "title": "Sistema",
  "tabs": { "config": "Configurazione", "health": "Salute", "audit": "Registro" },
  "fromEnv": "Impostato dall'ambiente",
  "save": "Salva",
  "saved": "Salvato.",
  "registration": "Registrazione",
  "registrationClosed": "Chiusa: gli utenti li crei tu",
  "registrationOpen": "Aperta a tutti",
  "limits": "Quote e limiti",
  "defaultQuota": "Quota predefinita (GB, vuoto = illimitata)",
  "maxRetention": "Storico massimo (giorni, 0–90)",
  "maxFile": "Dimensione massima di un file (MB)",
  "email": "Email",
  "smtpHost": "Server SMTP",
  "smtpPort": "Porta",
  "smtpSecurity": "Sicurezza",
  "securities": { "none": "Nessuna", "starttls": "STARTTLS", "tls": "TLS" },
  "smtpUser": "Utente",
  "smtpPassword": "Password",
  "smtpPasswordSet": "Impostata: lascia vuoto per non cambiarla",
  "smtpFrom": "Mittente",
  "allowInvalid": "Accetta certificati non validi",
  "allowInvalidWarn": "Sconsigliato: usalo solo per un server interno di cui ti fidi.",
  "smtpTest": "Invia email di prova",
  "smtpTestOk": "Email di prova inviata al tuo indirizzo.",
  "smtpTestFail": "Invio non riuscito:",
  "status": { "ok": "Tutto funziona", "degraded": "Qualcosa va controllato", "down": "Servizio non disponibile" },
  "checkStatus": { "ok": "OK", "warn": "Da controllare", "error": "Errore", "off": "Non configurato" },
  "checks": { "database": "Database", "storage": "Archivio dei file", "disk": "Disco", "jobs": "Attività in coda", "smtp": "Email" },
  "diskValue": "{{percent}}% usato",
  "jobsValue": "{{count}} in coda",
  "version": "Versione {{version}} · {{codename}}",
  "uptime": "Attivo da {{age}}",
  "totals": "Totali",
  "totalUsers": "Utenti",
  "totalVaults": "Vault",
  "totalDevices": "Dispositivi",
  "totalStorage": "Spazio usato",
  "byLevel": "Dispositivi per stato",
  "when": "Quando",
  "actor": "Chi",
  "action": "Azione",
  "target": "Su",
  "newer": "Più recenti",
  "older": "Meno recenti",
  "page": "Pagina {{page}} di {{pages}}",
  "actions": {
    "user_created": "Utente creato", "user_invited": "Utente invitato", "user_blocked": "Utente bloccato", "user_unblocked": "Utente sbloccato",
    "user_deleted": "Utente eliminato", "quota_changed": "Quota cambiata", "role_changed": "Ruolo cambiato",
    "reset_link_created": "Link di reset generato", "config_changed": "Configurazione cambiata", "smtp_test": "Email di prova"
  }
}
```

(en: stesse chiavi — "System"; tabs "Configuration", "Health", "Log"; "Set by the environment"; "Save"; "Saved."; "Registration"; "Closed: you create the users"; "Open to everyone"; "Quotas and limits"; "Default quota (GB, empty = unlimited)"; "Maximum history (days, 0–90)"; "Maximum file size (MB)"; "Email"; "SMTP server"; "Port"; "Security"; securities "None"/"STARTTLS"/"TLS"; "User"; "Password"; "Set: leave empty to keep it"; "Sender"; "Accept invalid certificates"; "Not recommended: only for an internal server you trust."; "Send a test email"; "Test email sent to your address."; "Sending failed:"; status "Everything works"/"Something needs attention"/"Service unavailable"; checkStatus "OK"/"Check"/"Error"/"Not configured"; checks "Database"/"File storage"/"Disk"/"Queued jobs"/"Email"; "{{percent}}% used"; "{{count}} queued"; "Version {{version}} · {{codename}}"; "Up for {{age}}"; "Totals"; "Users"; "Vaults"; "Devices"; "Storage used"; "Devices by status"; "When"; "Who"; "Action"; "On"; "Newer"; "Older"; "Page {{page}} of {{pages}}"; actions "User created", "User invited", "User blocked", "User unblocked", "User deleted", "Quota changed", "Role changed", "Reset link generated", "Configuration changed", "Test email".) Dev: `"smtpFail": "Email di prova fallisce"` / `"Test email fails"`.

- [ ] **Step 2: Test** — `apps/web/src/pages/admin/system.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ad, simulateSmtpFailure } from "../../mocks/admindata.js";
import { signInAs } from "../../mocks/db.js";
import { renderRoute } from "../../test/render.js";

afterEach(cleanup);

describe("Admin system", () => {
  it("config: env fields are locked and labelled", async () => {
    signInAs("admin");
    await renderRoute("/admin/system");
    const maxFile = (await screen.findByLabelText("Dimensione massima di un file (MB)")) as HTMLInputElement;
    expect(maxFile.disabled).toBe(true);
    expect((screen.getByLabelText("Server SMTP") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getAllByText("Impostato dall'ambiente").length).toBeGreaterThanOrEqual(2);
  });

  it("config: save registration and SMTP port; password write-only", async () => {
    signInAs("admin");
    await renderRoute("/admin/system?tab=config");
    fireEvent.click(await screen.findByLabelText("Aperta a tutti"));
    const reg = screen.getByRole("region", { name: "Registrazione" });
    fireEvent.click(within(reg).getByRole("button", { name: "Salva" }));
    await waitFor(() => expect(ad.config.registration.value).toBe("open"));
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Porta"), { target: { value: "465" } });
    const email = screen.getByRole("region", { name: "Email" });
    fireEvent.click(within(email).getByRole("button", { name: "Salva" }));
    await waitFor(() => expect(ad.config.smtp.port.value).toBe(465));
    expect(ad.config.smtp.password).toBe("secret");
  });

  it("test email: success and detailed failure", async () => {
    signInAs("admin");
    await renderRoute("/admin/system");
    fireEvent.click(await screen.findByRole("button", { name: "Invia email di prova" }));
    expect(await screen.findByText("Email di prova inviata al tuo indirizzo.")).toBeDefined();
    simulateSmtpFailure();
    fireEvent.click(screen.getByRole("button", { name: "Invia email di prova" }));
    expect(await screen.findByText(/535 5\.7\.8/)).toBeDefined();
  });

  it("health: status, checks with text, aggregate totals", async () => {
    signInAs("admin");
    await renderRoute("/admin/system?tab=health");
    expect(await screen.findByText("Qualcosa va controllato")).toBeDefined();
    expect(screen.getByText("85% usato")).toBeDefined();
    expect(screen.getByText("Utenti")).toBeDefined();
  });

  it("audit: localized actions and pagination", async () => {
    signInAs("admin");
    await renderRoute("/admin/system?tab=audit");
    expect(await screen.findByText(/Pagina 1 di 2/)).toBeDefined();
    expect(screen.getAllByText("Utente creato").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Meno recenti" }));
    expect(await screen.findByText(/Pagina 2 di 2/)).toBeDefined();
  });
});
```

- [ ] **Step 3: Implementazione**

`apps/web/src/pages/admin/ConfigTab.tsx`:

```tsx
import type { ConfigPatch, ConfigSource, SystemConfig } from "@kamino/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function Section({ title, children, onSave, busy }: { title: string; children: ReactNode; onSave?: () => void; busy?: boolean }) {
  const { t } = useTranslation();
  return (
    <section aria-label={title} className="bg-card space-y-3 rounded-xl border p-4">
      <h2 className="font-serif text-lg font-semibold">{title}</h2>
      {children}
      {onSave && <Button disabled={busy} onClick={onSave}>{t("admin.system.save")}</Button>}
    </section>
  );
}

/** E-03: env values are locked and say so. */
function Locked({ source }: { source: ConfigSource }) {
  const { t } = useTranslation();
  return source === "env" ? <span className="text-muted-foreground text-xs">{t("admin.system.fromEnv")}</span> : null;
}

function Field({ label, source, value, onChange, type = "text", placeholder }: { label: string; source: ConfigSource; value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} disabled={source === "env"} onChange={(e) => onChange(e.target.value)} {...(placeholder ? { placeholder } : {})} />
      <Locked source={source} />
    </div>
  );
}

export function ConfigTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ["admin-config"], queryFn: api.adminConfig });
  const c = config.data;
  const [form, setForm] = useState({ registration: "closed", quota: "", retention: "", maxFile: "", host: "", port: "", security: "starttls", user: "", password: "", from: "", allowInvalid: false });
  useEffect(() => {
    if (!c) return;
    setForm({
      registration: c.registration.value,
      quota: c.defaultQuotaBytes.value === null ? "" : String(c.defaultQuotaBytes.value / GB),
      retention: String(c.maxRetentionDays.value),
      maxFile: String(Math.round(c.maxFileBytes.value / MB)),
      host: c.smtp.host.value, port: String(c.smtp.port.value), security: c.smtp.security.value, user: c.smtp.username.value,
      password: "", from: c.smtp.from.value, allowInvalid: c.smtp.allowInvalidCerts.value,
    });
  }, [c]);
  const save = useMutation({
    mutationFn: (patch: ConfigPatch) => api.updateConfig(patch),
    onSuccess: (next: SystemConfig) => {
      qc.setQueryData(["admin-config"], next);
      toast(t("admin.system.saved"));
    },
    onError: (err) => toast.error(errorMessage(err, t)),
  });
  const test = useMutation({ mutationFn: api.smtpTest, onError: (err) => toast.error(errorMessage(err, t)) });
  if (config.isError) return <p role="alert">{errorMessage(config.error, t)}</p>;
  if (!c) return null;
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  // Only unlocked fields are ever sent (E-03).
  const unlocked = <T,>(source: ConfigSource, value: T): T | undefined => (source === "env" ? undefined : value);
  const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

  return (
    <div className="space-y-4">
      <Section title={t("admin.system.registration")} busy={save.isPending} onSave={() => save.mutate(clean({ registration: unlocked(c.registration.source, form.registration as "closed" | "open") }))}>
        <div role="radiogroup" aria-label={t("admin.system.registration")} className="space-y-1">
          {(["closed", "open"] as const).map((v) => (
            <label key={v} className="flex items-center gap-2">
              <input type="radio" name="registration" disabled={c.registration.source === "env"} checked={form.registration === v} onChange={() => set("registration")(v)} />
              {t(v === "closed" ? "admin.system.registrationClosed" : "admin.system.registrationOpen")}
            </label>
          ))}
          <Locked source={c.registration.source} />
        </div>
      </Section>

      <Section title={t("admin.system.limits")} busy={save.isPending} onSave={() => save.mutate(clean({
        defaultQuotaBytes: unlocked(c.defaultQuotaBytes.source, form.quota === "" ? null : Number(form.quota) * GB),
        maxRetentionDays: unlocked(c.maxRetentionDays.source, Number(form.retention)),
        maxFileBytes: unlocked(c.maxFileBytes.source, Math.round(Number(form.maxFile) * MB)),
      }))}>
        <Field label={t("admin.system.defaultQuota")} source={c.defaultQuotaBytes.source} value={form.quota} onChange={set("quota")} type="number" />
        <Field label={t("admin.system.maxRetention")} source={c.maxRetentionDays.source} value={form.retention} onChange={set("retention")} type="number" />
        <Field label={t("admin.system.maxFile")} source={c.maxFileBytes.source} value={form.maxFile} onChange={set("maxFile")} type="number" />
      </Section>

      <Section title={t("admin.system.email")} busy={save.isPending} onSave={() => save.mutate({ smtp: clean({
        host: unlocked(c.smtp.host.source, form.host),
        port: unlocked(c.smtp.port.source, Number(form.port)),
        security: unlocked(c.smtp.security.source, form.security as "none" | "starttls" | "tls"),
        username: unlocked(c.smtp.username.source, form.user),
        from: unlocked(c.smtp.from.source, form.from),
        allowInvalidCerts: unlocked(c.smtp.allowInvalidCerts.source, form.allowInvalid),
        password: form.password === "" ? undefined : unlocked(c.smtp.passwordSource, form.password),
      }) })}>
        <Field label={t("admin.system.smtpHost")} source={c.smtp.host.source} value={form.host} onChange={set("host")} />
        <Field label={t("admin.system.smtpPort")} source={c.smtp.port.source} value={form.port} onChange={set("port")} type="number" />
        <label className="block space-y-1 text-sm">
          <span className="font-medium">{t("admin.system.smtpSecurity")}</span>
          <select value={form.security} disabled={c.smtp.security.source === "env"} onChange={(e) => set("security")(e.target.value)} className="bg-background block rounded-md border px-2 py-1">
            {(["none", "starttls", "tls"] as const).map((s) => <option key={s} value={s}>{t(`admin.system.securities.${s}`)}</option>)}
          </select>
          <Locked source={c.smtp.security.source} />
        </label>
        <Field label={t("admin.system.smtpUser")} source={c.smtp.username.source} value={form.user} onChange={set("user")} />
        <Field label={t("admin.system.smtpPassword")} source={c.smtp.passwordSource} value={form.password} onChange={set("password")} type="password" {...(c.smtp.passwordSet ? { placeholder: t("admin.system.smtpPasswordSet") } : {})} />
        <Field label={t("admin.system.smtpFrom")} source={c.smtp.from.source} value={form.from} onChange={set("from")} />
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" disabled={c.smtp.allowInvalidCerts.source === "env"} checked={form.allowInvalid} onChange={(e) => setForm((f) => ({ ...f, allowInvalid: e.target.checked }))} />
          <span>{t("admin.system.allowInvalid")}{form.allowInvalid && <span className="text-status-attention block">{t("admin.system.allowInvalidWarn")}</span>}</span>
        </label>
        <div className="space-y-2 border-t pt-3">
          <Button variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>{t("admin.system.smtpTest")}</Button>
          {test.data?.ok === true && <p role="status" className="text-status-safe text-sm">{t("admin.system.smtpTestOk")}</p>}
          {test.data?.ok === false && (
            <p role="alert" className="text-sm">{t("admin.system.smtpTestFail")} <code className="bg-muted rounded px-1">{test.data.error}</code></p>
          )}
        </div>
      </Section>
    </div>
  );
}
```

`apps/web/src/pages/admin/HealthTab.tsx`:

```tsx
import type { HealthCheck, Level } from "@kamino/protocol";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { LEVEL_CLASSES } from "../../components/status/status-icons.js";
import { LevelBadge } from "../../components/status/LevelBadge.js";
import { formatAgo, formatBytes } from "../../lib/format.js";
import { cn } from "../../lib/utils.js";

const STATUS_LEVEL: Record<"ok" | "degraded" | "down", Level> = { ok: "safe", degraded: "attention", down: "blocked" };
const CHECK_LEVEL: Record<HealthCheck["status"], Level> = { ok: "safe", warn: "attention", error: "blocked", off: "working" };

export function HealthTab() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const health = useQuery({ queryKey: ["admin-health"], queryFn: api.health });
  if (health.isError) return <p role="alert">{errorMessage(health.error, t)}</p>;
  const h = health.data;
  if (!h) return null;
  const value = (c: HealthCheck) =>
    c.name === "disk" && c.value !== undefined ? t("admin.system.diskValue", { percent: Math.round(c.value * 100) })
      : c.name === "jobs" && c.value !== undefined ? t("admin.system.jobsValue", { count: c.value }) : "";
  return (
    <div className="space-y-4">
      <section className="bg-card space-y-1 rounded-xl border p-4">
        <p className={cn("inline-block rounded-full px-3 py-1 text-sm font-medium", LEVEL_CLASSES[STATUS_LEVEL[h.status]])}>{t(`admin.system.status.${h.status}`)}</p>
        <p className="text-muted-foreground text-sm">
          {t("admin.system.version", { version: h.version, codename: h.codename })} · {t("admin.system.uptime", { age: formatAgo(new Date(Date.now() - h.uptimeSeconds * 1000).toISOString(), lang) })}
        </p>
      </section>
      <ul className="bg-card divide-y rounded-xl border">
        {h.checks.map((c) => (
          <li key={c.name} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
            <span>{t(`admin.system.checks.${c.name}`)} {value(c) && <span className="text-muted-foreground">· {value(c)}</span>}</span>
            <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", LEVEL_CLASSES[CHECK_LEVEL[c.status]])}>{t(`admin.system.checkStatus.${c.status}`)}</span>
          </li>
        ))}
      </ul>
      <section className="bg-card space-y-3 rounded-xl border p-4">
        <h2 className="font-serif text-lg font-semibold">{t("admin.system.totals")}</h2>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          {([
            [t("admin.system.totalUsers"), String(h.totals.users)],
            [t("admin.system.totalVaults"), String(h.totals.vaults)],
            [t("admin.system.totalDevices"), String(h.totals.devices)],
            [t("admin.system.totalStorage"), formatBytes(h.totals.storageBytes, lang)],
          ] as Array<[string, string]>).map(([k, v]) => (
            <div key={k}><dt className="text-muted-foreground">{k}</dt><dd className="text-lg font-semibold">{v}</dd></div>
          ))}
        </dl>
        <h3 className="text-sm font-medium">{t("admin.system.byLevel")}</h3>
        <ul className="flex flex-wrap gap-2">
          {(Object.entries(h.totals.devicesByLevel) as Array<[Level, number]>).map(([level, n]) => (
            <li key={level} className="flex items-center gap-1"><LevelBadge level={level} /> <span className="text-sm">{n}</span></li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

`apps/web/src/pages/admin/AuditTab.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { Button } from "../../components/ui/button.js";
import { formatDateTime } from "../../lib/format.js";

export function AuditTab() {
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState(1);
  const audit = useQuery({ queryKey: ["admin-audit", page], queryFn: () => api.audit(page) });
  if (audit.isError) return <p role="alert">{errorMessage(audit.error, t)}</p>;
  const d = audit.data;
  if (!d) return null;
  return (
    <div className="space-y-3">
      <div className="bg-card overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground text-left">
            <tr>{(["when", "actor", "action", "target"] as const).map((k) => <th key={k} scope="col" className="p-3 font-medium">{t(`admin.system.${k}`)}</th>)}</tr>
          </thead>
          <tbody className="divide-y">
            {d.items.map((e) => (
              <tr key={e.id}>
                <td className="p-3 whitespace-nowrap">{formatDateTime(e.at, i18n.language)}</td>
                <td className="p-3">{e.actor}</td>
                <td className="p-3">{t(`admin.system.actions.${e.action}`)}</td>
                <td className="p-3 font-mono text-xs">{e.target}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t("admin.system.newer")}</Button>
        <span className="text-muted-foreground text-sm">{t("admin.system.page", { page: d.page, pages: d.pages })}</span>
        <Button size="sm" variant="outline" disabled={page >= d.pages} onClick={() => setPage((p) => p + 1)}>{t("admin.system.older")}</Button>
      </div>
    </div>
  );
}
```

`apps/web/src/pages/admin/SystemPage.tsx`:

```tsx
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { adminSystemRoute, SYSTEM_TABS, type SystemTab } from "../../router.js";
import { AuditTab } from "./AuditTab.js";
import { ConfigTab } from "./ConfigTab.js";
import { HealthTab } from "./HealthTab.js";

export function SystemPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("admin.system.title"));
  const { tab } = adminSystemRoute.useSearch();
  const navigate = useNavigate();
  const select = (next: SystemTab) => void navigate({ to: "/admin/system", search: { tab: next }, replace: true });
  return (
    <div className="space-y-4">
      <h1 className="font-serif text-2xl font-semibold">{t("admin.system.title")}</h1>
      <div role="tablist" aria-label={t("admin.system.title")} className="flex flex-wrap gap-1 border-b">
        {SYSTEM_TABS.map((id) => (
          <button key={id} role="tab" id={`system-tab-${id}`} aria-selected={tab === id} aria-controls="system-tabpanel" onClick={() => select(id)}
            className={tab === id ? "px-3 py-2 text-sm font-semibold shadow-[inset_0_-2px_0_var(--link)]" : "text-muted-foreground px-3 py-2 text-sm"}>
            {t(`admin.system.tabs.${id}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="system-tabpanel" aria-labelledby={`system-tab-${tab}`}>
        {tab === "config" && <ConfigTab />}
        {tab === "health" && <HealthTab />}
        {tab === "audit" && <AuditTab />}
      </div>
    </div>
  );
}
```

Route in `router.tsx`:

```tsx
export const SYSTEM_TABS = ["config", "health", "audit"] as const;
export type SystemTab = (typeof SYSTEM_TABS)[number];
export const adminSystemRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/system",
  validateSearch: (s: Record<string, unknown>): { tab: SystemTab } => ({
    tab: SYSTEM_TABS.includes(s["tab"] as SystemTab) ? (s["tab"] as SystemTab) : "config",
  }),
  component: SystemPage,
});
```

(La voce "Sistema" della barra laterale porta a `/admin/system` senza ricerca: grazie a `validateSearch` la scheda predefinita è `config`; se il typecheck del `Link` lo richiede, passare `search={{ tab: "config" }}`.)

Run test/typecheck/lint; commit `feat(web): add admin system configuration, health and audit`.

---

### Task 5: Documenti e verifica

- [ ] `docs/ui/design-system.md` §11 "Web app: area admin" (utenti, link mostrati una volta, quota, blocco, eliminazione, configurazione con "Impostato dall'ambiente", email di prova, salute, registro; privacy U-03).
- [ ] HANDOVER: **fase UI completata** (sotto-fasi 1–4c); decisioni Y1–Y5; prossimo passo: piano di M1 (con R16 e le API vere dei contratti `auth`/`account`/`vaults`/…); spike e prove su telefono ancora in sospeso.
- [ ] Changeset `.changeset/web-admin.md` (`"@kamino/web": minor` — "Add the admin area: users, quotas, activation and reset links, system configuration with environment-locked fields, test email, health and audit log.").
- [ ] Verifica completa (build, typecheck, lint, test, format, release-names, Docker), push, CI, revisione finale (un subagente), PR.
