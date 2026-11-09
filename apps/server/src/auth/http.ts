import cookie from "@fastify/cookie";
import { PRODUCT_SLUG } from "@kamino/brand";
import type { ErrorCode } from "@kamino/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AuthError,
  SESSION_ABSOLUTE_MS,
  type AuthService,
  type Ctx,
  type User,
} from "./service.js";

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
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    if (WRITE.has(req.method) && req.headers["x-requested-with"] !== CSRF_VALUE)
      return fail(reply, 403, "forbidden");
    const token = req.cookies[SESSION_COOKIE];
    req.auth = token ? await service.resolveSession(token) : null;
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError) return fail(reply, err.status, err.code);
    // Fastify parse errors keep their 4xx status; never log request contents.
    const e = err as { name?: string; code?: unknown; statusCode?: number };
    if (e.statusCode !== undefined && e.statusCode < 500)
      return fail(reply, e.statusCode, "internal");
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
