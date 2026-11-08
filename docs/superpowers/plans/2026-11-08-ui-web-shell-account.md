# Fase UI, sotto-fase 4a — Web app: struttura e account — piano di implementazione

> **For agentic workers:** standard del progetto (`CLAUDE.md`): eseguire con superpowers:executing-plans nella sessione corrente, a blocchi con checkpoint solo dove serve una prova del committente; subagent-driven-development solo su richiesta. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** struttura della web app (barra laterale / menu mobile, router con guardie), pagine pubbliche di accesso e setup, configurazione TOTP, pagina Account, su un contratto zod in `@kamino/protocol` con le API simulate da MSW.

**Architecture:** `@kamino/protocol` definisce richieste e risposte (auth, account). La web app usa un client `fetch` vero (`src/api/`) e TanStack Query; TanStack Router dichiara le route con guardie in `beforeLoad`. MSW (`src/mocks/`) simula il server con un database in memoria: service worker in sviluppo, `setupServer` nei test; non entra nella build di produzione.

**Tech Stack:** React 19, TanStack Router + Query, zod 4, MSW 2, Tailwind 4 + shadcn/ui, react-i18next, `uqr`, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-08-ui-web-shell-account-design.md`.

**Blocchi:** (A) Task 1–3 contratto, client, MSW; (B) Task 4 router e struttura → **prova nel browser**; (C) Task 5–6 pagine pubbliche e TOTP; (D) Task 7 Account; (E) Task 8 documenti → **prova finale nel browser**.

## Global Constraints

- TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- Nessun testo UI scritto a mano: `src/i18n/locales/{it,en}.json` (stesse chiavi); nome prodotto da `@kamino/brand`; lessico a tema vietato.
- Componenti shadcn: aggiunti con il CLI, `cn` sempre da `@/lib/utils` (mai il pacchetto npm `cn`); se il CLI modifica `src/index.css`, ripristinarlo.
- Mai bordi laterali colorati; il colore non è mai l'unico segnale; contrasto dai token esistenti.
- Password: mai precompilate, mai in `localStorage`, campo svuotato dopo un errore di accesso.
- Redirect dopo l'accesso solo verso percorsi interni.
- MSW, pannello di sviluppo e galleria solo con `import.meta.env.DEV`; assenti dalla build di produzione (test sulla build).
- Prima di ogni push: `pnpm format:check`.
- Commit Conventional Commits in inglese; documentazione in italiano.

## Review Focus

1. `/login?redirect=https://evil.example` o `//evil.example` → dopo l'accesso si va a `/`. → Task 2, Task 5.
2. Admin con `totpSetupRequired` → qualunque URL porta a `/account/totp-setup`, nessuna navigazione disponibile. → Task 4.
3. Utente non admin su `/admin/users` → pagina "non trovata", nessuna voce Amministrazione. → Task 4.
4. Password dimenticata con email inesistente → stessa risposta di un'email esistente. → Task 3, Task 5.
5. Build di produzione: niente `mockServiceWorker`, niente database finto. → Task 4.

## File Structure

```
packages/protocol/src/auth.ts, account.ts (+ test), errors.ts (codici nuovi), index.ts
apps/web/
  vite.config.ts                    middleware dev per mockServiceWorker.js, setupFiles dei test
  src/api/http.ts (+test)           request, requestVoid, ApiError
  src/api/endpoints.ts              una funzione per rotta
  src/api/redirect.ts (+test)       safeRedirect
  src/api/errors.ts                 errorMessage
  src/mocks/db.ts                   database finto e preset
  src/mocks/handlers.ts (+test)     handler MSW
  src/mocks/browser.ts              setupWorker (solo dev)
  src/mocks/DevPanel.tsx            pannello "Dati finti" (solo dev)
  src/test/setup.ts                 setupServer per Vitest
  src/router.tsx                    albero delle route e guardie
  src/App.tsx                       provider (Query, i18n, tema, router, toast)
  src/main.tsx                      avvio (galleria, MSW, App)
  src/app/AppShell.tsx (+test)      barra laterale, menu mobile, banner di reset
  src/app/useDocumentTitle.ts
  src/pages/PlaceholderPage.tsx, NotFoundPage.tsx
  src/pages/auth/{AuthCard,LoginPage,SetupPage,ForgotPage,ResetPage,InvitePage}.tsx (+test)
  src/components/{PasswordField,LanguageSwitch,RecoveryCodes}.tsx
  src/pages/TotpSetupPage.tsx (+test)
  src/pages/account/{AccountPage,ProfileSection,PasswordSection,TotpSection,SessionsSection,SecurityLogSection}.tsx (+test)
  src/test/render.tsx               helper: renderRoute(path)
```

---

### Task 1: Contratto in `@kamino/protocol`

**Files:**
- Create: `packages/protocol/src/auth.ts`, `packages/protocol/src/account.ts`, `packages/protocol/src/auth.test.ts`
- Modify: `packages/protocol/src/errors.ts`, `packages/protocol/src/index.ts`

**Interfaces:**
- Produces: `PASSWORD_MIN`, `Password`, `Username`, `Email`, `Lang`, `Theme`, `Role`, `Me`, `SetupStatus`, `SetupRequest`, `LoginRequest`, `LoginResponse`, `TotpLoginRequest`, `ForgotRequest`, `ForgotResponse`, `ResetRequest`, `InviteInfo`, `InviteAccept` (auth); `ProfilePatch`, `PasswordChange`, `TotpSetupInfo`, `TotpConfirm`, `RecoveryCodes`, `PasswordConfirm`, `SessionInfo`, `SessionList`, `SecurityEventType`, `SecurityEvent`, `SecurityLogPage`, `Level`, `VaultsSummary` (account), ognuno con il tipo omonimo (`z.infer`).

- [ ] **Step 1: Test (falliscono)**

`packages/protocol/src/auth.test.ts`:

```ts
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
    expect(SetupRequest.safeParse({ ...base, password: "x".repeat(12), email: "nope" }).success).toBe(false);
  });

  it("login answers ok or totp_required", () => {
    expect(LoginResponse.parse({ status: "ok", me })).toMatchObject({ status: "ok" });
    expect(LoginResponse.parse({ status: "totp_required", challengeId: "c" })).toMatchObject({ status: "totp_required" });
    expect(LoginResponse.safeParse({ status: "maybe" }).success).toBe(false);
  });

  it("TOTP confirm takes 6 digits; recovery codes are exactly 10", () => {
    expect(TotpConfirm.safeParse({ code: "123456" }).success).toBe(true);
    expect(TotpConfirm.safeParse({ code: "12345a" }).success).toBe(false);
    expect(RecoveryCodes.safeParse({ recoveryCodes: Array(10).fill("AAAA-1111") }).success).toBe(true);
    expect(RecoveryCodes.safeParse({ recoveryCodes: Array(9).fill("AAAA-1111") }).success).toBe(false);
  });

  it("security log pages and vault summary", () => {
    expect(SecurityLogPage.safeParse({ items: [{ id: "e", type: "login", at: "2026-11-08T10:00:00Z" }], page: 1, pages: 1 }).success).toBe(true);
    expect(SecurityLogPage.safeParse({ items: [{ id: "e", type: "hack", at: "x" }], page: 1, pages: 1 }).success).toBe(false);
    expect(VaultsSummary.safeParse({ vaults: [{ id: "v", name: "Note", level: "decision", conflicts: 2 }] }).success).toBe(true);
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
```

Run: `pnpm --filter @kamino/protocol test` → FAIL.

- [ ] **Step 2: Implementazione**

`packages/protocol/src/auth.ts`:

```ts
import { z } from "zod";

/** Minimum password length (client and server). */
export const PASSWORD_MIN = 12;

export const Password = z.string().min(PASSWORD_MIN).max(1024);
export const Username = z.string().trim().min(1).max(64);
export const Email = z.email().max(254);
export const Lang = z.enum(["it", "en"]);
export type Lang = z.infer<typeof Lang>;
export const Theme = z.enum(["light", "dark", "system"]);
export type Theme = z.infer<typeof Theme>;
export const Role = z.enum(["user", "admin"]);
export type Role = z.infer<typeof Role>;

export const Me = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string(),
  role: Role,
  lang: Lang,
  theme: Theme,
  totpEnabled: z.boolean(),
  /** Admins without TOTP must configure it before anything else (U-07). */
  totpSetupRequired: z.boolean(),
  /** ISO date of a password reset started by an admin, shown once to the user (U-09). */
  adminResetAt: z.string().nullable(),
});
export type Me = z.infer<typeof Me>;

export const SetupStatus = z.object({ needed: z.boolean() });
export type SetupStatus = z.infer<typeof SetupStatus>;

export const SetupRequest = z.object({ token: z.string().min(1), username: Username, email: Email, password: Password });
export type SetupRequest = z.infer<typeof SetupRequest>;

export const LoginRequest = z.object({ username: Username, password: z.string().min(1) });
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), me: Me }),
  z.object({ status: z.literal("totp_required"), challengeId: z.string() }),
]);
export type LoginResponse = z.infer<typeof LoginResponse>;

/** TOTP code (6 digits) or a recovery code. */
export const TotpLoginRequest = z.object({ challengeId: z.string(), code: z.string().trim().min(6).max(32) });
export type TotpLoginRequest = z.infer<typeof TotpLoginRequest>;

export const ForgotRequest = z.object({ email: Email });
export type ForgotRequest = z.infer<typeof ForgotRequest>;
/** Same answer whether the email exists or not; smtp=false means "ask the admin". */
export const ForgotResponse = z.object({ smtp: z.boolean() });
export type ForgotResponse = z.infer<typeof ForgotResponse>;

export const ResetRequest = z.object({ token: z.string().min(1), password: Password });
export type ResetRequest = z.infer<typeof ResetRequest>;

export const InviteInfo = z.object({ username: z.string(), email: z.string() });
export type InviteInfo = z.infer<typeof InviteInfo>;
export const InviteAccept = z.object({ password: Password });
export type InviteAccept = z.infer<typeof InviteAccept>;
```

`packages/protocol/src/account.ts`:

```ts
import { z } from "zod";
import { Email, Lang, Password, Theme } from "./auth.js";

export const ProfilePatch = z.object({ email: Email.optional(), lang: Lang.optional(), theme: Theme.optional() });
export type ProfilePatch = z.infer<typeof ProfilePatch>;

export const PasswordChange = z.object({ current: z.string().min(1), next: Password });
export type PasswordChange = z.infer<typeof PasswordChange>;

export const TotpSetupInfo = z.object({ secret: z.string(), otpauthUrl: z.string() });
export type TotpSetupInfo = z.infer<typeof TotpSetupInfo>;

export const TotpConfirm = z.object({ code: z.string().regex(/^\d{6}$/) });
export type TotpConfirm = z.infer<typeof TotpConfirm>;

export const RecoveryCodes = z.object({ recoveryCodes: z.array(z.string()).length(10) });
export type RecoveryCodes = z.infer<typeof RecoveryCodes>;

export const PasswordConfirm = z.object({ password: z.string().min(1) });
export type PasswordConfirm = z.infer<typeof PasswordConfirm>;

export const SessionInfo = z.object({
  id: z.string(),
  current: z.boolean(),
  /** "Firefox · macOS": described by the server, never raw user agents. */
  client: z.string(),
  /** Truncated IP, e.g. "192.168.1.x": never a location. */
  ipPrefix: z.string(),
  lastUsedAt: z.string(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;
export const SessionList = z.array(SessionInfo);

export const SecurityEventType = z.enum([
  "login",
  "login_failed",
  "device_linked",
  "password_changed",
  "admin_reset",
  "totp_enabled",
  "totp_disabled",
]);
export type SecurityEventType = z.infer<typeof SecurityEventType>;
export const SecurityEvent = z.object({
  id: z.string(),
  type: SecurityEventType,
  at: z.string(),
  client: z.string().optional(),
});
export type SecurityEvent = z.infer<typeof SecurityEvent>;
export const SecurityLogPage = z.object({
  items: z.array(SecurityEvent),
  page: z.number().int().min(1),
  pages: z.number().int().min(1),
});
export type SecurityLogPage = z.infer<typeof SecurityLogPage>;

export const Level = z.enum(["safe", "working", "attention", "decision", "blocked"]);
export const VaultsSummary = z.object({
  vaults: z.array(z.object({ id: z.string(), name: z.string(), level: Level, conflicts: z.number().int().min(0) })),
});
export type VaultsSummary = z.infer<typeof VaultsSummary>;
```

`packages/protocol/src/errors.ts`: aggiungere all'enum di `ErrorCode`, prima di `"unauthorized"`:

```ts
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
```

`packages/protocol/src/index.ts`: aggiungere `export * from "./auth.js";` e `export * from "./account.js";`.

Run: `pnpm --filter @kamino/protocol test && pnpm --filter @kamino/protocol build && pnpm --filter @kamino/protocol typecheck && pnpm --filter @kamino/protocol lint` → verdi. (Se `z.email()` non esiste nella versione di zod installata, usare `z.string().email()`.)

```bash
git add packages/protocol
git commit -m "feat(protocol): add auth and account contract"
```

---

### Task 2: Client HTTP della web app

**Files:**
- Create: `apps/web/src/api/http.ts`, `apps/web/src/api/endpoints.ts`, `apps/web/src/api/redirect.ts`, `apps/web/src/api/errors.ts`
- Test: `apps/web/src/api/http.test.ts`, `apps/web/src/api/redirect.test.ts`
- Modify: `apps/web/package.json` (dipendenze)

**Interfaces:**
- Produces: `API_BASE`, `class ApiError { code: ErrorCode; status: number }`, `request<T>(schema: z.ZodType<T>, path: string, init?: RequestOptions): Promise<T>`, `requestVoid(path, init?): Promise<void>`, `RequestOptions { method?: string; body?: unknown; signal?: AbortSignal }`; `api` (oggetto con una funzione per rotta, nomi in Step 4); `safeRedirect(value: unknown): string`; `errorMessage(err: unknown, t: TFunction): string`.

- [ ] **Step 1: Dipendenze**

```bash
pnpm --filter @kamino/web add @tanstack/react-query @tanstack/react-router zod uqr
pnpm --filter @kamino/web add -D msw
```

(`zod` alla stessa versione maggiore di `@kamino/protocol`.)

- [ ] **Step 2: Test (falliscono)**

`apps/web/src/api/redirect.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { safeRedirect } from "./redirect.js";

describe("safeRedirect", () => {
  it.each([
    ["/account", "/account"],
    ["/vaults?x=1", "/vaults?x=1"],
    ["//evil.example", "/"],
    ["/\\evil.example", "/"],
    ["https://evil.example", "/"],
    ["account", "/"],
    [undefined, "/"],
    [42, "/"],
    ["/login", "/"],
  ])("%s -> %s", (value, expected) => {
    expect(safeRedirect(value)).toBe(expected);
  });
});
```

