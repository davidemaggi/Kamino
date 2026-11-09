import { PasswordChange, PasswordConfirm, ProfilePatch, TotpConfirm } from "@kamino/protocol";
import type { FastifyInstance } from "fastify";
import { ctxOf, requireUser } from "../auth/http.js";
import type { AuthService } from "../auth/service.js";
import { parse } from "./auth.js";

export function accountRoutes(auth: AuthService) {
  return async (app: FastifyInstance) => {
    app.patch("/account/profile", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const b = parse(ProfilePatch, req, reply);
      if (!b) return reply;
      return auth.me(await auth.updateProfile(s.user, b));
    });
    app.post("/account/password", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const b = parse(PasswordChange, req, reply);
      if (!b) return reply;
      await auth.changePassword(s.user, b.current, b.next, s.sessionId, ctxOf(req));
      return reply.code(204).send();
    });
    app.post("/account/totp/setup", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      return auth.totpSetup(s.user);
    });
    app.post("/account/totp/confirm", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const b = parse(TotpConfirm, req, reply);
      if (!b) return reply;
      return { recoveryCodes: await auth.totpConfirm(s.user, b.code, ctxOf(req)) };
    });
    app.post("/account/totp/disable", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const b = parse(PasswordConfirm, req, reply);
      if (!b) return reply;
      await auth.totpDisable(s.user, b.password, ctxOf(req));
      return reply.code(204).send();
    });
    app.post("/account/totp/recovery-codes", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const b = parse(PasswordConfirm, req, reply);
      if (!b) return reply;
      return { recoveryCodes: await auth.regenerateRecoveryCodes(s.user, b.password) };
    });
    app.get("/account/sessions", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      return auth.listSessions(s.user.id, s.sessionId);
    });
    app.delete<{ Params: { id: string } }>("/account/sessions/:id", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      await auth.revokeSession(s.user.id, req.params.id);
      return reply.code(204).send();
    });
    app.delete("/account/sessions", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      await auth.revokeOtherSessions(s.user.id, s.sessionId);
      return reply.code(204).send();
    });
    app.get<{ Querystring: { page?: string } }>("/account/security-log", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      return auth.securityLog(s.user.id, Number(req.query.page) || 1);
    });
  };
}
