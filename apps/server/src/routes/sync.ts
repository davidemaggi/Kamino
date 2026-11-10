import { AckRequest, CommitRequest, DeviceStatusReport } from "@kamino/protocol";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AuthError } from "../auth/service.js";
import type { Db } from "../db/client.js";
import { devices } from "../db/schema.js";
import { deviceGuard } from "../devices/auth.js";
import type { SyncService } from "../sync/commit.js";
import type { VaultService } from "../vaults/service.js";
import type { VaultCrypto } from "../vaults/vault-crypto.js";
import { parse } from "./auth.js";

type VaultParams = { vaultId: string };

export function syncRoutes(db: Db, vaultsSvc: VaultService, sync: SyncService) {
  const guard = deviceGuard(db);
  const cryptoFor = async (req: FastifyRequest): Promise<VaultCrypto> => {
    const v = await vaultsSvc.byId(req.device!.vaultId);
    if (!v || v.status !== "active") throw new AuthError("not_found", 404);
    return vaultsSvc.cryptoOf(v);
  };

  return async (app: FastifyInstance) => {
    app.post<{ Params: VaultParams }>(
      "/vaults/:vaultId/commits",
      { preHandler: guard },
      async (req, reply) => {
        const b = parse(CommitRequest, req, reply);
        if (!b) return reply;
        return sync.commit(await cryptoFor(req), req.device!.id, b.ops);
      },
    );

    app.get<{ Params: VaultParams; Querystring: { after?: string; limit?: string } }>(
      "/vaults/:vaultId/changes",
      { preHandler: guard },
      async (req) => {
        const after = Math.max(0, Math.floor(Number(req.query.after) || 0));
        const limit = Math.min(1000, Math.max(1, Math.floor(Number(req.query.limit) || 500)));
        return sync.changes(await cryptoFor(req), after, limit);
      },
    );

    app.get<{ Params: VaultParams }>(
      "/vaults/:vaultId/snapshot",
      { preHandler: guard },
      async (req) => sync.snapshot(await cryptoFor(req)),
    );

    app.post<{ Params: VaultParams }>(
      "/vaults/:vaultId/ack",
      { preHandler: guard },
      async (req, reply) => {
        const b = parse(AckRequest, req, reply);
        if (!b) return reply;
        await sync.ack(req.device!.id, req.device!.vaultId, b.seq);
        return reply.code(204).send();
      },
    );

    /** 03 §12: what the device reports about itself (counts and error codes only, never paths). */
    app.post<{ Params: VaultParams }>(
      "/vaults/:vaultId/status",
      { preHandler: guard },
      async (req, reply) => {
        const b = parse(DeviceStatusReport, req, reply);
        if (!b) return reply;
        await db
          .update(devices)
          .set({
            pendingOps: b.pendingOps,
            pendingBytes: b.pendingBytes,
            deferredFiles: b.deferredFiles,
            lastErrorCode: b.lastErrorCode ?? null,
            lastErrorAt: b.lastErrorCode ? new Date() : null,
          })
          .where(eq(devices.id, req.device!.id));
        return reply.code(204).send();
      },
    );
  };
}