`apps/web/src/api/http.test.ts`:

```ts
// @vitest-environment jsdom
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, request, requestVoid } from "./http.js";

function stub(status: number, body: unknown) {
  const fn = vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status })),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("request", () => {
  it("parses a valid response and sends cookies", async () => {
    const fn = stub(200, { a: 1 });
    expect(await request(z.object({ a: z.number() }), "/x")).toEqual({ a: 1 });
    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe(`${window.location.origin}/api/v1/x`);
    expect(init?.credentials).toBe("include");
    expect((init?.headers as Record<string, string>)["x-requested-with"]).toBeUndefined();
  });

  it("writes carry the anti-CSRF header and a JSON body", async () => {
    const fn = stub(200, { a: 1 });
    await request(z.object({ a: z.number() }), "/x", { method: "POST", body: { b: 2 } });
    const init = fn.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)["x-requested-with"]).toBe("kamino-web");
    expect(init.body).toBe('{"b":2}');
  });

  it("a non-conforming response is an internal error", async () => {
    stub(200, { a: "no" });
    await expect(request(z.object({ a: z.number() }), "/x")).rejects.toMatchObject({ code: "internal", status: 200 });
  });

  it("error bodies become ApiError with their code", async () => {
    stub(401, { error: { code: "invalid_credentials", message: "x", retryable: false } });
    const err = await request(z.object({}), "/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "invalid_credentials", status: 401 });
  });

  it("a bare 401 is unauthorized", async () => {
    stub(401, undefined);
    await expect(requestVoid("/x")).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("requestVoid accepts 204", async () => {
    stub(204, undefined);
    await expect(requestVoid("/x", { method: "DELETE" })).resolves.toBeUndefined();
  });
});
```

Run: `pnpm --filter @kamino/web test -- api` → FAIL.

- [ ] **Step 3: Implementazione**

`apps/web/src/api/http.ts`:

```ts
import { PRODUCT_SLUG } from "@kamino/brand";
import { ErrorBody, type ErrorCode } from "@kamino/protocol";
import type { z } from "zod";

export const API_BASE = "/api/v1";
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Anti-CSRF marker on writes (verified by the server from M1). */
const CSRF_HEADER_VALUE = `${PRODUCT_SLUG}-web`;

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (WRITE_METHODS.has(method)) headers["x-requested-with"] = CSRF_HEADER_VALUE;
  const res = await fetch(new URL(`${API_BASE}${path}`, window.location.origin), {
    method,
    headers,
    credentials: "include",
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (res.ok) return res;
  let code: ErrorCode = res.status === 401 ? "unauthorized" : "internal";
  try {
    const parsed = ErrorBody.safeParse(await res.json());
    if (parsed.success) code = parsed.data.error.code;
  } catch {
    // no JSON body: keep the status-based code
  }
  throw new ApiError(code, res.status);
}

/** Typed request: the response must match the schema, otherwise it is an "internal" error. */
export async function request<T>(schema: z.ZodType<T>, path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(path, opts);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError("internal", res.status);
  return parsed.data;
}

export async function requestVoid(path: string, opts: RequestOptions = {}): Promise<void> {
  await send(path, opts);
}
```

`apps/web/src/api/redirect.ts`:

```ts
const PUBLIC_PREFIXES = ["/login", "/setup", "/forgot", "/reset", "/invite"];

/** Only internal paths: never another origin ("//x", "/\\x", "https://x"), never back to a public page. */
export function safeRedirect(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (PUBLIC_PREFIXES.some((p) => value === p || value.startsWith(`${p}/`) || value.startsWith(`${p}?`))) return "/";
  return value;
}
```

`apps/web/src/api/errors.ts`:

```ts
import type { TFunction } from "i18next";
import { ApiError } from "./http.js";

/** User-facing message for any error; unknown codes fall back to a generic text. */
export function errorMessage(err: unknown, t: TFunction): string {
  const code = err instanceof ApiError ? err.code : "internal";
  return t(`errors.${code}`, { defaultValue: t("errors.generic") });
}
```

- [ ] **Step 4: Endpoint**

`apps/web/src/api/endpoints.ts`:

```ts
import {
  ForgotResponse,
  InviteInfo,
  LoginResponse,
  Me,
  RecoveryCodes,
  SecurityLogPage,
  SessionList,
  SetupStatus,
  TotpSetupInfo,
  VaultsSummary,
  type ProfilePatch,
  type SetupRequest,
} from "@kamino/protocol";
import { request, requestVoid } from "./http.js";

/** One function per route of the contract (spec §3). */
export const api = {
  setupStatus: () => request(SetupStatus, "/setup/status"),
  setup: (body: SetupRequest) => request(Me, "/setup", { method: "POST", body }),
  login: (username: string, password: string) =>
    request(LoginResponse, "/auth/login", { method: "POST", body: { username, password } }),
  loginTotp: (challengeId: string, code: string) =>
    request(Me, "/auth/totp", { method: "POST", body: { challengeId, code } }),
  logout: () => requestVoid("/auth/logout", { method: "POST" }),
  me: () => request(Me, "/me"),
  forgot: (email: string) => request(ForgotResponse, "/auth/forgot", { method: "POST", body: { email } }),
  reset: (token: string, password: string) =>
    requestVoid("/auth/reset", { method: "POST", body: { token, password } }),
  invite: (token: string) => request(InviteInfo, `/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, password: string) =>
    request(Me, `/invites/${encodeURIComponent(token)}/accept`, { method: "POST", body: { password } }),
  updateProfile: (body: ProfilePatch) => request(Me, "/account/profile", { method: "PATCH", body }),
  changePassword: (current: string, next: string) =>
    requestVoid("/account/password", { method: "POST", body: { current, next } }),
  totpSetup: () => request(TotpSetupInfo, "/account/totp/setup", { method: "POST" }),
  totpConfirm: (code: string) => request(RecoveryCodes, "/account/totp/confirm", { method: "POST", body: { code } }),
  totpDisable: (password: string) => requestVoid("/account/totp/disable", { method: "POST", body: { password } }),
  regenerateRecoveryCodes: (password: string) =>
    request(RecoveryCodes, "/account/totp/recovery-codes", { method: "POST", body: { password } }),
  sessions: () => request(SessionList, "/account/sessions"),
  endSession: (id: string) => requestVoid(`/account/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  endOtherSessions: () => requestVoid("/account/sessions", { method: "DELETE" }),
  securityLog: (page: number) => request(SecurityLogPage, `/account/security-log?page=${page}`),
  vaultsSummary: () => request(VaultsSummary, "/vaults/summary"),
};
```

Run: `pnpm --filter @kamino/web test -- api && pnpm --filter @kamino/web typecheck && pnpm --filter @kamino/web lint` → verdi.

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): add typed HTTP client for the auth and account API"
```

---

### Task 3: Server finto con MSW

**Files:**
- Create: `apps/web/src/mocks/db.ts`, `apps/web/src/mocks/handlers.ts`, `apps/web/src/test/setup.ts`
- Test: `apps/web/src/mocks/handlers.test.ts`
- Modify: `apps/web/vite.config.ts` (`setupFiles`)

**Interfaces:**
- Produces: `db` (stato), `resetDb(preset?: "default" | "empty")`, `TEST_TOTP = "123456"`, `TEST_RECOVERY_CODES: string[]`, `signInAs(username: string): void` (per il pannello di sviluppo e i test), `handlers` (array MSW), `server` (in `src/test/setup.ts`, avviato per tutti i test).

- [ ] **Step 1: Database finto**

`apps/web/src/mocks/db.ts`:

```ts
import type { Lang, Role, SecurityEventType, Theme } from "@kamino/protocol";

// Fake server state for development and tests. Plain-text passwords exist ONLY here.

export const TEST_TOTP = "123456";
export const TEST_SECRET = "JBSWY3DPEHPK3PXP";
export const TEST_RECOVERY_CODES = Array.from({ length: 10 }, (_, i) => `AAAA-${String(1111 + i)}`);
export const SETUP_TOKEN = "setup-token";

export interface FakeUser {
  id: string;
  username: string;
  email: string;
  password: string;
  role: Role;
  lang: Lang;
  theme: Theme;
  totpEnabled: boolean;
  totpSetupRequired: boolean;
  adminResetAt: string | null;
  locked: boolean;
  recoveryCodes: string[];
}

export interface FakeSession {
  id: string;
  userId: string;
  client: string;
  ipPrefix: string;
  lastUsedAt: string;
}

export interface FakeEvent {
  id: string;
  userId: string;
  type: SecurityEventType;
  at: string;
  client?: string;
}

interface Db {
  users: FakeUser[];
  sessions: FakeSession[];
  /** The fake browser's session (MSW simulates a single browser; no cookie jar). */
  currentSessionId: string | null;
  challenges: Map<string, { userId: string; expiresAt: number }>;
  invites: Map<string, { username: string; email: string }>;
  resets: Map<string, string>;
  events: FakeEvent[];
  smtp: boolean;
  seq: number;
}

export const db: Db = {
  users: [],
  sessions: [],
  currentSessionId: null,
  challenges: new Map(),
  invites: new Map(),
  resets: new Map(),
  events: [],
  smtp: true,
  seq: 0,
};

export const nextId = (prefix: string): string => `${prefix}-${++db.seq}`;
const iso = (msAgo: number) => new Date(Date.UTC(2026, 10, 8, 10, 0) - msAgo).toISOString();

function user(over: Partial<FakeUser> & Pick<FakeUser, "username" | "password">): FakeUser {
  return {
    id: nextId("u"),
    email: `${over.username}@example.com`,
    role: "user",
    lang: "it",
    theme: "system",
    totpEnabled: false,
    totpSetupRequired: false,
    adminResetAt: null,
    locked: false,
    recoveryCodes: [],
    ...over,
  };
}

export function resetDb(preset: "default" | "empty" = "default"): void {
  db.users = [];
  db.sessions = [];
  db.currentSessionId = null;
  db.challenges = new Map();
  db.invites = new Map();
  db.resets = new Map();
  db.events = [];
  db.smtp = true;
  db.seq = 0;
  if (preset === "empty") return;

  const admin = user({
    username: "admin",
    password: "admin-password-1",
    role: "admin",
    totpEnabled: true,
    recoveryCodes: [...TEST_RECOVERY_CODES],
  });
  const demo = user({ username: "demo", password: "demo-password-1", lang: "en" });
  db.users.push(
    admin,
    demo,
    user({ username: "newadmin", password: "newadmin-pass-1", role: "admin", totpSetupRequired: true }),
    user({ username: "locked", password: "locked-password-1", locked: true }),
    user({ username: "reset", password: "reset-password-1", adminResetAt: iso(2 * 3_600_000) }),
  );
  db.sessions.push(
    { id: nextId("s"), userId: admin.id, client: "Safari · iPhone", ipPrefix: "10.0.0.x", lastUsedAt: iso(3_600_000) },
    { id: nextId("s"), userId: admin.id, client: "Firefox · Windows", ipPrefix: "192.168.1.x", lastUsedAt: iso(86_400_000) },
  );
  db.invites.set("invite-token", { username: "invited", email: "invited@example.com" });
  db.resets.set("reset-token", demo.id);
  const types: SecurityEventType[] = ["login", "login_failed", "device_linked", "password_changed", "totp_enabled"];
  for (let i = 0; i < 30; i++) {
    db.events.push({
      id: nextId("e"),
      userId: admin.id,
      type: types[i % types.length]!,
      at: iso(i * 3_600_000),
      client: i % 2 === 0 ? "Firefox · macOS" : "Obsidian · iPhone",
    });
  }
}

/** Opens a session for the fake browser. */
export function openSession(u: FakeUser): void {
  const s: FakeSession = { id: nextId("s"), userId: u.id, client: "Firefox · macOS", ipPrefix: "127.0.0.x", lastUsedAt: iso(0) };
  db.sessions.push(s);
  db.currentSessionId = s.id;
  addEvent(u.id, "login");
}

export function addEvent(userId: string, type: SecurityEventType): void {
  db.events.unshift({ id: nextId("e"), userId, type, at: new Date().toISOString(), client: "Firefox · macOS" });
}

export function currentUser(): FakeUser | null {
  const s = db.sessions.find((x) => x.id === db.currentSessionId);
  return s ? (db.users.find((u) => u.id === s.userId) ?? null) : null;
}

/** Dev panel / tests: sign in directly, skipping the forms. */
export function signInAs(username: string): void {
  const u = db.users.find((x) => x.username === username);
  if (u) openSession(u);
}

resetDb();
```

- [ ] **Step 2: Test degli handler (falliscono)**

`apps/web/src/mocks/handlers.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { api } from "../api/endpoints.js";
import { ApiError } from "../api/http.js";
import { db, resetDb, signInAs, TEST_RECOVERY_CODES, TEST_TOTP } from "./db.js";

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ApiError ? e.code : "?"));

