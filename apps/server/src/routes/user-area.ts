import { ResolveAllRequest, ResolveRequest, VaultDelete, VaultPatch } from "@kamino/protocol";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireUser } from "../auth/http.js";
import { readPlain, type UploadService } from "../blobs/uploads.js";
import type { BlobStore } from "../blobs/store.js";
import { ResolutionService } from "../conflicts/resolve.js";
import { ConflictService } from "../conflicts/service.js";
import type { Db } from "../db/client.js";
import { files, fileVersions } from "../db/schema.js";
import { RestoreService } from "../history/restore.js";
import { HistoryService } from "../history/service.js";
import { zipFileName, zipStream } from "../history/zip.js";
import { ApiError, notFound } from "../http/errors.js";
import type { Hub } from "../realtime/hub.js";
import type { SyncService } from "../sync/commit.js";
import { ownedVault } from "../vaults/access.js";
import { deleteVault } from "../vaults/delete.js";
import type { Vault, VaultService } from "../vaults/service.js";
import type { SystemConfigService } from "../system/config.js";
import { parse } from "./auth.js";
import { vaultDto } from "./vaults.js";

type IdParams = { id: string };

/**
 * P1 (M4): the user area over the owner's vaults. Every route resolves the vault through
 * `ownedVault` or the user's own vault list: someone else's vault is a 404, admins included.
 * Restores and resolutions (M3) are ops built by the server and committed like a device's.
 */
