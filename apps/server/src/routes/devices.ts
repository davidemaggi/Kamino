import { DevicePatch } from "@kamino/protocol";
import type { FastifyInstance } from "fastify";
import { fail, requireUser } from "../auth/http.js";
import type { Db } from "../db/client.js";
import { deviceGuard } from "../devices/auth.js";
import type { DeviceService } from "../devices/service.js";
import { parse } from "./auth.js";

type IdParams = { id: string };

/** D-06: devices from the web (own devices only, no admin bypass) and from the plugin. */
export function deviceRoutes(db: Db, svc: DeviceService) {
  const guard = deviceGuard(db);
  return async (app: FastifyInstance) => {
    app.get("/devices", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      return svc.list(s.user.id);
    });

    app.get<{ Params: IdParams }>("/devices/:id", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      return (await svc.get(s.user.id, req.params.id)) ?? fail(reply, 404, "not_found");
    });

    app.patch<{ Params: IdParams }>("/devices/:id", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const b = parse(DevicePatch, req, reply);
      if (!b) return reply;
      return (await svc.rename(s.user.id, req.params.id, b.name)) ?? fail(reply, 404, "not_found");
    });

    app.post<{ Params: IdParams }>("/devices/:id/revoke", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      if (!(await svc.revoke(s.user.id, req.params.id))) return fail(reply, 404, "not_found");
      // The web contract returns the updated device (endpoints.ts: revokeDevice).
      return (await svc.get(s.user.id, req.params.id)) ?? fail(reply, 404, "not_found");
    });

    app.get("/device", { preHandler: guard }, async (req, reply) => {
      const d = req.device!;
      return (await svc.get(d.userId, d.id)) ?? fail(reply, 404, "not_found");
    });

    app.get("/vault/devices", { preHandler: guard }, async (req) =>
      svc.ofVault(req.device!.vaultId),
    );
  };
}