describe("fake API", () => {
  it("setup only on an empty server, with the right token", async () => {
    expect(await api.setupStatus()).toEqual({ needed: false });
    expect(await code(api.setup({ token: "setup-token", username: "x", email: "x@example.com", password: "x".repeat(12) }))).toBe("setup_not_needed");
    resetDb("empty");
    expect(await api.setupStatus()).toEqual({ needed: true });
    expect(await code(api.setup({ token: "wrong", username: "x", email: "x@example.com", password: "x".repeat(12) }))).toBe("setup_token_invalid");
    const me = await api.setup({ token: "setup-token", username: "boss", email: "boss@example.com", password: "boss-password-1" });
    expect(me).toMatchObject({ username: "boss", role: "admin", totpSetupRequired: true });
  });

  it("login: credentials, blocked user, TOTP and recovery codes", async () => {
    expect(await code(api.login("demo", "nope"))).toBe("invalid_credentials");
    expect(await code(api.login("ghost", "whatever"))).toBe("invalid_credentials");
    expect(await code(api.login("locked", "locked-password-1"))).toBe("user_blocked");
    expect(await api.login("demo", "demo-password-1")).toMatchObject({ status: "ok", me: { username: "demo" } });
    const r = await api.login("admin", "admin-password-1");
    if (r.status !== "totp_required") throw new Error("expected totp");
    expect(await code(api.loginTotp(r.challengeId, "000000"))).toBe("totp_invalid");
    expect(await api.loginTotp(r.challengeId, TEST_TOTP)).toMatchObject({ username: "admin" });
    const r2 = await api.login("admin", "admin-password-1");
    if (r2.status !== "totp_required") throw new Error("expected totp");
    await api.loginTotp(r2.challengeId, TEST_RECOVERY_CODES[0]!);
    expect(db.users.find((u) => u.username === "admin")!.recoveryCodes).not.toContain(TEST_RECOVERY_CODES[0]);
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
    expect(await api.invite("invite-token")).toEqual({ username: "invited", email: "invited@example.com" });
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
```

Run → FAIL (`handlers` e `setup` mancanti).

- [ ] **Step 3: Handler e setup dei test**

`apps/web/src/mocks/handlers.ts`:

```ts
import { PRODUCT_NAME } from "@kamino/brand";
import {
  ForgotRequest,
  InviteAccept,
  LoginRequest,
  PasswordChange,
  PasswordConfirm,
  ProfilePatch,
  ResetRequest,
  SetupRequest,
  TotpConfirm,
  TotpLoginRequest,
  type ErrorCode,
  type Me,
} from "@kamino/protocol";
import { http, HttpResponse } from "msw";
import type { z } from "zod";
import {
  addEvent,
  currentUser,
  db,
  nextId,
  openSession,
  SETUP_TOKEN,
  TEST_SECRET,
  TEST_TOTP,
  type FakeUser,
} from "./db.js";

const API = "*/api/v1";

function fail(status: number, code: ErrorCode) {
  return HttpResponse.json({ error: { code, message: code, retryable: false } }, { status });
}

function toMe(u: FakeUser): Me {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    lang: u.lang,
    theme: u.theme,
    totpEnabled: u.totpEnabled,
    totpSetupRequired: u.totpSetupRequired,
    adminResetAt: u.adminResetAt,
  };
}

/** Validates the request body with the contract schema; weak passwords get their own code. */
async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T | Response> {
  const parsed = schema.safeParse(await req.json().catch(() => undefined));
  if (parsed.success) return parsed.data;
  const weak = parsed.error.issues.some((i) => i.path.includes("password") || i.path.includes("next"));
  return fail(400, weak ? "password_weak" : "internal");
}

function auth(): FakeUser | Response {
  return currentUser() ?? fail(401, "unauthorized");
}

const codes = () => Array.from({ length: 10 }, () => `${nextId("R").slice(2).padStart(4, "B")}-${String(Math.floor(1000 + Math.random() * 8999))}`);

export const handlers = [
  http.get(`*/version`, () =>
    HttpResponse.json({ version: "0.0.0", codename: "Ash", protocol: { min: 1, max: 1 }, commit: "dev", buildDate: new Date(0).toISOString() }),
  ),
  http.get(`${API}/setup/status`, () => HttpResponse.json({ needed: db.users.length === 0 })),
  http.post(`${API}/setup`, async ({ request }) => {
    if (db.users.length > 0) return fail(409, "setup_not_needed");
    const b = await body(request, SetupRequest);
    if (b instanceof Response) return b;
    if (b.token !== SETUP_TOKEN) return fail(403, "setup_token_invalid");
    const u: FakeUser = {
      id: nextId("u"), username: b.username, email: b.email, password: b.password, role: "admin", lang: "it", theme: "system",
      totpEnabled: false, totpSetupRequired: true, adminResetAt: null, locked: false, recoveryCodes: [],
    };
    db.users.push(u);
    openSession(u);
    return HttpResponse.json(toMe(u));
  }),
  http.post(`${API}/auth/login`, async ({ request }) => {
    const b = await body(request, LoginRequest);
    if (b instanceof Response) return b;
    const u = db.users.find((x) => x.username === b.username);
    if (!u || u.password !== b.password) {
      if (u) addEvent(u.id, "login_failed");
      return fail(401, "invalid_credentials");
    }
    if (u.locked) return fail(403, "user_blocked");
    if (u.totpEnabled) {
      const challengeId = nextId("ch");
      db.challenges.set(challengeId, { userId: u.id, expiresAt: Date.now() + 5 * 60_000 });
      return HttpResponse.json({ status: "totp_required", challengeId });
    }
    openSession(u);
    return HttpResponse.json({ status: "ok", me: toMe(u) });
  }),
  http.post(`${API}/auth/totp`, async ({ request }) => {
    const b = await body(request, TotpLoginRequest);
    if (b instanceof Response) return b;
    const ch = db.challenges.get(b.challengeId);
    const u = ch && ch.expiresAt > Date.now() ? db.users.find((x) => x.id === ch.userId) : undefined;
    if (!u) return fail(401, "challenge_expired");
    const recovery = u.recoveryCodes.indexOf(b.code);
    if (b.code !== TEST_TOTP && recovery < 0) return fail(401, "totp_invalid");
    if (recovery >= 0) u.recoveryCodes.splice(recovery, 1);
    db.challenges.delete(b.challengeId);
    openSession(u);
    return HttpResponse.json(toMe(u));
  }),
  http.post(`${API}/auth/logout`, () => {
    db.sessions = db.sessions.filter((s) => s.id !== db.currentSessionId);
    db.currentSessionId = null;
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`${API}/me`, () => {
    const u = auth();
    return u instanceof Response ? u : HttpResponse.json(toMe(u));
  }),
  http.post(`${API}/auth/forgot`, async ({ request }) => {
    const b = await body(request, ForgotRequest);
    if (b instanceof Response) return b;
    return HttpResponse.json({ smtp: db.smtp });
  }),
  http.post(`${API}/auth/reset`, async ({ request }) => {
    const raw = (await request.clone().json().catch(() => ({}))) as { token?: unknown };
    if (raw.token === "expired-token") return fail(410, "token_expired");
    const b = await body(request, ResetRequest);
    if (b instanceof Response) return b;
    const userId = db.resets.get(b.token);
    const u = db.users.find((x) => x.id === userId);
    if (!u) return fail(404, "token_invalid");
    u.password = b.password;
    db.resets.delete(b.token);
    addEvent(u.id, "password_changed");
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`${API}/invites/:token`, ({ params }) => {
    if (params["token"] === "expired-token") return fail(410, "token_expired");
    const inv = db.invites.get(String(params["token"]));
    return inv ? HttpResponse.json(inv) : fail(404, "token_invalid");
  }),
  http.post(`${API}/invites/:token/accept`, async ({ request, params }) => {
    const inv = db.invites.get(String(params["token"]));
    if (!inv) return fail(404, "token_invalid");
    const b = await body(request, InviteAccept);
    if (b instanceof Response) return b;
    const u: FakeUser = {
      id: nextId("u"), username: inv.username, email: inv.email, password: b.password, role: "user", lang: "it", theme: "system",
      totpEnabled: false, totpSetupRequired: false, adminResetAt: null, locked: false, recoveryCodes: [],
    };
    db.users.push(u);
    db.invites.delete(String(params["token"]));
    openSession(u);
    return HttpResponse.json(toMe(u));
  }),
  http.patch(`${API}/account/profile`, async ({ request }) => {
    const u = auth();
    if (u instanceof Response) return u;
    const b = await body(request, ProfilePatch);
    if (b instanceof Response) return b;
    if (b.email !== undefined) u.email = b.email;
    if (b.lang !== undefined) u.lang = b.lang;
    if (b.theme !== undefined) u.theme = b.theme;
    return HttpResponse.json(toMe(u));
  }),
  http.post(`${API}/account/password`, async ({ request }) => {
    const u = auth();
    if (u instanceof Response) return u;
    const raw = (await request.clone().json().catch(() => ({}))) as { current?: unknown };
    if (raw.current !== u.password) return fail(400, "password_wrong");
    const b = await body(request, PasswordChange);
    if (b instanceof Response) return b;
    u.password = b.next;
    u.adminResetAt = null;
    addEvent(u.id, "password_changed");
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(`${API}/account/totp/setup`, () => {
    const u = auth();
    if (u instanceof Response) return u;
    const label = encodeURIComponent(`${PRODUCT_NAME}:${u.username}`);
    return HttpResponse.json({
      secret: TEST_SECRET,
      otpauthUrl: `otpauth://totp/${label}?secret=${TEST_SECRET}&issuer=${encodeURIComponent(PRODUCT_NAME)}`,
    });
  }),
  http.post(`${API}/account/totp/confirm`, async ({ request }) => {
    const u = auth();
    if (u instanceof Response) return u;
    const b = await body(request, TotpConfirm);
    if (b instanceof Response || b.code !== TEST_TOTP) return fail(400, "totp_invalid");
    u.totpEnabled = true;
    u.totpSetupRequired = false;
    u.recoveryCodes = codes();
    addEvent(u.id, "totp_enabled");
    return HttpResponse.json({ recoveryCodes: u.recoveryCodes });
  }),
  http.post(`${API}/account/totp/disable`, async ({ request }) => {
    const u = auth();
    if (u instanceof Response) return u;
    if (u.role === "admin") return fail(403, "totp_mandatory");
    const b = await body(request, PasswordConfirm);
    if (b instanceof Response) return b;
    if (b.password !== u.password) return fail(400, "password_wrong");
    u.totpEnabled = false;
    u.recoveryCodes = [];
    addEvent(u.id, "totp_disabled");
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(`${API}/account/totp/recovery-codes`, async ({ request }) => {
    const u = auth();
    if (u instanceof Response) return u;
    const b = await body(request, PasswordConfirm);
    if (b instanceof Response) return b;
    if (b.password !== u.password) return fail(400, "password_wrong");
    u.recoveryCodes = codes();
    return HttpResponse.json({ recoveryCodes: u.recoveryCodes });
  }),
  http.get(`${API}/account/sessions`, () => {
    const u = auth();
    if (u instanceof Response) return u;
    return HttpResponse.json(
      db.sessions
        .filter((s) => s.userId === u.id)
        .map(({ id, client, ipPrefix, lastUsedAt }) => ({ id, client, ipPrefix, lastUsedAt, current: id === db.currentSessionId })),
    );
  }),
  http.delete(`${API}/account/sessions/:id`, ({ params }) => {
    const u = auth();
    if (u instanceof Response) return u;
    db.sessions = db.sessions.filter((s) => !(s.userId === u.id && s.id === params["id"]));
    if (params["id"] === db.currentSessionId) db.currentSessionId = null;
    return new HttpResponse(null, { status: 204 });
  }),
  http.delete(`${API}/account/sessions`, () => {
    const u = auth();
    if (u instanceof Response) return u;
    db.sessions = db.sessions.filter((s) => s.userId !== u.id || s.id === db.currentSessionId);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`${API}/account/security-log`, ({ request }) => {
    const u = auth();
    if (u instanceof Response) return u;
    const all = db.events.filter((e) => e.userId === u.id);
    const pages = Math.max(1, Math.ceil(all.length / 20));
    const page = Math.min(pages, Math.max(1, Number(new URL(request.url).searchParams.get("page")) || 1));
    const items = all
      .slice((page - 1) * 20, page * 20)
      .map(({ id, type, at, client }) => ({ id, type, at, ...(client ? { client } : {}) }));
    return HttpResponse.json({ items, page, pages });
  }),
  http.get(`${API}/vaults/summary`, () => {
    const u = auth();
    if (u instanceof Response) return u;
    return HttpResponse.json({
      vaults: [
        { id: "v-notes", name: "Note", level: "decision", conflicts: 2 },
        { id: "v-work", name: "Lavoro", level: "safe", conflicts: 0 },
      ],
    });
  }),
];
```

(Nota: nel destructuring `userId: _u` il lint può segnalare la variabile inutilizzata: in tal caso costruire l'oggetto con i campi esplicitamente `({ id, type, at, client }) => ({ id, type, at, ...(client ? { client } : {}) })`.)

`apps/web/src/test/setup.ts`:

```ts
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";
import { resetDb } from "../mocks/db.js";
import { handlers } from "../mocks/handlers.js";

export const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledFrame: "bypass" }));
afterEach(() => {
  server.resetHandlers();
  resetDb();
});
afterAll(() => server.close());
```

In `apps/web/vite.config.ts`, nel blocco `test`: `setupFiles: ["src/test/setup.ts"],`.

Run: `pnpm --filter @kamino/web test` → PASS (anche i test esistenti: quelli che sostituiscono `fetch` con `vi.stubGlobal` continuano a funzionare). Se MSW in jsdom fallisce per `Request`/`Response` di jsdom, impostare per i file che usano MSW `// @vitest-environment node` dove non serve il DOM, oppure `environmentOptions` documentati da MSW per jsdom.

```bash
git add apps/web
git commit -m "feat(web): add MSW fake API with an in-memory database"
```

---

### Task 4: Router, struttura e avvio

**Files:**
- Create: `apps/web/src/router.tsx`, `apps/web/src/App.tsx`, `apps/web/src/app/AppShell.tsx`, `apps/web/src/app/useDocumentTitle.ts`, `apps/web/src/pages/PlaceholderPage.tsx`, `apps/web/src/pages/NotFoundPage.tsx`, `apps/web/src/mocks/browser.ts`, `apps/web/src/mocks/DevPanel.tsx`, `apps/web/src/test/render.tsx`
- Modify: `apps/web/src/main.tsx`, `apps/web/vite.config.ts`, `apps/web/test/build.test.ts`, `apps/web/src/i18n/locales/{it,en}.json`, `apps/web/src/pages/AboutPage.tsx` (titolo)
- Test: `apps/web/src/app/AppShell.test.tsx`, `apps/web/src/router.test.tsx`

**Interfaces:**
- Produces: `createAppRouter(opts: { queryClient: QueryClient; history?: RouterHistory }): AppRouter`; `routeTree`; `renderRoute(path: string): Promise<{ router; queryClient; user: ... }>` in `src/test/render.tsx`; `useDocumentTitle(title: string)`; `AppShell` (layout con `<Outlet />`).
- Le pagine dei Task 5–7 si collegano all'albero sostituendo i componenti segnaposto (`LoginPage`, `SetupPage`, `ForgotPage`, `ResetPage`, `InvitePage`, `TotpSetupPage`, `AccountPage`): in questo task esistono come segnaposto con il solo titolo.

- [ ] **Step 1: Componenti shadcn**

Run (in `apps/web`): `pnpm dlx shadcn@latest add input label checkbox dialog sheet dropdown-menu separator alert skeleton sonner --yes`. Poi: sostituire in `src/components/ui/*.tsx` ogni `from "cn"` con `from "@/lib/utils"`; `pnpm --filter @kamino/web remove cn` se aggiunto; ripristinare `src/index.css` se modificato; verificare che `sonner`/`radix-ui`/`next-themes` aggiunti siano dipendenze corrette (se il componente `sonner` importa `next-themes`, sostituirlo con il nostro `useTheme` di `src/theme/ThemeProvider.tsx`).

- [ ] **Step 2: Testi**

Aggiungere a `src/i18n/locales/it.json`:

```json
"nav": {
  "label": "Navigazione principale",
  "skip": "Vai al contenuto",
  "menu": "Apri il menu",
  "overview": "Panoramica",
  "vaults": "Vault",
  "devices": "Dispositivi",
  "conflicts": "Conflitti",
  "admin": "Amministrazione",
  "users": "Utenti",
  "system": "Sistema",
  "account": "Account",
  "about": "Informazioni",
  "logout": "Esci",
  "roles": { "user": "Utente", "admin": "Amministratore" }
},
"shell": {
  "levels": {
    "safe": "Tutto al sicuro",
    "working": "Sincronizzazione in corso",
    "attention": "Attenzione",
    "decision": "Conflitti da risolvere",
    "blocked": "Sync bloccato"
  },
  "conflictsCount": "{{count}} conflitti",
  "placeholder": "Questa sezione arriva con la prossima parte.",
  "notFound": "Pagina non trovata.",
  "backHome": "Torna alla panoramica",
  "resetBanner": "L'amministratore ha avviato il reset della tua password il {{date}}. Se non l'hai chiesto tu, contattalo.",
  "resetBannerOk": "Ho capito"
},
"dev": {
  "panel": "Dati finti",
  "reset": "Ripristina",
  "empty": "Nessun utente (setup)",
  "smtpOn": "SMTP attivo",
  "smtpOff": "SMTP non configurato",
  "signInAs": "Accedi come {{user}}"
}
```

e a `en.json`:

```json
"nav": {
  "label": "Main navigation",
  "skip": "Skip to content",
  "menu": "Open the menu",
  "overview": "Overview",
  "vaults": "Vaults",
  "devices": "Devices",
  "conflicts": "Conflicts",
  "admin": "Administration",
  "users": "Users",
  "system": "System",
  "account": "Account",
  "about": "About",
  "logout": "Sign out",
  "roles": { "user": "User", "admin": "Administrator" }
},
"shell": {
  "levels": {
    "safe": "All safe",
    "working": "Syncing",
    "attention": "Attention",
    "decision": "Conflicts to resolve",
    "blocked": "Sync blocked"
  },
  "conflictsCount": "{{count}} conflicts",
  "placeholder": "This section comes with the next part.",
  "notFound": "Page not found.",
  "backHome": "Back to the overview",
  "resetBanner": "The administrator started a reset of your password on {{date}}. If you didn't ask for it, contact them.",
  "resetBannerOk": "Got it"
},
"dev": {
  "panel": "Fake data",
  "reset": "Reset",
  "empty": "No users (setup)",
  "smtpOn": "SMTP on",
  "smtpOff": "SMTP not configured",
  "signInAs": "Sign in as {{user}}"
}
```

- [ ] **Step 3: Helper di test e test (falliscono)**

`apps/web/src/test/render.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "../i18n/index.js";
import { createAppRouter } from "../router.js";
import { ThemeProvider } from "../theme/ThemeProvider.js";

/** Renders the whole app at a path, against the MSW fake API. */
export async function renderRoute(path: string, lang: "it" | "en" = "it") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: [path] }) });
  const i18n = createI18n(lang);
  const utils = render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ThemeProvider>
    </I18nextProvider>,
  );
  await router.load();
  return { ...utils, router, queryClient };
}
```

`apps/web/src/router.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { resetDb, signInAs } from "./mocks/db.js";
import { renderRoute } from "./test/render.js";

afterEach(cleanup);

describe("route guards", () => {
  it("not signed in → login, keeping the target", async () => {
    const { router } = await renderRoute("/account");
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toMatchObject({ redirect: "/account" });
  });

  it("no users on the server → setup", async () => {
    resetDb("empty");
    const { router } = await renderRoute("/");
    await waitFor(() => expect(router.state.location.pathname).toBe("/setup"));
  });

  it("admin without TOTP → TOTP setup, whatever the URL", async () => {
    signInAs("newadmin");
    const { router } = await renderRoute("/vaults");
    await waitFor(() => expect(router.state.location.pathname).toBe("/account/totp-setup"));
  });

  it("a user cannot open the admin area", async () => {
    signInAs("demo");
    await renderRoute("/admin/users");
    expect(await screen.findByText("Pagina non trovata.")).toBeDefined();
  });

  it("signed in on a public page → overview", async () => {
    signInAs("demo");
    const { router } = await renderRoute("/login");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });
});
```

`apps/web/src/app/AppShell.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { signInAs } from "../mocks/db.js";
import { renderRoute } from "../test/render.js";

afterEach(cleanup);

describe("AppShell", () => {
  it("shows the navigation, the overall status and the conflicts count", async () => {
    signInAs("demo");
    await renderRoute("/");
    const nav = await screen.findByRole("navigation", { name: "Navigazione principale" });
    for (const label of ["Panoramica", "Vault", "Dispositivi", "Conflitti", "Account"]) {
      expect(within(nav).getAllByText(label, { exact: false }).length).toBeGreaterThan(0);
    }
    expect(within(nav).queryByText("Amministrazione")).toBeNull();
    expect(await within(nav).findByText("Conflitti da risolvere")).toBeDefined();
    expect(within(nav).getByText("2")).toBeDefined();
    expect(within(nav).getByRole("link", { name: /Panoramica/ }).getAttribute("aria-current")).toBe("page");
  });

  it("admins see the administration section", async () => {
    signInAs("admin");
    await renderRoute("/");
    const nav = await screen.findByRole("navigation", { name: "Navigazione principale" });
    expect(within(nav).getByText("Amministrazione")).toBeDefined();
  });

  it("shows the admin-reset banner until dismissed", async () => {
    signInAs("reset");
    await renderRoute("/");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("L'amministratore ha avviato il reset della tua password");
    within(alert).getByRole("button", { name: "Ho capito" }).click();
    await screen.findByRole("navigation", { name: "Navigazione principale" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("has a skip link and sets the document title", async () => {
    signInAs("demo");
    await renderRoute("/account");
    expect(await screen.findByText("Vai al contenuto")).toBeDefined();
    expect(document.title).toContain("Account");
  });
});
```

Run → FAIL.

- [ ] **Step 4: Router**

`apps/web/src/app/useDocumentTitle.ts`:

```ts
import { PRODUCT_NAME } from "@kamino/brand";
import { useEffect } from "react";

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · ${PRODUCT_NAME}` : PRODUCT_NAME;
  }, [title]);
}
```

`apps/web/src/pages/PlaceholderPage.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "../app/useDocumentTitle.js";

/** 4b/4c sections not built yet: title and one line. */
export function PlaceholderPage({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();
  const title = t(titleKey);
  useDocumentTitle(title);
  return (
    <section className="space-y-2">
      <h1 className="font-serif text-2xl font-semibold">{title}</h1>
      <p className="text-muted-foreground">{t("shell.placeholder")}</p>
    </section>
  );
}
```

`apps/web/src/pages/NotFoundPage.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <section className="space-y-3">
      <p>{t("shell.notFound")}</p>
      <Link to="/" className="text-link underline">
        {t("shell.backHome")}
      </Link>
    </section>
  );
}
```

`apps/web/src/router.tsx`:

```tsx
import type { Me } from "@kamino/protocol";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  notFound,
  Outlet,
  redirect,
  type RouterHistory,
} from "@tanstack/react-router";
import { api } from "./api/endpoints.js";
import { ApiError } from "./api/http.js";
import { safeRedirect } from "./api/redirect.js";
import { AppShell } from "./app/AppShell.js";
import { AboutPage } from "./pages/AboutPage.js";
import { NotFoundPage } from "./pages/NotFoundPage.js";
import { PlaceholderPage } from "./pages/PlaceholderPage.js";

export interface RouterContext {
  queryClient: QueryClient;
}

/** Signed-in user or null (401). Other errors propagate. */
async function loadMe(qc: QueryClient): Promise<Me | null> {
  try {
    return await qc.fetchQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 30_000 });
  } catch (err) {
    if (err instanceof ApiError && err.code === "unauthorized") return null;
    throw err;
  }
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFoundPage,
});