export function userAreaRoutes(deps: {
  db: Db;
  vaults: VaultService;
  store: BlobStore;
  hub: Hub;
  config: SystemConfigService;
  sync: SyncService;
  uploads: UploadService;
  now: () => number;
}) {
  const { db, vaults: vaultsSvc, store, hub, config, now } = deps;
  const resolver = new ResolutionService(db, deps.sync, vaultsSvc, deps.uploads);
  const restorer = new RestoreService(db, deps.sync);
  const langOf = (u: { locale: string }) => (u.locale === "en" ? "en" : "it");
  const maxDays = async () => (await config.effective()).maxRetentionDays;
  const history = new HistoryService(db, store, now, maxDays);
  const conflictsSvc = new ConflictService(db, store, vaultsSvc);

  const owned = async (req: FastifyRequest, reply: FastifyReply, vaultId: string) => {
    const s = requireUser(req, reply);
    if (!s) return null;
    return { userId: s.user.id, ...(await ownedVault(vaultsSvc, s.user.id, vaultId)) };
  };

  /** File and version ids are unique within a vault: the one owned vault holding it, or 404. */
  const vaultHolding = async (
    userId: string,
    table: typeof files | typeof fileVersions,
    id: string,
  ): Promise<Vault> => {
    const mine = await vaultsSvc.listForUser(userId);
    if (mine.length === 0) throw notFound();
    const rows = await db
      .select({ vaultId: table.vaultId })
      .from(table)
      .where(
        and(
          eq(table.id, id),
          inArray(
            table.vaultId,
            mine.map((v) => v.id),
          ),
        ),
      );
    const only = rows.length === 1 ? mine.find((v) => v.id === rows[0]!.vaultId) : undefined;
    if (!only) throw notFound();
    return only;
  };

  return async (app: FastifyInstance) => {
    app.get<{ Params: IdParams }>("/vaults/:id", async (req, reply) => {
      const o = await owned(req, reply, req.params.id);
      if (!o) return reply;
      return vaultDto(db, vaultsSvc, o.vault, await maxDays());
    });

    app.patch<{ Params: IdParams }>("/vaults/:id", async (req, reply) => {
      const o = await owned(req, reply, req.params.id);
      if (!o) return reply;
      const b = parse(VaultPatch, req, reply);
      if (!b) return reply;
      const max = await maxDays();
      if (b.retentionDays !== undefined && b.retentionDays > max)
        throw new ApiError("invalid_request", 400);
      const v = await vaultsSvc.update(o.vault, b);
      return vaultDto(db, vaultsSvc, v, max);
    });

    app.delete<{ Params: IdParams }>("/vaults/:id", async (req, reply) => {
      const o = await owned(req, reply, req.params.id);
      if (!o) return reply;
      const b = parse(VaultDelete, req, reply);
      if (!b) return reply;
      await deleteVault(db, hub, vaultsSvc, o.vault, b.confirmName, now());
      return reply.code(204).send();
    });

    app.get<{ Params: IdParams; Querystring: { q?: string } }>(
      "/vaults/:id/files",
      async (req, reply) => {
        const o = await owned(req, reply, req.params.id);
        if (!o) return reply;
        return history.search(o.vc, String(req.query.q ?? ""));
      },
    );

    app.get<{ Params: IdParams }>("/files/:id/versions", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const v = await vaultHolding(s.user.id, files, req.params.id);
      return history.versions(vaultsSvc.cryptoOf(v), req.params.id);
    });

    app.get<{ Params: IdParams }>("/versions/:id", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const v = await vaultHolding(s.user.id, fileVersions, req.params.id);
      return history.version(vaultsSvc.cryptoOf(v), req.params.id);
    });

    app.get<{ Params: IdParams }>("/vaults/:id/trash", async (req, reply) => {
      const o = await owned(req, reply, req.params.id);
      if (!o) return reply;
      return history.trash(o.vc);
    });

    app.get("/conflicts", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      return conflictsSvc.list(s.user.id);
    });

    app.get<{ Params: IdParams }>("/conflicts/:id", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const v = await conflictsSvc.vaultOf(s.user.id, req.params.id);
      return conflictsSvc.detail(v, req.params.id);
    });

    app.get<{ Params: IdParams; Querystring: { at?: string } }>(
      "/vaults/:id/zip",
      async (req, reply) => {
        const o = await owned(req, reply, req.params.id);
        if (!o) return reply;
        const raw = req.query.at;
        const at = raw ? new Date(raw) : null;
        if (at && Number.isNaN(at.getTime())) throw new ApiError("invalid_request", 400);
        // Built before the first byte: a date outside the window is still a clean 400.
        const tree = await history.treeAt(o.vc, at);
        const vc = o.vc;
        return reply
          .header("content-type", "application/zip")
          .header(
            "content-disposition",
            `attachment; filename="${zipFileName(at, new Date(now()))}"`,
          )
          .header("cache-control", "no-store")
          .send(zipStream(tree, (blobId, size) => readPlain(store, vc, blobId, size, 0, size)));
      },
    );

    app.post<{ Params: IdParams }>("/versions/:id/restore", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const v = await vaultHolding(s.user.id, fileVersions, req.params.id);
      await restorer.version(vaultsSvc.cryptoOf(v), req.params.id);
      return reply.code(204).send();
    });

    app.post<{ Params: IdParams }>("/trash/:id/restore", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const v = await vaultHolding(s.user.id, files, req.params.id);
      await restorer.trash(vaultsSvc.cryptoOf(v), req.params.id);
      return reply.code(204).send();
    });

    app.post("/conflicts/resolve-all", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const b = parse(ResolveAllRequest, req, reply);
      if (!b) return reply;
      const mine = await vaultsSvc.listForUser(s.user.id);
      return { resolved: await resolver.resolveAll(mine, langOf(s.user), b.strategy, b.items) };
    });

    app.post<{ Params: IdParams }>("/conflicts/:id/resolve", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const b = parse(ResolveRequest, req, reply);
      if (!b) return reply;
      const v = await conflictsSvc.vaultOf(s.user.id, req.params.id);
      await resolver.resolve(v, langOf(s.user), req.params.id, b.resolution, {
        incomingAt: b.expectedIncomingAt,
        mineAt: b.expectedMineAt,
      });
      return reply.code(204).send();
    });
  };
}
