import {
  ForgotRequest,
  InviteAccept,
  LoginRequest,
  ResetRequest,
  SetupRequest,
  TotpLoginRequest,
} from "@kamino/protocol";
import type { Outbox } from "../email/outbox.js";
import type { SystemConfigService } from "../system/config.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { clearSessionCookie, ctxOf, fail, setSessionCookie } from "../auth/http.js";
import { RateLimiter } from "../auth/rate-limit.js";
import { keyOf, type AuthService, type User } from "../auth/service.js";

type Bucket = "login" | "totp" | "setup" | "reset" | "forgot" | "invite";

/** Validates a body with the contract schema; weak passwords get their own code. */
export function parse<T>(schema: z.ZodType<T>, req: FastifyRequest, reply: FastifyReply): T | null {
  const r = schema.safeParse(req.body);
  if (r.success) return r.data;
  // password_weak only for a too-short new password; anything else is a malformed request.
  const weak = r.error.issues.some(
    (i) => i.code === "too_small" && (i.path.includes("password") || i.path.includes("next")),
  );
  void fail(reply, 400, weak ? "password_weak" : "invalid_request");
  return null;
}

/** What "forgot password" needs to send a link; without it the answer is always `smtp: false`. */
export interface ForgotMail {
  outbox: Outbox;
  config: SystemConfigService;
  publicUrl: string;
}

export function authRoutes(auth: AuthService, secure: boolean, mail?: ForgotMail) {
  const limiter = new RateLimiter<Bucket>({
    login: { max: 10, windowMs: 15 * 60_000 },
    totp: { max: 10, windowMs: 15 * 60_000 },
    setup: { max: 10, windowMs: 15 * 60_000 },
    reset: { max: 10, windowMs: 15 * 60_000 },
    forgot: { max: 5, windowMs: 15 * 60_000 },
    invite: { max: 20, windowMs: 15 * 60_000 },
  });
  const limited = (
    bucket: Bucket,
    req: FastifyRequest,
    reply: FastifyReply,
    key = req.ip,
  ): boolean => {
    const r = limiter.hit(bucket, key);
    if (r.ok) return false;
    void fail(reply, 429, "rate_limited", r.retryAfterSec);
    return true;
  };
  const signIn = async (user: User, req: FastifyRequest, reply: FastifyReply) => {
    setSessionCookie(reply, await auth.createSession(user.id, ctxOf(req)), secure);
    return auth.me(user);
  };

  return async (app: FastifyInstance) => {
    app.get("/setup/status", async () => ({ needed: (await auth.userCount()) === 0 }));
    app.post("/setup", async (req, reply) => {
      if (limited("setup", req, reply)) return reply;
      const b = parse(SetupRequest, req, reply);
      if (!b) return reply;
      return signIn(await auth.setup(b, ctxOf(req)), req, reply);
    });
    app.post("/auth/login", async (req, reply) => {
      if (limited("login", req, reply)) return reply;
      const b = parse(LoginRequest, req, reply);
      if (!b) return reply;
      // Per account too: changing IP (or spoofing one) doesn't buy more password or TOTP tries.
      if (limited("login", req, reply, `user:${keyOf(b.username)}`)) return reply;
      const r = await auth.login(b.username, b.password, ctxOf(req));
      if (r.status === "totp_required") return r;
      return { status: "ok", me: await signIn(r.user, req, reply) };
    });
    app.post("/auth/totp", async (req, reply) => {
      if (limited("totp", req, reply)) return reply;
      const b = parse(TotpLoginRequest, req, reply);
      if (!b) return reply;
      return signIn(await auth.loginTotp(b.challengeId, b.code, ctxOf(req)), req, reply);
    });
    app.post("/auth/logout", async (req, reply) => {
      if (req.auth) await auth.revokeSession(req.auth.user.id, req.auth.sessionId);
      clearSessionCookie(reply, secure);
      return reply.code(204).send();
    });
    app.get("/me", async (req, reply) =>
      req.auth ? auth.me(req.auth.user) : fail(reply, 401, "unauthorized"),
    );
    app.post("/auth/forgot", async (req, reply) => {
      if (limited("forgot", req, reply)) return reply;
      const b = parse(ForgotRequest, req, reply);
      if (!b) return reply;
      // B5: same answer whether the email exists or not; smtp=false means "ask the admin".
      if (!mail || !(await mail.config.smtp())) return { smtp: false };
      const found = await auth.forgotLink(b.email);
      if (found)
        await mail.outbox.enqueue(
          found.user.email,
          "reset",
          found.user.locale === "en" ? "en" : "it",
          { link: `${mail.publicUrl}/reset/${found.token}` },
          { userId: found.user.id },
        );
      return { smtp: true };
    });
    app.post("/auth/reset", async (req, reply) => {
      if (limited("reset", req, reply)) return reply;
      const b = parse(ResetRequest, req, reply);
      if (!b) return reply;
      await auth.resetPassword(b.token, b.password, ctxOf(req));
      return reply.code(204).send();
    });
    app.get<{ Params: { token: string } }>("/invites/:token", async (req, reply) => {
      if (limited("invite", req, reply)) return reply;
      return auth.inviteInfo(req.params.token);
    });
    app.post<{ Params: { token: string } }>("/invites/:token/accept", async (req, reply) => {
      if (limited("invite", req, reply)) return reply;
      const b = parse(InviteAccept, req, reply);
      if (!b) return reply;
      return signIn(await auth.acceptInvite(req.params.token, b.password, ctxOf(req)), req, reply);
    });
  };
}