// ---- public pages ---------------------------------------------------------------------------

const publicRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "public",
  beforeLoad: async ({ context, location }) => {
    const status = await context.queryClient.fetchQuery({ queryKey: ["setup-status"], queryFn: api.setupStatus });
    if (status.needed && location.pathname !== "/setup") throw redirect({ to: "/setup" });
    if (!status.needed && location.pathname === "/setup") throw redirect({ to: "/login" });
    if (!status.needed && (await loadMe(context.queryClient))) throw redirect({ to: "/" });
  },
  component: Outlet,
});

export const loginRoute = createRoute({
  getParentRoute: () => publicRoute,
  path: "/login",
  validateSearch: (s: Record<string, unknown>): { redirect: string } => ({ redirect: safeRedirect(s["redirect"]) }),
  component: () => <PlaceholderPage titleKey="auth.login.title" />,
});
export const setupRoute = createRoute({ getParentRoute: () => publicRoute, path: "/setup", component: () => <PlaceholderPage titleKey="auth.setup.title" /> });
export const forgotRoute = createRoute({ getParentRoute: () => publicRoute, path: "/forgot", component: () => <PlaceholderPage titleKey="auth.forgot.title" /> });
export const resetRoute = createRoute({ getParentRoute: () => publicRoute, path: "/reset/$token", component: () => <PlaceholderPage titleKey="auth.reset.title" /> });
export const inviteRoute = createRoute({ getParentRoute: () => publicRoute, path: "/invite/$token", component: () => <PlaceholderPage titleKey="auth.invite.title" /> });

// ---- signed-in area -------------------------------------------------------------------------

export const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: async ({ context, location }) => {
    const status = await context.queryClient.fetchQuery({ queryKey: ["setup-status"], queryFn: api.setupStatus });
    if (status.needed) throw redirect({ to: "/setup" });
    const me = await loadMe(context.queryClient);
    if (!me) throw redirect({ to: "/login", search: { redirect: safeRedirect(location.href) } });
    if (me.totpSetupRequired && location.pathname !== "/account/totp-setup") throw redirect({ to: "/account/totp-setup" });
    return { me };
  },
  component: AppShell,
});

const page = (path: string, titleKey: string) =>
  createRoute({ getParentRoute: () => appRoute, path, component: () => <PlaceholderPage titleKey={titleKey} /> });

export const overviewRoute = page("/", "nav.overview");
export const vaultsRoute = page("/vaults", "nav.vaults");
export const devicesRoute = page("/devices", "nav.devices");
export const conflictsRoute = page("/conflicts", "nav.conflicts");
export const accountRoute = page("/account", "nav.account");
export const totpSetupRoute = page("/account/totp-setup", "auth.totp.title");
export const aboutRoute = createRoute({ getParentRoute: () => appRoute, path: "/about", component: AboutPage });

const adminRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin",
  beforeLoad: ({ context }) => {
    if (context.me.role !== "admin") throw notFound();
  },
  component: Outlet,
});
export const adminUsersRoute = createRoute({ getParentRoute: () => adminRoute, path: "/users", component: () => <PlaceholderPage titleKey="nav.users" /> });
export const adminSystemRoute = createRoute({ getParentRoute: () => adminRoute, path: "/system", component: () => <PlaceholderPage titleKey="nav.system" /> });

export const routeTree = rootRoute.addChildren([
  publicRoute.addChildren([loginRoute, setupRoute, forgotRoute, resetRoute, inviteRoute]),
  appRoute.addChildren([
    overviewRoute,
    vaultsRoute,
    devicesRoute,
    conflictsRoute,
    accountRoute,
    totpSetupRoute,
    aboutRoute,
    adminRoute.addChildren([adminUsersRoute, adminSystemRoute]),
  ]),
]);

export function createAppRouter(opts: { queryClient: QueryClient; history?: RouterHistory }) {
  return createRouter({
    routeTree,
    context: { queryClient: opts.queryClient },
    ...(opts.history ? { history: opts.history } : {}),
    defaultNotFoundComponent: NotFoundPage,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
```

Note: `location.href` del router comprende percorso e ricerca; `safeRedirect` lo accetta se inizia con `/`. I titoli `auth.*` dei segnaposto esistono dal Task 5 (fino ad allora i test di questo task non li leggono).

- [ ] **Step 5: `AppShell`**

`apps/web/src/app/AppShell.tsx`:

```tsx
import { PRODUCT_NAME } from "@kamino/brand";
import type { Level } from "@kamino/status";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Info, LayoutDashboard, LogOut, Menu, MonitorSmartphone, Settings, ShieldCheck, Users, Vault, GitCompareArrows } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/endpoints.js";
import { LEVEL_CLASSES, STATUS_ICONS } from "../components/status/status-icons.js";
import { Button } from "../components/ui/button.js";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "../components/ui/sheet.js";
import { cn } from "../lib/utils.js";

const SEVERITY: Level[] = ["safe", "working", "attention", "decision", "blocked"];
const LEVEL_ICON = {
  safe: "shield-check",
  working: "refresh-cw",
  attention: "triangle-alert",
  decision: "git-compare-arrows",
  blocked: "octagon-alert",
} as const;

function LevelBadge({ level }: { level: Level }) {
  const { t } = useTranslation();
  const Icon = STATUS_ICONS[LEVEL_ICON[level]];
  return (
    <span role="status" className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", LEVEL_CLASSES[level])}>
      <Icon aria-hidden="true" className="size-3.5" />
      {t(`shell.levels.${level}`)}
    </span>
  );
}

function NavItem({ to, icon, label, badge }: { to: string; icon: ReactNode; label: string; badge?: number }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const active = to === "/" ? path === "/" : path === to || path.startsWith(`${to}/`);
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2 text-sm",
        active ? "bg-accent text-accent-foreground font-semibold" : "hover:bg-muted",
      )}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {badge ? (
        <span className="bg-status-decision-surface text-status-decision rounded-full px-2 py-0.5 text-xs font-medium">{badge}</span>
      ) : null}
    </Link>
  );
}

