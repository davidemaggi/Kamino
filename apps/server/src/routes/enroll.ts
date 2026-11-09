import {
  CreateVaultRequest,
  DeviceLoginRequest,
  DeviceRename,
  LinkDeviceRequest,
} from "@kamino/protocol";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ctxOf, fail } from "../auth/http.js";
import { RateLimiter } from "../auth/rate-limit.js";
import { keyOf, type AuthService } from "../auth/service.js";
import type { Db } from "../db/client.js";
import { devices } from "../db/schema.js";
import { deviceGuard } from "../devices/auth.js";
import type { VaultService } from "../vaults/service.js";
import { parse } from "./auth.js";

export function enrollRoutes(db: Db, auth: AuthService, vaultsSvc: VaultService) {
  const limiter = new RateLimiter<"login">({ login: { max: 10, windowMs: 15 * 60_000 } });
  const limited = (key: string, reply: FastifyReply) => {
    const r = limiter.hit("login", key);
    if (r.ok) return false;
    void fail(reply, 429, "rate_limited", r.retryAfterSec);
    return true;
  };
  const enrollUser = async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    return vaultsSvc.enrollUser(h?.startsWith("Bearer ") ? h.slice(7) : "");
  };

  return async (app: FastifyInstance) => {
    app.post("/devices/login", async (req, reply) => {
      if (limited(req.ip, reply)) return reply;
      const b = parse(DeviceLoginRequest, req, reply);
      if (!b) return reply;
      if (limited(`user:${keyOf(b.username)}`, reply)) return reply;
      const r = await auth.checkDeviceCredentials(b.username, b.password, b.totp, ctxOf(req));
      if (r.status === "totp_required") return r;
      const t = await vaultsSvc.createEnrollToken(r.user.id);
      return { status: "ok", enrollToken: t.token, expiresAt: t.expiresAt.toISOString() };
    });
    app.get("/enroll/vaults", async (req) => {
      const userId = await enrollUser(req);
      const list = await vaultsSvc.listForUser(userId);
      return {
        vaults: await Promise.all(
          list.map(async (v) => ({
            id: v.id,
            name: vaultsSvc.nameOf(v),
            ...(await vaultsSvc.counts(v.id)),
          })),
        ),
      };
    });
    app.post("/enroll/vaults", async (req, reply) => {
      const userId = await enrollUser(req);
      const b = parse(CreateVaultRequest, req, reply);
      if (!b) return reply;
      const v = await vaultsSvc.create(userId, b.name);
      return { id: v.id, name: b.name, fileCount: 0, deviceCount: 0 };
    });
    app.post<{ Params: { vaultId: string } }>(
      "/enroll/vaults/:vaultId/devices",
      async (req, reply) => {
        const userId = await enrollUser(req);
        const b = parse(LinkDeviceRequest, req, reply);
        if (!b) return reply;
        return vaultsSvc.linkDevice(userId, req.params.vaultId, b, req.ip);
      },
    );
    const guard = deviceGuard(db);
    app.patch("/device", { preHandler: guard }, async (req, reply) => {
      const b = parse(DeviceRename, req, reply);
      if (!b) return reply;
      await db.update(devices).set({ name: b.name }).where(eq(devices.id, req.device!.id));
      return reply.code(204).send();
    });
    app.delete("/device", { preHandler: guard }, async (req, reply) => {
      await db.update(devices).set({ revokedAt: new Date() }).where(eq(devices.id, req.device!.id));
      return reply.code(204).send();
    });
  };
}
