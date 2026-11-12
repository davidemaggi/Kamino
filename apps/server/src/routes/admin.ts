import { ConfigPatch, CreateUserRequest, UpdateUserRequest } from "@kamino/protocol";
import type { FastifyInstance } from "fastify";
import { auditPage, systemHealth, type HealthDeps } from "../admin/health.js";
import type { AdminUsers } from "../admin/users.js";
import { requireAdmin } from "../auth/http.js";
import type { AuthService } from "../auth/service.js";
import type { Outbox } from "../email/outbox.js";
import type { SystemConfigService } from "../system/config.js";
import { parse } from "./auth.js";

type Id = { Params: { id: string } };

export interface AdminRouteDeps {
  users: AdminUsers;
  auth: AuthService;
  config: SystemConfigService;
  outbox: Outbox;
  health: HealthDeps;
}

/** E-01..E-06: admin only (TOTP on); thin adapters over the admin services. */
export function adminRoutes(d: AdminRouteDeps) {
  return async (app: FastifyInstance) => {
    app.get("/admin/users", async (req, reply) => {
      if (!requireAdmin(req, reply)) return reply;
      return d.users.list();
    });
    app.post("/admin/users", async (req, reply) => {
      const a = requireAdmin(req, reply);
      if (!a) return reply;
      const b = parse(CreateUserRequest, req, reply);
      if (!b) return reply;
      return d.users.create(a.user, b);
    });
    app.get<Id>("/admin/users/:id", async (req, reply) => {
      if (!requireAdmin(req, reply)) return reply;
      return d.users.get(req.params.id);
    });
    app.patch<Id>("/admin/users/:id", async (req, reply) => {
      const a = requireAdmin(req, reply);
      if (!a) return reply;
      const b = parse(UpdateUserRequest, req, reply);
      if (!b) return reply;
      return d.users.update(a.user, req.params.id, b);
    });
    app.post<Id>("/admin/users/:id/block", async (req, reply) => {
      const a = requireAdmin(req, reply);
      if (!a) return reply;
      return d.users.block(a.user, req.params.id);
    });
    app.post<Id>("/admin/users/:id/unblock", async (req, reply) => {
      const a = requireAdmin(req, reply);
      if (!a) return reply;
      return d.users.unblock(a.user, req.params.id);
    });
    app.post<Id>("/admin/users/:id/reset-link", async (req, reply) => {
      const a = requireAdmin(req, reply);
      if (!a) return reply;
      return d.users.resetLink(a.user, req.params.id);
    });

    app.get("/admin/config", async (req, reply) => {
      if (!requireAdmin(req, reply)) return reply;
      return d.config.get();
    });
    app.patch("/admin/config", async (req, reply) => {
      const a = requireAdmin(req, reply);
      if (!a) return reply;
      const b = parse(ConfigPatch, req, reply);
      if (!b) return reply;
      return d.config.patch(b, a.user.username);
    });
    app.post("/admin/config/smtp-test", async (req, reply) => {
      const a = requireAdmin(req, reply);
      if (!a) return reply;
      await d.auth.audit(a.user.username, "smtp_test", a.user.username);
      return d.outbox.test(a.user.email, a.user.locale === "en" ? "en" : "it");
    });

    app.get("/admin/health", async (req, reply) => {
      if (!requireAdmin(req, reply)) return reply;
      return systemHealth(d.health);
    });
    app.get<{ Querystring: { page?: string } }>("/admin/audit", async (req, reply) => {
      if (!requireAdmin(req, reply)) return reply;
      return auditPage(d.health.db, Number(req.query.page ?? 1));
    });
  };
}