/** Signed-in layout (spec §8.3): sidebar on desktop, top bar + sheet on narrow screens. */
export function AppShell() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const me = useQuery({ queryKey: ["me"], queryFn: api.me }).data;
  const summary = useQuery({ queryKey: ["vaults-summary"], queryFn: api.vaultsSummary, enabled: !!me && !me.totpSetupRequired }).data;
  const levels = summary?.vaults.map((v) => v.level) ?? [];
  const overall = levels.reduce<Level>((a, b) => (SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a), "safe");
  const conflicts = summary?.vaults.reduce((n, v) => n + v.conflicts, 0) ?? 0;

  const logout = async () => {
    await api.logout().catch(() => undefined);
    qc.clear();
    await navigate({ to: "/login", search: { redirect: "/" } });
  };

  if (!me) return null;
  const minimal = me.totpSetupRequired;

  const nav = (
    <nav aria-label={t("nav.label")} className="flex h-full flex-col gap-1 p-3">
      <div className="px-3 pt-1 pb-3 font-serif text-lg font-semibold">{PRODUCT_NAME}</div>
      {!minimal && (
        <>
          <div className="px-3 pb-3">{summary ? <LevelBadge level={overall} /> : null}</div>
          <NavItem to="/" icon={<LayoutDashboard className="size-4" aria-hidden="true" />} label={t("nav.overview")} />
          <NavItem to="/vaults" icon={<Vault className="size-4" aria-hidden="true" />} label={t("nav.vaults")} />
          <NavItem to="/devices" icon={<MonitorSmartphone className="size-4" aria-hidden="true" />} label={t("nav.devices")} />
          <NavItem to="/conflicts" icon={<GitCompareArrows className="size-4" aria-hidden="true" />} label={t("nav.conflicts")} badge={conflicts} />
          {me.role === "admin" && (
            <>
              <div className="text-muted-foreground px-3 pt-4 pb-1 text-xs font-medium tracking-wide uppercase">{t("nav.admin")}</div>
              <NavItem to="/admin/users" icon={<Users className="size-4" aria-hidden="true" />} label={t("nav.users")} />
              <NavItem to="/admin/system" icon={<Settings className="size-4" aria-hidden="true" />} label={t("nav.system")} />
            </>
          )}
        </>
      )}
      <div className="mt-auto space-y-1 pt-4">
        {!minimal && (
          <>
            <NavItem to="/account" icon={<ShieldCheck className="size-4" aria-hidden="true" />} label={`${t("nav.account")} · ${me.username}`} />
            <NavItem to="/about" icon={<Info className="size-4" aria-hidden="true" />} label={t("nav.about")} />
          </>
        )}
        <button type="button" onClick={() => void logout()} className="hover:bg-muted flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm">
          <LogOut className="size-4" aria-hidden="true" />
          {t("nav.logout")}
        </button>
        <p className="text-muted-foreground px-3 text-xs">{t(`nav.roles.${me.role}`)}</p>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      <a href="#main" className="focus:bg-background sr-only focus:not-sr-only focus:absolute focus:p-2">
        {t("nav.skip")}
      </a>
      <aside className="bg-card hidden border-r lg:block">{nav}</aside>
      <header className="bg-card flex items-center justify-between border-b px-3 py-2 lg:hidden">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="sm" aria-label={t("nav.menu")}>
              <Menu className="size-5" aria-hidden="true" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-0" onClick={(e) => (e.target as HTMLElement).closest("a") && setMenuOpen(false)}>
            <SheetTitle className="sr-only">{t("nav.label")}</SheetTitle>
            {nav}
          </SheetContent>
        </Sheet>
        <span className="font-serif font-semibold">{PRODUCT_NAME}</span>
        {summary && !minimal ? <LevelBadge level={overall} /> : <span />}
      </header>
      <main id="main" className="mx-auto w-full max-w-5xl space-y-4 p-4 lg:p-8">
        {me.adminResetAt && !bannerDismissed && (
          <div role="alert" className="bg-status-attention-surface text-status-attention flex flex-wrap items-center justify-between gap-2 rounded-lg p-3 text-sm">
            <span>{t("shell.resetBanner", { date: new Date(me.adminResetAt).toLocaleString(me.lang) })}</span>
            <Button size="sm" variant="outline" onClick={() => setBannerDismissed(true)}>
              {t("shell.resetBannerOk")}
            </Button>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
```

Nota: nel test "AppShell" la barra laterale (`lg:block`) e il menu mobile esistono entrambi nel DOM di jsdom solo se il menu è aperto; `findByRole("navigation")` trova la barra laterale (le classi responsive non nascondono nulla in jsdom). Se il Sheet di shadcn renderizza la `nav` anche da chiuso, usare `getAllByRole(...)[0]`.

`apps/web/src/pages/AboutPage.tsx`: aggiungere `useDocumentTitle(t("about.title"));` (import da `../app/useDocumentTitle.js`).

- [ ] **Step 6: App, MSW nel browser, pannello di sviluppo, avvio**

`apps/web/src/App.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { Toaster } from "./components/ui/sonner.js";
import { createAppRouter } from "./router.js";

const DevPanel = import.meta.env.DEV ? lazy(() => import("./mocks/DevPanel.js")) : null;

export function App() {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }));
  const [router] = useState(() => createAppRouter({ queryClient }));
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
      {DevPanel && (
        <Suspense>
          <DevPanel onChange={() => void queryClient.invalidateQueries().then(() => router.invalidate())} />
        </Suspense>
      )}
    </QueryClientProvider>
  );
}
```

`apps/web/src/mocks/browser.ts`:

```ts
import { setupWorker } from "msw/browser";
import { handlers } from "./handlers.js";

/** Dev only: fake API in the browser (data-msw marks this module for the build test). */
export const MSW_MARKER = "data-msw";

export async function startMocks(): Promise<void> {
  await setupWorker(...handlers).start({ onUnhandledFrame: "bypass", quiet: true, serviceWorker: { url: "/mockServiceWorker.js" } });
}
```

`apps/web/src/mocks/DevPanel.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/button.js";
import { db, resetDb, signInAs } from "./db.js";

/** Dev only: floating panel to drive the fake data (spec §6). */
export default function DevPanel({ onChange }: { onChange: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [smtp, setSmtp] = useState(db.smtp);
  const act = (fn: () => void) => () => {
    fn();
    onChange();
  };
  return (
    <div data-msw="true" className="fixed right-4 bottom-4 z-50 text-sm">
      {open && (
        <div className="bg-card mb-2 flex w-56 flex-col gap-2 rounded-lg border p-3 shadow-lg">
          <Button size="sm" variant="outline" onClick={act(() => resetDb())}>{t("dev.reset")}</Button>
          <Button size="sm" variant="outline" onClick={act(() => resetDb("empty"))}>{t("dev.empty")}</Button>
          <Button
            size="sm"
            variant="outline"
            onClick={act(() => {
              db.smtp = !db.smtp;
              setSmtp(db.smtp);
            })}
          >
            {smtp ? t("dev.smtpOn") : t("dev.smtpOff")}
          </Button>
          {["admin", "demo", "newadmin", "reset"].map((u) => (
            <Button key={u} size="sm" variant="ghost" onClick={act(() => signInAs(u))}>
              {t("dev.signInAs", { user: u })}
            </Button>
          ))}
        </div>
      )}
      <Button size="sm" onClick={() => setOpen((o) => !o)}>{t("dev.panel")}</Button>
    </div>
  );
}
```

`apps/web/src/main.tsx` (contenuto completo):

```tsx
import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { App } from "./App.js";
import { createI18n, detectLanguage } from "./i18n/index.js";
import { ThemeProvider } from "./theme/ThemeProvider.js";
import "./index.css";

const i18n = createI18n(detectLanguage(navigator.language));
document.documentElement.lang = i18n.language;

async function start(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("missing #root");
  // Dev-only: design system gallery (outside the app, no API needed).
  if (import.meta.env.DEV && location.pathname.startsWith("/dev/gallery")) {
    const Gallery = lazy(() => import("./dev/GalleryPage.js"));
    createRoot(root).render(
      <StrictMode>
        <I18nextProvider i18n={i18n}>
          <ThemeProvider>
            <Suspense>
              <Gallery />
            </Suspense>
          </ThemeProvider>
        </I18nextProvider>
      </StrictMode>,
    );
    return;
  }
  // Dev-only: fake API (MSW). `import.meta.env.DEV` is a build-time constant: dropped in production.
  if (import.meta.env.DEV) {
    const { startMocks } = await import("./mocks/browser.js");
    await startMocks();
  }
  createRoot(root).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </I18nextProvider>
    </StrictMode>,
  );
}

void start();
```

`apps/web/vite.config.ts`: aggiungere un plugin che in sviluppo serve il worker di MSW senza copiarlo in `public/` (così non finisce mai nella build):

```ts
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** Dev only: serves MSW's service worker from node_modules (never copied to public/ or dist/). */
function mswWorker(): Plugin {
  return {
    name: "msw-worker",
    apply: "serve",
    configureServer(server) {
      const file = createRequire(import.meta.url).resolve("msw/mockServiceWorker.js");
      server.middlewares.use("/mockServiceWorker.js", (_req, res) => {
        res.setHeader("content-type", "application/javascript");
        res.end(readFileSync(file));
      });
    },
  };
}
```

e inserirlo in `plugins: [react(), tailwindcss(), brandHtml(), mswWorker()]`. (Se `msw/mockServiceWorker.js` non è esportato dal pacchetto, risolvere `msw/package.json` e unire `lib/mockServiceWorker.js`.)

`apps/web/test/build.test.ts`: aggiungere

```ts
  it("does not ship the fake API", () => {
    for (const f of files.filter((x) => /\.(js|html)$/.test(x))) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toContain("mockServiceWorker");
      expect(text, f).not.toContain("data-msw");
      expect(text, f).not.toContain("admin-password-1");
    }
    expect(files.some((f) => f.endsWith("mockServiceWorker.js"))).toBe(false);
  });
```

- [ ] **Step 7: Verifica, commit, prova nel browser**

Run: `pnpm --filter @kamino/web test && pnpm --filter @kamino/web typecheck && pnpm --filter @kamino/web lint && pnpm format:check`

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): add router with guards, app shell and dev fake API"
```

**Prova (committente o verifica con screenshot):** `pnpm --filter @kamino/web dev` → `http://localhost:5173/` porta a `/login` (segnaposto); dal pannello "Dati finti" → "Accedi come admin": barra laterale con stato "Conflitti da risolvere", contatore 2, sezione Amministrazione; finestra stretta → barra in alto e menu; "Accedi come newadmin" → bloccato su TOTP; "Accedi come reset" → banner.

---

### Task 5: Pagine pubbliche

**Files:**
- Create: `apps/web/src/pages/auth/AuthCard.tsx`, `LoginPage.tsx`, `SetupPage.tsx`, `ForgotPage.tsx`, `ResetPage.tsx`, `InvitePage.tsx`; `apps/web/src/components/PasswordField.tsx`, `apps/web/src/components/LanguageSwitch.tsx`
- Test: `apps/web/src/pages/auth/auth.test.tsx`
- Modify: `apps/web/src/router.tsx` (componenti al posto dei segnaposto), `src/i18n/locales/{it,en}.json`

**Interfaces:**
- Consumes: `api`, `errorMessage`, `safeRedirect`, `loginRoute` (search `redirect`), `resetRoute`/`inviteRoute` (param `token`), `PASSWORD_MIN`.
- Produces: `AuthCard({ title, children, footer? })`, `PasswordField({ label, value, onChange, autoComplete, id })`, `LanguageSwitch()`.

- [ ] **Step 1: Testi**

`it.json`:

```json
"auth": {
  "login": {
    "title": "Accedi",
    "username": "Nome utente",
    "password": "Password",
    "submit": "Accedi",
    "totpTitle": "Codice di verifica",
    "totpHint": "Inserisci il codice di 6 cifre dell'app di autenticazione.",
    "code": "Codice",
    "useRecovery": "Usa un codice di recupero",
    "useTotp": "Usa il codice dell'app",
    "recoveryCode": "Codice di recupero",
    "verify": "Verifica",
    "forgot": "Password dimenticata?",
    "back": "Torna all'accesso"
  },
  "setup": {
    "title": "Configurazione iniziale",
    "intro": "Crea l'account amministratore. Il codice di configurazione lo trovi nei log di avvio del server.",
    "token": "Codice di configurazione",
    "email": "Email",
    "submit": "Crea l'amministratore"
  },
  "forgot": {
    "title": "Password dimenticata",
    "intro": "Scrivi l'email del tuo account.",
    "email": "Email",
    "submit": "Invia le istruzioni",
    "sent": "Se l'indirizzo è registrato, ti abbiamo mandato un'email con le istruzioni.",
    "noSmtp": "L'invio di email non è configurato: chiedi all'amministratore un link per reimpostare la password."
  },
  "reset": {
    "title": "Nuova password",
    "submit": "Salva la password",
    "done": "Password aggiornata: ora puoi accedere."
  },
  "invite": {
    "title": "Benvenuto",
    "intro": "Sei stato invitato come {{username}} ({{email}}). Scegli una password per iniziare.",
    "submit": "Crea l'account"
  },
  "password": {
    "new": "Nuova password",
    "repeat": "Ripeti la password",
    "rule": "Almeno {{min}} caratteri.",
    "mismatch": "Le due password non coincidono.",
    "show": "Mostra la password",
    "hide": "Nascondi la password"
  },
  "totp": { "title": "Verifica in due passaggi" },
  "language": "Lingua"
},
"errors": {
  "generic": "Qualcosa è andato storto. Riprova.",
  "unauthorized": "Sessione scaduta: accedi di nuovo.",
  "invalid_credentials": "Nome utente o password non corretti.",
  "user_blocked": "Account bloccato: contatta l'amministratore.",
  "totp_invalid": "Codice non corretto.",
  "challenge_expired": "Tempo scaduto: accedi di nuovo.",
  "setup_not_needed": "La configurazione iniziale è già stata fatta.",
  "setup_token_invalid": "Codice di configurazione non corretto.",
  "token_invalid": "Questo link non è valido.",
  "token_expired": "Questo link è scaduto: chiedine uno nuovo.",
  "password_weak": "La password deve avere almeno 12 caratteri.",
  "password_wrong": "La password attuale non è corretta.",
  "totp_mandatory": "Per gli amministratori la verifica in due passaggi è obbligatoria.",
  "forbidden": "Non hai i permessi per questa operazione.",
  "internal": "Qualcosa è andato storto. Riprova."
}
```

`en.json`:

```json
"auth": {
  "login": {
    "title": "Sign in",
    "username": "Username",
    "password": "Password",
    "submit": "Sign in",
    "totpTitle": "Verification code",
    "totpHint": "Enter the 6-digit code from your authenticator app.",
    "code": "Code",
    "useRecovery": "Use a recovery code",
    "useTotp": "Use the app code",
    "recoveryCode": "Recovery code",
    "verify": "Verify",
    "forgot": "Forgot your password?",
    "back": "Back to sign in"
  },
  "setup": {
    "title": "Initial setup",
    "intro": "Create the administrator account. You find the setup code in the server start-up logs.",
    "token": "Setup code",
    "email": "Email",
    "submit": "Create the administrator"
  },
  "forgot": {
    "title": "Forgot password",
    "intro": "Enter the email of your account.",
    "email": "Email",
    "submit": "Send instructions",
    "sent": "If the address is registered, we sent you an email with instructions.",
    "noSmtp": "Email is not configured: ask the administrator for a password reset link."
  },
  "reset": {
    "title": "New password",
    "submit": "Save the password",
    "done": "Password updated: you can now sign in."
  },
  "invite": {
    "title": "Welcome",
    "intro": "You were invited as {{username}} ({{email}}). Choose a password to get started.",
    "submit": "Create the account"
  },
  "password": {
    "new": "New password",
    "repeat": "Repeat the password",
    "rule": "At least {{min}} characters.",
    "mismatch": "The two passwords don't match.",
    "show": "Show password",
    "hide": "Hide password"
  },
  "totp": { "title": "Two-step verification" },
  "language": "Language"
},
"errors": {
  "generic": "Something went wrong. Try again.",
  "unauthorized": "Session expired: sign in again.",
  "invalid_credentials": "Wrong username or password.",
  "user_blocked": "Account locked: contact the administrator.",
  "totp_invalid": "Wrong code.",
  "challenge_expired": "Time is up: sign in again.",
  "setup_not_needed": "The initial setup has already been done.",
  "setup_token_invalid": "Wrong setup code.",
  "token_invalid": "This link is not valid.",
  "token_expired": "This link has expired: ask for a new one.",
  "password_weak": "The password must be at least 12 characters long.",
  "password_wrong": "The current password is wrong.",
  "totp_mandatory": "Two-step verification is mandatory for administrators.",
  "forbidden": "You don't have permission for this.",
  "internal": "Something went wrong. Try again."
}
```

