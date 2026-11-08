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
import { adminHandlers } from "./admin-handlers.js";
import { userHandlers } from "./user-handlers.js";
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
  const weak = parsed.error.issues.some(
    (i) => i.path.includes("password") || i.path.includes("next"),
  );
  return fail(400, weak ? "password_weak" : "internal");
}

function auth(): FakeUser | Response {
  return currentUser() ?? fail(401, "unauthorized");
}

const codes = () =>
  Array.from(
    { length: 10 },
    () =>
      `${nextId("R").slice(2).padStart(4, "B")}-${String(Math.floor(1000 + Math.random() * 8999))}`,
  );

const authHandlers = [
  http.get(`*/version`, () =>
    HttpResponse.json({
      version: "0.0.0",
      codename: "Ash",
      protocol: { min: 1, max: 1 },
      commit: "dev",
      buildDate: new Date(0).toISOString(),
    }),
  ),
  http.get(`${API}/setup/status`, () => HttpResponse.json({ needed: db.users.length === 0 })),
  http.post(`${API}/setup`, async ({ request }) => {
    if (db.users.length > 0) return fail(409, "setup_not_needed");
    const b = await body(request, SetupRequest);
    if (b instanceof Response) return b;
    if (b.token !== SETUP_TOKEN) return fail(403, "setup_token_invalid");
    const u: FakeUser = {
      id: nextId("u"),
      username: b.username,
      email: b.email,
      password: b.password,
      role: "admin",
      lang: "it",
      theme: "system",
      totpEnabled: false,
      totpSetupRequired: true,
      adminResetAt: null,
      locked: false,
      recoveryCodes: [],
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
    const u =
      ch && ch.expiresAt > Date.now() ? db.users.find((x) => x.id === ch.userId) : undefined;
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
    const raw = (await request
      .clone()
      .json()
      .catch(() => ({}))) as { token?: unknown };
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
      id: nextId("u"),
      username: inv.username,
      email: inv.email,
      password: b.password,
      role: "user",
      lang: "it",
      theme: "system",
      totpEnabled: false,
      totpSetupRequired: false,
      adminResetAt: null,
      locked: false,
      recoveryCodes: [],
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
    const raw = (await request
      .clone()
      .json()
      .catch(() => ({}))) as { current?: unknown };
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
        .map(({ id, client, ipPrefix, lastUsedAt }) => ({
          id,
          client,
          ipPrefix,
          lastUsedAt,
          current: id === db.currentSessionId,
        })),
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
    const page = Math.min(
      pages,
      Math.max(1, Number(new URL(request.url).searchParams.get("page")) || 1),
    );
    const items = all
      .slice((page - 1) * 20, page * 20)
      .map(({ id, type, at, client }) => ({ id, type, at, ...(client ? { client } : {}) }));
    return HttpResponse.json({ items, page, pages });
  }),
];

export const handlers = [...authHandlers, ...userHandlers, ...adminHandlers];
