import cookie from "@fastify/cookie";
import { PRODUCT_SLUG } from "@kamino/brand";
import type { ErrorCode } from "@kamino/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AuthError,
  needsTotpSetup,
  SESSION_ABSOLUTE_MS,
  type AuthService,
  type Ctx,
  type User,
} from "./service.js";
import { ApiError } from "../http/errors.js";
import { TransferError } from "../blobs/uploads.js";

/** What an admin without TOTP may still do (U-07): see who they are, enable TOTP, sign out. */
const TOTP_SETUP_ROUTES = new Set([
  "GET /api/v1/me",
  "POST /api/v1/auth/logout",
  "POST /api/v1/account/totp/setup",
  "POST /api/v1/account/totp/confirm",
]);

export const SESSION_COOKIE = `${PRODUCT_SLUG}_session`;
export const CSRF_VALUE = `${PRODUCT_SLUG}-web`;
const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

declare module "fastify" {
  interface FastifyRequest {
    auth: { user: User; sessionId: string } | null;
  }
}

export function fail(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  retryAfterSec?: number,
): FastifyReply {
  if (retryAfterSec !== undefined) void reply.header("retry-after", String(retryAfterSec));
  return reply
    .code(status)
    .send({ error: { code, message: code, retryable: status === 429 || status >= 500 } });
}

export const ctxOf = (req: FastifyRequest): Ctx => ({
  ip: req.ip,
  userAgent: req.headers["user-agent"],
});

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  void reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: SESSION_ABSOLUTE_MS / 1000,
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  void reply.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure, path: "/" });
}

/** Cookie parsing, CSRF on writes (B8), current user on every API request, AuthError → error body. */
export async function registerAuthHttp(app: FastifyInstance, service: AuthService): Promise<void> {
  await app.register(cookie);
  app.decorateRequest("auth", null);
  app.decorateRequest("device", null);
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    // Bearer requests (devices) carry no cookie: a third-party site can't set that header without CORS.
    const bearer = req.headers.authorization?.startsWith("Bearer ") ?? false;
    // The plugin's login uses no cookie and returns its token in the body: nothing for CSRF to steal.
    const deviceLogin = req.method === "POST" && req.url.split("?")[0] === "/api/v1/devices/login";
    if (
      WRITE.has(req.method) &&
      !bearer &&
      !deviceLogin &&
      req.headers["x-requested-with"] !== CSRF_VALUE
    )
      return fail(reply, 403, "forbidden");
    const token = req.cookies[SESSION_COOKIE];
    req.auth = token ? await service.resolveSession(token) : null;
    const route = `${req.method} ${req.url.split("?")[0]}`;
    if (req.auth && needsTotpSetup(req.auth.user) && !TOTP_SETUP_ROUTES.has(route))
      return fail(reply, 403, "totp_mandatory");
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError) return fail(reply, err.status, err.code);
    if (err instanceof TransferError) return fail(reply, err.status, err.code);
    if (err instanceof ApiError) return fail(reply, err.status, err.code);
    // Fastify parse errors keep their 4xx status; never log request contents.
    const e = err as { name?: string; code?: unknown; statusCode?: number };
    if (e.statusCode !== undefined && e.statusCode < 500)
      return fail(reply, e.statusCode, "invalid_request");
    app.log.error({ err: { name: e.name, code: e.code } }, "request failed");
    return fail(reply, 500, "internal");
  });
}

/** Route guard: the signed-in user, or a 401 already sent. */
export function requireUser(
  req: FastifyRequest,
  reply: FastifyReply,
): { user: User; sessionId: string } | null {
  if (!req.auth) {
    void fail(reply, 401, "unauthorized");
    return null;
  }
  return req.auth;
}