- [ ] **Step 2: Test (falliscono)**

`apps/web/src/pages/auth/auth.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { db, resetDb, TEST_RECOVERY_CODES, TEST_TOTP } from "../../mocks/db.js";
import { renderRoute } from "../../test/render.js";

afterEach(cleanup);

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label, { selector: "input" }), { target: { value } });
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("LoginPage", () => {
  it("wrong credentials: message and empty password", async () => {
    await renderRoute("/login");
    type("Nome utente", "demo");
    type("Password", "nope");
    click("Accedi");
    expect(await screen.findByText("Nome utente o password non corretti.")).toBeDefined();
    expect((screen.getByLabelText("Password", { selector: "input" }) as HTMLInputElement).value).toBe("");
  });

  it("blocked account", async () => {
    await renderRoute("/login");
    type("Nome utente", "locked");
    type("Password", "locked-password-1");
    click("Accedi");
    expect(await screen.findByText("Account bloccato: contatta l'amministratore.")).toBeDefined();
  });

  it("plain login goes to the internal redirect", async () => {
    const { router } = await renderRoute("/login?redirect=%2Faccount");
    type("Nome utente", "demo");
    type("Password", "demo-password-1");
    click("Accedi");
    await waitFor(() => expect(router.state.location.pathname).toBe("/account"));
  });

  it("an external redirect is ignored", async () => {
    const { router } = await renderRoute("/login?redirect=https%3A%2F%2Fevil.example");
    type("Nome utente", "demo");
    type("Password", "demo-password-1");
    click("Accedi");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("TOTP step, wrong then right code", async () => {
    const { router } = await renderRoute("/login");
    type("Nome utente", "admin");
    type("Password", "admin-password-1");
    click("Accedi");
    expect(await screen.findByText("Codice di verifica")).toBeDefined();
    type("Codice", "000000");
    click("Verifica");
    expect(await screen.findByText("Codice non corretto.")).toBeDefined();
    type("Codice", TEST_TOTP);
    click("Verifica");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("recovery code", async () => {
    const { router } = await renderRoute("/login");
    type("Nome utente", "admin");
    type("Password", "admin-password-1");
    click("Accedi");
    fireEvent.click(await screen.findByRole("button", { name: "Usa un codice di recupero" }));
    type("Codice di recupero", TEST_RECOVERY_CODES[1]!);
    click("Verifica");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });
});

describe("SetupPage", () => {
  it("wrong token, weak password, then success → TOTP setup", async () => {
    resetDb("empty");
    const { router } = await renderRoute("/setup");
    expect(await screen.findByText(/log di avvio del server/)).toBeDefined();
    type("Codice di configurazione", "wrong");
    type("Nome utente", "boss");
    type("Email", "boss@example.com");
    type("Nuova password", "short");
    type("Ripeti la password", "short");
    click("Crea l'amministratore");
    expect(await screen.findByText("Almeno 12 caratteri.")).toBeDefined();
    type("Nuova password", "boss-password-1");
    type("Ripeti la password", "boss-password-1");
    click("Crea l'amministratore");
    expect(await screen.findByText("Codice di configurazione non corretto.")).toBeDefined();
    type("Codice di configurazione", "setup-token");
    click("Crea l'amministratore");
    await waitFor(() => expect(router.state.location.pathname).toBe("/account/totp-setup"));
  });
});

describe("ForgotPage", () => {
  it("same answer for unknown emails; no SMTP explains", async () => {
    await renderRoute("/forgot");
    type("Email", "nobody@example.com");
    click("Invia le istruzioni");
    expect(await screen.findByText(/Se l'indirizzo è registrato/)).toBeDefined();
    cleanup();
    db.smtp = false;
    await renderRoute("/forgot");
    type("Email", "demo@example.com");
    click("Invia le istruzioni");
    expect(await screen.findByText(/chiedi all'amministratore/)).toBeDefined();
  });
});

describe("ResetPage and InvitePage", () => {
  it("reset with a valid token, then the link is used up", async () => {
    await renderRoute("/reset/reset-token");
    type("Nuova password", "brand-new-pass-1");
    type("Ripeti la password", "brand-new-pass-1");
    click("Salva la password");
    expect(await screen.findByText("Password aggiornata: ora puoi accedere.")).toBeDefined();
  });

  it("mismatching passwords are caught before sending", async () => {
    await renderRoute("/reset/reset-token");
    type("Nuova password", "brand-new-pass-1");
    type("Ripeti la password", "brand-new-pass-2");
    click("Salva la password");
    expect(await screen.findByText("Le due password non coincidono.")).toBeDefined();
  });

  it("expired reset link", async () => {
    await renderRoute("/reset/expired-token");
    type("Nuova password", "brand-new-pass-1");
    type("Ripeti la password", "brand-new-pass-1");
    click("Salva la password");
    expect(await screen.findByText("Questo link è scaduto: chiedine uno nuovo.")).toBeDefined();
  });

  it("invite shows who is invited and creates the account", async () => {
    const { router } = await renderRoute("/invite/invite-token");
    expect(await screen.findByText(/invited@example.com/)).toBeDefined();
    type("Nuova password", "invited-pass-12");
    type("Ripeti la password", "invited-pass-12");
    click("Crea l'account");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("invalid invite", async () => {
    await renderRoute("/invite/nope");
    expect(await screen.findByText("Questo link non è valido.")).toBeDefined();
  });
});
```

- [ ] **Step 3: Componenti comuni**

`apps/web/src/components/PasswordField.tsx`:

```tsx
import { Eye, EyeOff } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";

export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: "current-password" | "new-password";
}) {
  const { t } = useTranslation();
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="pr-10"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? t("auth.password.hide") : t("auth.password.show")}
          className="text-muted-foreground absolute inset-y-0 right-0 flex w-10 items-center justify-center"
        >
          {visible ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}
```

`apps/web/src/components/LanguageSwitch.tsx`:

```tsx
import { useTranslation } from "react-i18next";

export function LanguageSwitch() {
  const { t, i18n } = useTranslation();
  return (
    <div role="group" aria-label={t("auth.language")} className="flex gap-2 text-sm">
      {(["it", "en"] as const).map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={i18n.language === l}
          onClick={() => {
            void i18n.changeLanguage(l);
            document.documentElement.lang = l;
          }}
          className={i18n.language === l ? "font-semibold underline" : "text-muted-foreground"}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
```

`apps/web/src/pages/auth/AuthCard.tsx`:

```tsx
import { PRODUCT_NAME } from "@kamino/brand";
import type { ReactNode } from "react";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { LanguageSwitch } from "../../components/LanguageSwitch.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.js";

/** Centered layout for the public pages (spec §8.1). */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  useDocumentTitle(title);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
      <p className="font-serif text-xl font-semibold">{PRODUCT_NAME}</p>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>{title}</h1>
          </CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
      <LanguageSwitch />
    </main>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? (
    <p role="alert" className="text-destructive text-sm">
      {children}
    </p>
  ) : null;
}
```

Un helper per il campo testo con etichetta, usato in tutte le pagine (`apps/web/src/components/TextField.tsx`):

```tsx
import { useId, type InputHTMLAttributes } from "react";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";

export function TextField({
  label,
  value,
  onChange,
  ...rest
}: { label: string; value: string; onChange: (v: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} {...rest} />
    </div>
  );
}
```

Una validazione condivisa per le nuove password (`apps/web/src/components/newPassword.ts`):

```ts
import { PASSWORD_MIN } from "@kamino/protocol";
import type { TFunction } from "i18next";

/** Client-side check before sending: length rule, then the two fields match. */
export function newPasswordError(pw: string, repeat: string, t: TFunction): string | null {
  if (pw.length < PASSWORD_MIN) return t("auth.password.rule", { min: PASSWORD_MIN });
  if (pw !== repeat) return t("auth.password.mismatch");
  return null;
}
```

- [ ] **Step 4: Pagine**

`apps/web/src/pages/auth/LoginPage.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { ApiError } from "../../api/http.js";
import { PasswordField } from "../../components/PasswordField.js";
import { TextField } from "../../components/TextField.js";
import { Button } from "../../components/ui/button.js";
import { loginRoute } from "../../router.js";
import { AuthCard, ErrorText } from "./AuthCard.js";

export function LoginPage() {
  const { t } = useTranslation();
  const { redirect } = loginRoute.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const done = async () => {
    await qc.invalidateQueries();
    await navigate({ to: redirect });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (challenge === null) {
        const r = await api.login(username, password);
        setPassword("");
        if (r.status === "totp_required") setChallenge(r.challengeId);
        else await done();
      } else {
        await api.loginTotp(challenge, code.trim());
        await done();
      }
    } catch (err) {
      setPassword("");
      setCode("");
      if (err instanceof ApiError && err.code === "challenge_expired") setChallenge(null);
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={challenge === null ? t("auth.login.title") : t("auth.login.totpTitle")}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        {challenge === null ? (
          <>
            <TextField label={t("auth.login.username")} value={username} onChange={setUsername} autoComplete="username" required />
            <PasswordField label={t("auth.login.password")} value={password} onChange={setPassword} autoComplete="current-password" />
          </>
        ) : (
          <>
            {!recovery && <p className="text-muted-foreground text-sm">{t("auth.login.totpHint")}</p>}
            <TextField
              label={recovery ? t("auth.login.recoveryCode") : t("auth.login.code")}
              value={code}
              onChange={setCode}
              autoComplete="one-time-code"
              {...(recovery ? {} : { inputMode: "numeric" as const, maxLength: 6 })}
            />
            <button type="button" className="text-link text-sm underline" onClick={() => setRecovery((r) => !r)}>
              {recovery ? t("auth.login.useTotp") : t("auth.login.useRecovery")}
            </button>
          </>
        )}
        <ErrorText>{error}</ErrorText>
        <Button type="submit" className="w-full" disabled={busy}>
          {challenge === null ? t("auth.login.submit") : t("auth.login.verify")}
        </Button>
        {challenge === null && (
          <Link to="/forgot" className="text-link block text-center text-sm underline">
            {t("auth.login.forgot")}
          </Link>
        )}
      </form>
    </AuthCard>
  );
}
```

`apps/web/src/pages/auth/SetupPage.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { newPasswordError } from "../../components/newPassword.js";
import { PasswordField } from "../../components/PasswordField.js";
import { TextField } from "../../components/TextField.js";
import { Button } from "../../components/ui/button.js";
import { AuthCard, ErrorText } from "./AuthCard.js";

export function SetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState({ token: "", username: "", email: "", password: "", repeat: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const pwError = newPasswordError(f.password, f.repeat, t);
    if (pwError) return setError(pwError);
    setBusy(true);
    setError(null);
    try {
      await api.setup({ token: f.token.trim(), username: f.username, email: f.email, password: f.password });
      await qc.invalidateQueries();
      await navigate({ to: "/account/totp-setup" });
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t("auth.setup.title")}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <p className="text-muted-foreground text-sm">{t("auth.setup.intro")}</p>
        <TextField label={t("auth.setup.token")} value={f.token} onChange={set("token")} autoComplete="off" required />
        <TextField label={t("auth.login.username")} value={f.username} onChange={set("username")} autoComplete="username" required />
        <TextField label={t("auth.setup.email")} value={f.email} onChange={set("email")} type="email" autoComplete="email" required />
        <PasswordField label={t("auth.password.new")} value={f.password} onChange={set("password")} autoComplete="new-password" />
        <PasswordField label={t("auth.password.repeat")} value={f.repeat} onChange={set("repeat")} autoComplete="new-password" />
        <ErrorText>{error}</ErrorText>
        <Button type="submit" className="w-full" disabled={busy}>
          {t("auth.setup.submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
```

`apps/web/src/pages/auth/ForgotPage.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { TextField } from "../../components/TextField.js";
import { Button } from "../../components/ui/button.js";
import { AuthCard, ErrorText } from "./AuthCard.js";

export function ForgotPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<"sent" | "noSmtp" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.forgot(email);
      setResult(r.smtp ? "sent" : "noSmtp");
    } catch (err) {
      setError(errorMessage(err, t));
    }
  };

  return (
    <AuthCard title={t("auth.forgot.title")}>
      {result ? (
        <p role="status">{result === "sent" ? t("auth.forgot.sent") : t("auth.forgot.noSmtp")}</p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <p className="text-muted-foreground text-sm">{t("auth.forgot.intro")}</p>
          <TextField label={t("auth.forgot.email")} value={email} onChange={setEmail} type="email" autoComplete="email" required />
          <ErrorText>{error}</ErrorText>
          <Button type="submit" className="w-full">
            {t("auth.forgot.submit")}
          </Button>
        </form>
      )}
      <Link to="/login" search={{ redirect: "/" }} className="text-link mt-4 block text-center text-sm underline">
        {t("auth.login.back")}
      </Link>
    </AuthCard>
  );
}
```

`apps/web/src/pages/auth/ResetPage.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { newPasswordError } from "../../components/newPassword.js";
import { PasswordField } from "../../components/PasswordField.js";
import { Button } from "../../components/ui/button.js";
import { resetRoute } from "../../router.js";
import { AuthCard, ErrorText } from "./AuthCard.js";

export function ResetPage() {
  const { t } = useTranslation();
  const { token } = resetRoute.useParams();
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const pwError = newPasswordError(password, repeat, t);
    if (pwError) return setError(pwError);
    setError(null);
    try {
      await api.reset(token, password);
      setDone(true);
    } catch (err) {
      setError(errorMessage(err, t));
    }
  };

  return (
    <AuthCard title={t("auth.reset.title")}>
      {done ? (
        <p role="status">{t("auth.reset.done")}</p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <PasswordField label={t("auth.password.new")} value={password} onChange={setPassword} autoComplete="new-password" />
          <PasswordField label={t("auth.password.repeat")} value={repeat} onChange={setRepeat} autoComplete="new-password" />
          <ErrorText>{error}</ErrorText>
          <Button type="submit" className="w-full">
            {t("auth.reset.submit")}
          </Button>
        </form>
      )}
      <Link to="/login" search={{ redirect: "/" }} className="text-link mt-4 block text-center text-sm underline">
        {t("auth.login.back")}
      </Link>
    </AuthCard>
  );
}
```

