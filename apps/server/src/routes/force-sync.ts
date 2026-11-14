import { ForcedDone, ForceSyncRequest } from "@kamino/protocol";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/http.js";
import type { Db } from "../db/client.js";
import { deviceGuard } from "../devices/auth.js";
import type { ForceSyncService } from "../devices/force-sync.js";
import { ownedVault } from "../vaults/access.js";
import type { VaultService } from "../vaults/service.js";
import { parse } from "./auth.js";

type IdParams = { id: string };

/**
 * Forced sync (ADR-0019): asked from the web app (owned vaults only, no admin bypass) or from a
 * device of the vault; each device asks what it has to do and reports when done.
 */
export function forceSyncRoutes(db: Db, vaults: VaultService, svc: ForceSyncService) {
  const guard = deviceGuard(db);
  return async (app: FastifyInstance) => {
    app.get<{ Params: IdParams }>("/vaults/:id/force-sync", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const { vault } = await ownedVault(vaults, s.user.id, req.params.id);
      return { request: await svc.state(vault.id) };
    });

    app.post<{ Params: IdParams }>("/vaults/:id/force-sync", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const { vault } = await ownedVault(vaults, s.user.id, req.params.id);
      const b = parse(ForceSyncRequest, req, reply);
      if (!b) return reply;
      return { request: await svc.request(vault.id, b) };
    });

    app.post("/vault/force-sync", { preHandler: guard }, async (req, reply) => {
      const b = parse(ForceSyncRequest, req, reply);
      if (!b) return reply;
      return { request: await svc.request(req.device!.vaultId, b) };
    });

    app.get("/vault/force-sync", { preHandler: guard }, async (req) => ({
      forced: await svc.pendingFor(req.device!),
    }));

    app.post<{ Params: IdParams }>(
      "/vault/force-sync/:id/done",
      { preHandler: guard },
      async (req, reply) => {
        const b = parse(ForcedDone, req, reply);
        if (!b) return reply;
        await svc.done(req.device!, req.params.id, b.role);
        return reply.code(204).send();
      },
    );
  };
}