`apps/web/src/pages/auth/InvitePage.tsx`:

```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { newPasswordError } from "../../components/newPassword.js";
import { PasswordField } from "../../components/PasswordField.js";
import { Button } from "../../components/ui/button.js";
import { inviteRoute } from "../../router.js";
import { AuthCard, ErrorText } from "./AuthCard.js";

export function InvitePage() {
  const { t } = useTranslation();
  const { token } = inviteRoute.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const invite = useQuery({ queryKey: ["invite", token], queryFn: () => api.invite(token) });
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const pwError = newPasswordError(password, repeat, t);
    if (pwError) return setError(pwError);
    setError(null);
    try {
      await api.acceptInvite(token, password);
      await qc.invalidateQueries();
      await navigate({ to: "/" });
    } catch (err) {
      setError(errorMessage(err, t));
    }
  };

  return (
    <AuthCard title={t("auth.invite.title")}>
      {invite.isError ? (
        <ErrorText>{errorMessage(invite.error, t)}</ErrorText>
      ) : invite.data ? (
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <p className="text-muted-foreground text-sm">{t("auth.invite.intro", invite.data)}</p>
          <PasswordField label={t("auth.password.new")} value={password} onChange={setPassword} autoComplete="new-password" />
          <PasswordField label={t("auth.password.repeat")} value={repeat} onChange={setRepeat} autoComplete="new-password" />
          <ErrorText>{error}</ErrorText>
          <Button type="submit" className="w-full">
            {t("auth.invite.submit")}
          </Button>
        </form>
      ) : null}
    </AuthCard>
  );
}
```

In `apps/web/src/router.tsx` sostituire i componenti segnaposto delle route pubbliche con `LoginPage`, `SetupPage`, `ForgotPage`, `ResetPage`, `InvitePage` (import da `./pages/auth/*.js`). Gli import circolari (`LoginPage` importa `loginRoute` dal router che importa `LoginPage`) sono risolti dai moduli ES perché i componenti usano `loginRoute` solo durante il render; se il typecheck o il bundler segnalano problemi, usare `useSearch({ from: "/public/login" })` e `useParams({ from: "/public/reset/$token" })` al posto dei riferimenti alle route.

Run: `pnpm --filter @kamino/web test -- auth` → PASS. Typecheck, lint, format.

```bash
git add apps/web
git commit -m "feat(web): add sign-in, setup, password reset and invite pages"
```

---

### Task 6: Configurazione TOTP

**Files:**
- Create: `apps/web/src/pages/TotpSetupPage.tsx`, `apps/web/src/components/RecoveryCodes.tsx`
- Test: `apps/web/src/pages/TotpSetupPage.test.tsx`
- Modify: `apps/web/src/router.tsx` (`totpSetupRoute` → `TotpSetupPage`), `src/i18n/locales/{it,en}.json`

**Interfaces:**
- Produces: `TotpSetupPage({ onDone?: () => void })` (usata anche dall'Account per attivare il TOTP); `RecoveryCodes({ codes, requireAck, onAck? })`.

- [ ] **Step 1: Testi**

`it.json` → `auth.totp` (sostituisce `{ "title": … }`):

```json
"totp": {
  "title": "Verifica in due passaggi",
  "required": "Per gli amministratori la verifica in due passaggi è obbligatoria: configurala per continuare.",
  "step1": "Scansiona il codice con un'app di autenticazione (per esempio Aegis, Raivo, 1Password).",
  "qrAlt": "Codice QR per l'app di autenticazione",
  "secret": "Oppure inserisci questa chiave a mano",
  "copy": "Copia",
  "copied": "Copiato.",
  "step2": "Inserisci il codice di 6 cifre che l'app mostra adesso.",
  "code": "Codice",
  "verify": "Verifica",
  "step3": "Salva questi codici di recupero: ognuno funziona una sola volta se perdi il telefono.",
  "download": "Scarica .txt",
  "ack": "Li ho salvati in un posto sicuro",
  "finish": "Fine"
}
```

`en.json`:

```json
"totp": {
  "title": "Two-step verification",
  "required": "Two-step verification is mandatory for administrators: set it up to continue.",
  "step1": "Scan the code with an authenticator app (for example Aegis, Raivo, 1Password).",
  "qrAlt": "QR code for the authenticator app",
  "secret": "Or enter this key manually",
  "copy": "Copy",
  "copied": "Copied.",
  "step2": "Enter the 6-digit code the app shows now.",
  "code": "Code",
  "verify": "Verify",
  "step3": "Save these recovery codes: each works once if you lose your phone.",
  "download": "Download .txt",
  "ack": "I saved them somewhere safe",
  "finish": "Done"
}
```

- [ ] **Step 2: Test (falliscono)**

`apps/web/src/pages/TotpSetupPage.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { signInAs, TEST_TOTP } from "../mocks/db.js";
import { renderRoute } from "../test/render.js";

afterEach(cleanup);

describe("TotpSetupPage", () => {
  it("required for a new admin: QR, wrong code, codes, ack, then the app", async () => {
    signInAs("newadmin");
    const { router } = await renderRoute("/account/totp-setup");
    expect(await screen.findByText(/obbligatoria: configurala per continuare/)).toBeDefined();
    expect(screen.getByAltText("Codice QR per l'app di autenticazione").getAttribute("src")).toMatch(/^data:image\/svg\+xml,/);
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Codice", { selector: "input" }), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verifica" }));
    expect(await screen.findByText("Codice non corretto.")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Codice", { selector: "input" }), { target: { value: TEST_TOTP } });
    fireEvent.click(screen.getByRole("button", { name: "Verifica" }));
    expect(await screen.findAllByTestId("recovery-code")).toHaveLength(10);
    const finish = screen.getByRole("button", { name: "Fine" }) as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Li ho salvati in un posto sicuro"));
    expect(finish.disabled).toBe(false);
    fireEvent.click(finish);
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("the navigation is hidden while the setup is required", async () => {
    signInAs("newadmin");
    await renderRoute("/account/totp-setup");
    await screen.findByText(/obbligatoria/);
    expect(screen.queryByText("Panoramica")).toBeNull();
    expect(screen.getAllByText("Esci").length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Implementazione**

`apps/web/src/components/RecoveryCodes.tsx`:

```tsx
import { PRODUCT_SLUG } from "@kamino/brand";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "./ui/button.js";
import { Checkbox } from "./ui/checkbox.js";
import { Label } from "./ui/label.js";

export function RecoveryCodes({ codes, ack, onAck }: { codes: string[]; ack?: boolean; onAck?: (v: boolean) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const text = codes.join("\n");
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: "text/plain" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${PRODUCT_SLUG}-recovery-codes.txt` });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3">
      <ul className="bg-muted grid grid-cols-2 gap-2 rounded-lg p-3 font-mono text-sm">
        {codes.map((c) => (
          <li key={c} data-testid="recovery-code">
            {c}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void navigator.clipboard?.writeText(text).then(() => toast(t("auth.totp.copied")))}
        >
          {t("auth.totp.copy")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={download}>
          {t("auth.totp.download")}
        </Button>
      </div>
      {onAck && (
        <div className="flex items-center gap-2">
          <Checkbox id={id} checked={!!ack} onCheckedChange={(v) => onAck(v === true)} />
          <Label htmlFor={id}>{t("auth.totp.ack")}</Label>
        </div>
      )}
    </div>
  );
}
```

`apps/web/src/pages/TotpSetupPage.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { renderSVG } from "uqr";
import { api } from "../api/endpoints.js";
import { errorMessage } from "../api/errors.js";
import { useDocumentTitle } from "../app/useDocumentTitle.js";
import { RecoveryCodes } from "../components/RecoveryCodes.js";
import { TextField } from "../components/TextField.js";
import { Button } from "../components/ui/button.js";
import { ErrorText } from "./auth/AuthCard.js";

/** TOTP setup in three steps (spec §8.2). Mandatory for admins without TOTP. */
export function TotpSetupPage({ onDone }: { onDone?: () => void }) {
  const { t } = useTranslation();
  useDocumentTitle(t("auth.totp.title"));
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me }).data;
  const setup = useQuery({ queryKey: ["totp-setup"], queryFn: api.totpSetup, staleTime: Infinity });
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [ack, setAck] = useState(false);
  const confirm = useMutation({ mutationFn: (c: string) => api.totpConfirm(c), onSuccess: (r) => setCodes(r.recoveryCodes) });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    confirm.mutate(code.trim());
  };

  const finish = async () => {
    qc.removeQueries({ queryKey: ["totp-setup"] });
    await qc.invalidateQueries({ queryKey: ["me"] });
    if (onDone) onDone();
    else await navigate({ to: "/" });
  };

  return (
    <section className="max-w-lg space-y-5">
      <h1 className="font-serif text-2xl font-semibold">{t("auth.totp.title")}</h1>
      {me?.totpSetupRequired && <p className="text-status-attention bg-status-attention-surface rounded-lg p-3 text-sm">{t("auth.totp.required")}</p>}
      {codes === null ? (
        <>
          <p>{t("auth.totp.step1")}</p>
          {setup.data && (
            <>
              <img
                src={`data:image/svg+xml,${encodeURIComponent(renderSVG(setup.data.otpauthUrl, { border: 2, whiteColor: "#ffffff", blackColor: "#000000" }))}`}
                alt={t("auth.totp.qrAlt")}
                width={200}
                height={200}
                className="rounded-md"
              />
              <p className="text-muted-foreground text-sm">{t("auth.totp.secret")}</p>
              <code className="bg-muted block rounded p-2 font-mono text-sm break-all">{setup.data.secret}</code>
            </>
          )}
          <form onSubmit={submit} className="space-y-3">
            <p>{t("auth.totp.step2")}</p>
            <TextField label={t("auth.totp.code")} value={code} onChange={setCode} inputMode="numeric" maxLength={6} autoComplete="one-time-code" />
            <ErrorText>{confirm.isError ? errorMessage(confirm.error, t) : null}</ErrorText>
            <Button type="submit" disabled={confirm.isPending}>
              {t("auth.totp.verify")}
            </Button>
          </form>
        </>
      ) : (
        <>
          <p>{t("auth.totp.step3")}</p>
          <RecoveryCodes codes={codes} ack={ack} onAck={setAck} />
          <Button type="button" disabled={!ack} onClick={() => void finish()}>
            {t("auth.totp.finish")}
          </Button>
        </>
      )}
    </section>
  );
}
```

In `router.tsx`: `totpSetupRoute` usa `component: () => <TotpSetupPage />` (import da `./pages/TotpSetupPage.js`).

Run: `pnpm --filter @kamino/web test -- TotpSetupPage` → PASS. Typecheck, lint, format.

```bash
git add apps/web
git commit -m "feat(web): add TOTP setup with recovery codes"
```

---

### Task 7: Pagina Account

**Files:**
- Create: `apps/web/src/pages/account/AccountPage.tsx`, `SectionCard.tsx`, `ProfileSection.tsx`, `PasswordSection.tsx`, `TotpSection.tsx`, `SessionsSection.tsx`, `SecurityLogSection.tsx`
- Test: `apps/web/src/pages/account/account.test.tsx`
- Modify: `apps/web/src/router.tsx` (`accountRoute` → `AccountPage`), `src/i18n/locales/{it,en}.json`

**Interfaces:**
- Consumes: `api`, `errorMessage`, `TotpSetupPage({ onDone })`, `RecoveryCodes`, `ThemeSwitcher`, `PasswordField`, `TextField`, `useTheme`.
- Produces: `AccountPage`.

- [ ] **Step 1: Testi**

`it.json`:

```json
"account": {
  "title": "Account",
  "saved": "Salvato.",
  "profile": { "title": "Profilo", "email": "Email", "language": "Lingua", "theme": "Tema", "save": "Salva" },
  "password": { "title": "Password", "current": "Password attuale", "save": "Cambia la password", "done": "Password cambiata." },
  "totp": {
    "title": "Verifica in due passaggi",
    "on": "Attiva",
    "off": "Non attiva",
    "enable": "Attiva",
    "disable": "Disattiva",
    "regenerate": "Rigenera i codici di recupero",
    "adminNote": "Per gli amministratori è obbligatoria.",
    "confirmPassword": "Conferma con la tua password",
    "confirm": "Conferma",
    "cancel": "Annulla",
    "newCodes": "Nuovi codici di recupero: quelli vecchi non funzionano più."
  },
  "sessions": {
    "title": "Sessioni attive",
    "current": "Questa sessione",
    "lastUsed": "Ultimo uso: {{when}}",
    "end": "Esci",
    "endOthers": "Esci da tutte le altre"
  },
  "log": {
    "title": "Registro di sicurezza",
    "newer": "Più recenti",
    "older": "Meno recenti",
    "page": "Pagina {{page}} di {{pages}}",
    "types": {
      "login": "Accesso",
      "login_failed": "Accesso non riuscito",
      "device_linked": "Nuovo dispositivo collegato",
      "password_changed": "Password cambiata",
      "admin_reset": "Reset della password avviato dall'amministratore",
      "totp_enabled": "Verifica in due passaggi attivata",
      "totp_disabled": "Verifica in due passaggi disattivata"
    }
  }
}
```

`en.json`:

```json
"account": {
  "title": "Account",
  "saved": "Saved.",
  "profile": { "title": "Profile", "email": "Email", "language": "Language", "theme": "Theme", "save": "Save" },
  "password": { "title": "Password", "current": "Current password", "save": "Change password", "done": "Password changed." },
  "totp": {
    "title": "Two-step verification",
    "on": "On",
    "off": "Off",
    "enable": "Turn on",
    "disable": "Turn off",
    "regenerate": "Regenerate recovery codes",
    "adminNote": "It is mandatory for administrators.",
    "confirmPassword": "Confirm with your password",
    "confirm": "Confirm",
    "cancel": "Cancel",
    "newCodes": "New recovery codes: the old ones no longer work."
  },
  "sessions": {
    "title": "Active sessions",
    "current": "This session",
    "lastUsed": "Last used: {{when}}",
    "end": "Sign out",
    "endOthers": "Sign out of all others"
  },
  "log": {
    "title": "Security log",
    "newer": "Newer",
    "older": "Older",
    "page": "Page {{page}} of {{pages}}",
    "types": {
      "login": "Sign-in",
      "login_failed": "Failed sign-in",
      "device_linked": "New device linked",
      "password_changed": "Password changed",
      "admin_reset": "Password reset started by the administrator",
      "totp_enabled": "Two-step verification turned on",
      "totp_disabled": "Two-step verification turned off"
    }
  }
}
```

- [ ] **Step 2: Test (falliscono)**

`apps/web/src/pages/account/account.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { db, signInAs } from "../../mocks/db.js";
import { renderRoute } from "../../test/render.js";

afterEach(cleanup);

const section = async (title: string) => (await screen.findByRole("heading", { name: title })).closest("section")!;
const typeIn = (root: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(root).getByLabelText(label, { selector: "input" }), { target: { value } });

describe("AccountPage", () => {
  it("profile: saves the email", async () => {
    signInAs("demo");
    await renderRoute("/account", "it");
    const s = await section("Profilo");
    typeIn(s, "Email", "new@example.com");
    fireEvent.click(within(s).getByRole("button", { name: "Salva" }));
    await waitFor(() => expect(db.users.find((u) => u.username === "demo")!.email).toBe("new@example.com"));
  });

  it("password: wrong current password, then success", async () => {
    signInAs("demo");
    await renderRoute("/account");
    const s = await section("Password");
    typeIn(s, "Password attuale", "nope");
    typeIn(s, "Nuova password", "another-pass-12");
    typeIn(s, "Ripeti la password", "another-pass-12");
    fireEvent.click(within(s).getByRole("button", { name: "Cambia la password" }));
    expect(await within(s).findByText("La password attuale non è corretta.")).toBeDefined();
    typeIn(s, "Password attuale", "demo-password-1");
    fireEvent.click(within(s).getByRole("button", { name: "Cambia la password" }));
    expect(await within(s).findByText("Password cambiata.")).toBeDefined();
  });

  it("TOTP: admins cannot turn it off", async () => {
    signInAs("admin");
    await renderRoute("/account");
    const s = await section("Verifica in due passaggi");
    expect(within(s).queryByRole("button", { name: "Disattiva" })).toBeNull();
    expect(within(s).getByText("Per gli amministratori è obbligatoria.")).toBeDefined();
  });

  it("TOTP: a user turns it off with the password", async () => {
    signInAs("demo");
    db.users.find((u) => u.username === "demo")!.totpEnabled = true;
    await renderRoute("/account");
    const s = await section("Verifica in due passaggi");
    fireEvent.click(within(s).getByRole("button", { name: "Disattiva" }));
    typeIn(s, "Conferma con la tua password", "demo-password-1");
    fireEvent.click(within(s).getByRole("button", { name: "Conferma" }));
    await waitFor(() => expect(db.users.find((u) => u.username === "demo")!.totpEnabled).toBe(false));
  });

  it("sessions: current marked, sign out of the others", async () => {
    signInAs("admin");
    await renderRoute("/account");
    const s = await section("Sessioni attive");
    expect(await within(s).findByText("Questa sessione")).toBeDefined();
    expect(within(s).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(within(s).getByRole("button", { name: "Esci da tutte le altre" }));
    await waitFor(() => expect(within(s).getAllByRole("listitem")).toHaveLength(1));
  });

  it("security log: localized entries and pagination", async () => {
    signInAs("admin");
    await renderRoute("/account");
    const s = await section("Registro di sicurezza");
    expect(await within(s).findByText(/Pagina 1 di 2/)).toBeDefined();
    expect(within(s).getAllByRole("listitem").length).toBe(20);
    fireEvent.click(within(s).getByRole("button", { name: "Meno recenti" }));
    expect(await within(s).findByText(/Pagina 2 di 2/)).toBeDefined();
  });
});
```

(Il conteggio delle sessioni di `admin`: 2 di seed + quella aperta da `signInAs` = 3. Il registro di `admin`: 30 di seed + 1 accesso = 31 → 2 pagine.)

- [ ] **Step 3: Implementazione**

`apps/web/src/pages/account/SectionCard.tsx`:

```tsx
import type { ReactNode } from "react";

export function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bg-card space-y-4 rounded-xl border p-5">
      <h2 className="font-serif text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}
```

`apps/web/src/pages/account/ProfileSection.tsx`:

```tsx
import type { Me } from "@kamino/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { LanguageSwitch } from "../../components/LanguageSwitch.js";
import { TextField } from "../../components/TextField.js";
import { Button } from "../../components/ui/button.js";
import { ThemeSwitcher } from "../../theme/ThemeSwitcher.js";
import { ErrorText } from "../auth/AuthCard.js";
import { SectionCard } from "./SectionCard.js";

export function ProfileSection({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [email, setEmail] = useState(me.email);
  const save = useMutation({
    mutationFn: () => api.updateProfile({ email, lang: i18n.language === "en" ? "en" : "it" }),
    onSuccess: (updated) => {
      qc.setQueryData(["me"], updated);
      toast(t("account.saved"));
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <SectionCard title={t("account.profile.title")}>
      <form onSubmit={submit} className="space-y-4">
        <TextField label={t("account.profile.email")} value={email} onChange={setEmail} type="email" autoComplete="email" />
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{t("account.profile.language")}</p>
          <LanguageSwitch />
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{t("account.profile.theme")}</p>
          <ThemeSwitcher />
        </div>
        <ErrorText>{save.isError ? errorMessage(save.error, t) : null}</ErrorText>
        <Button type="submit" disabled={save.isPending}>
          {t("account.profile.save")}
        </Button>
      </form>
    </SectionCard>
  );
}
```

(Il tema resta salvato in locale dal `ThemeSwitcher` esistente; l'invio del tema al server è rinviato a 4b insieme alla sincronizzazione delle preferenze, annotato nell'HANDOVER.)

`apps/web/src/pages/account/PasswordSection.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { newPasswordError } from "../../components/newPassword.js";
import { PasswordField } from "../../components/PasswordField.js";
import { Button } from "../../components/ui/button.js";
import { ErrorText } from "../auth/AuthCard.js";
import { SectionCard } from "./SectionCard.js";

export function PasswordSection() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const pwError = newPasswordError(next, repeat, t);
    if (pwError) return setError(pwError);
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await api.changePassword(current, next);
      setDone(true);
      setCurrent("");
      setNext("");
      setRepeat("");
    } catch (err) {
      setError(errorMessage(err, t));
      setCurrent("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard title={t("account.password.title")}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <PasswordField label={t("account.password.current")} value={current} onChange={setCurrent} autoComplete="current-password" />
        <PasswordField label={t("auth.password.new")} value={next} onChange={setNext} autoComplete="new-password" />
        <PasswordField label={t("auth.password.repeat")} value={repeat} onChange={setRepeat} autoComplete="new-password" />
        <ErrorText>{error}</ErrorText>
        {done && <p role="status" className="text-status-safe text-sm">{t("account.password.done")}</p>}
        <Button type="submit" disabled={busy}>
          {t("account.password.save")}
        </Button>
      </form>
    </SectionCard>
  );
}
```

Nota: dopo un errore il test riscrive solo "Password attuale"; nuova e ripetuta restano compilate (vengono svuotate solo al successo).

`apps/web/src/pages/account/TotpSection.tsx`:

```tsx
import type { Me } from "@kamino/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { PasswordField } from "../../components/PasswordField.js";
import { RecoveryCodes } from "../../components/RecoveryCodes.js";
import { Button } from "../../components/ui/button.js";
import { ErrorText } from "../auth/AuthCard.js";
import { TotpSetupPage } from "../TotpSetupPage.js";
import { SectionCard } from "./SectionCard.js";

type Mode = "idle" | "enable" | "disable" | "regenerate";

export function TotpSection({ me }: { me: Me }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>("idle");
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (mode === "disable") await api.totpDisable(password);
      if (mode === "regenerate") setCodes((await api.regenerateRecoveryCodes(password)).recoveryCodes);
      await qc.invalidateQueries({ queryKey: ["me"] });
      setMode("idle");
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setPassword("");
    }
  };

  if (mode === "enable") {
    return (
      <SectionCard title={t("account.totp.title")}>
        <TotpSetupPage onDone={() => setMode("idle")} />
      </SectionCard>
    );
  }

  return (
    <SectionCard title={t("account.totp.title")}>
      <p>{me.totpEnabled ? t("account.totp.on") : t("account.totp.off")}</p>
      {codes && (
        <>
          <p role="status">{t("account.totp.newCodes")}</p>
          <RecoveryCodes codes={codes} />
        </>
      )}
      {mode === "idle" ? (
        <div className="flex flex-wrap gap-2">
          {!me.totpEnabled && <Button onClick={() => setMode("enable")}>{t("account.totp.enable")}</Button>}
          {me.totpEnabled && (
            <Button variant="outline" onClick={() => setMode("regenerate")}>
              {t("account.totp.regenerate")}
            </Button>
          )}
          {me.totpEnabled && me.role !== "admin" && (
            <Button variant="outline" onClick={() => setMode("disable")}>
              {t("account.totp.disable")}
            </Button>
          )}
        </div>
      ) : (
        <form onSubmit={(e) => void confirm(e)} className="space-y-3">
          <PasswordField label={t("account.totp.confirmPassword")} value={password} onChange={setPassword} autoComplete="current-password" />
          <div className="flex gap-2">
            <Button type="submit">{t("account.totp.confirm")}</Button>
            <Button type="button" variant="ghost" onClick={() => setMode("idle")}>
              {t("account.totp.cancel")}
            </Button>
          </div>
        </form>
      )}
      <ErrorText>{error}</ErrorText>
      {me.role === "admin" && <p className="text-muted-foreground text-sm">{t("account.totp.adminNote")}</p>}
    </SectionCard>
  );
}
```

`apps/web/src/pages/account/SessionsSection.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { Button } from "../../components/ui/button.js";
import { SectionCard } from "./SectionCard.js";

export function SessionsSection() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.sessions });
  const refresh = () => qc.invalidateQueries({ queryKey: ["sessions"] });
  const end = useMutation({ mutationFn: api.endSession, onSuccess: refresh });
  const endOthers = useMutation({ mutationFn: api.endOtherSessions, onSuccess: refresh });
  const when = (iso: string) => new Date(iso).toLocaleString(i18n.language);

  return (
    <SectionCard title={t("account.sessions.title")}>
      <ul className="divide-y">
        {sessions.data?.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div>
              <p className="font-medium">
                {s.client} {s.current && <span className="text-status-safe text-sm">· {t("account.sessions.current")}</span>}
              </p>
              <p className="text-muted-foreground text-sm">
                {s.ipPrefix} · {t("account.sessions.lastUsed", { when: when(s.lastUsedAt) })}
              </p>
            </div>
            {!s.current && (
              <Button size="sm" variant="outline" onClick={() => end.mutate(s.id)}>
                {t("account.sessions.end")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {(sessions.data?.length ?? 0) > 1 && (
        <Button variant="outline" onClick={() => endOthers.mutate()}>
          {t("account.sessions.endOthers")}
        </Button>
      )}
    </SectionCard>
  );
}
```

`apps/web/src/pages/account/SecurityLogSection.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { Button } from "../../components/ui/button.js";
import { SectionCard } from "./SectionCard.js";

export function SecurityLogSection() {
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState(1);
  const log = useQuery({ queryKey: ["security-log", page], queryFn: () => api.securityLog(page) });
  const data = log.data;
  return (
    <SectionCard title={t("account.log.title")}>
      <ul className="divide-y">
        {data?.items.map((e) => (
          <li key={e.id} className="flex flex-wrap justify-between gap-2 py-2 text-sm">
            <span>
              {t(`account.log.types.${e.type}`)}
              {e.client ? ` · ${e.client}` : ""}
            </span>
            <time dateTime={e.at} className="text-muted-foreground">
              {new Date(e.at).toLocaleString(i18n.language)}
            </time>
          </li>
        ))}
      </ul>
      {data && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            {t("account.log.newer")}
          </Button>
          <span className="text-muted-foreground text-sm">{t("account.log.page", { page: data.page, pages: data.pages })}</span>
          <Button size="sm" variant="outline" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>
            {t("account.log.older")}
          </Button>
        </div>
      )}
    </SectionCard>
  );
}
```

`apps/web/src/pages/account/AccountPage.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { PasswordSection } from "./PasswordSection.js";
import { ProfileSection } from "./ProfileSection.js";
import { SecurityLogSection } from "./SecurityLogSection.js";
import { SessionsSection } from "./SessionsSection.js";
import { TotpSection } from "./TotpSection.js";

export function AccountPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("account.title"));
  const me = useQuery({ queryKey: ["me"], queryFn: api.me }).data;
  if (!me) return null;
  return (
    <div className="space-y-6">
      <h1 className="font-serif text-2xl font-semibold">{t("account.title")}</h1>
      <ProfileSection me={me} />
      <PasswordSection />
      <TotpSection me={me} />
      <SessionsSection />
      <SecurityLogSection />
    </div>
  );
}
```

In `router.tsx`: `accountRoute` con `component: AccountPage` (al posto di `page("/account", …)`).

Run: `pnpm --filter @kamino/web test` → PASS. Typecheck, lint, format.

```bash
git add apps/web
git commit -m "feat(web): add account page"
```

---

### Task 8: Documentazione e verifica finale

- [ ] **Step 1:** `docs/ui/design-system.md` — nuova sezione "9. Web app: struttura e account": barra laterale e menu mobile (stato complessivo, contatore conflitti, Amministrazione solo admin, mai bordo laterale), pagine pubbliche e regole (password ≥ 12, redirect solo interni, risposta identica per email inesistenti), TOTP obbligatorio per admin con 10 codici di recupero, Account (sezioni), dati: contratto in `@kamino/protocol`, MSW in sviluppo e test, utenti e token di prova (tabella), pannello "Dati finti".
- [ ] **Step 2:** HANDOVER (stato 4a, decisioni W1–W4, punti aperti: tema salvato sul server in 4b; API vere in M1+; anti-CSRF verificato dal server in M1); `CLAUDE.md` Comandi (riga: "dev della web app con API finte MSW: `pnpm --filter @kamino/web dev`, pannello 'Dati finti' in basso a destra"); changeset `.changeset/web-shell-account.md` (`"@kamino/web": minor` — "Add the web app shell with navigation, sign-in with two-step verification, setup, password reset, invites and the account page, on a typed API contract (fake API in development).").
- [ ] **Step 3:**

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm release-names:check
docker build -q -f docker/Dockerfile --build-arg KAMINO_BUILD_COMMIT=local .
git add docs CLAUDE.md .changeset && git commit -m "docs: document web shell and account" && git push
```

Expected: tutto verde, CI verde. Poi prova finale nel browser col committente, revisione finale (un subagente), PR.
