import { VaultDelete, VaultPatch } from "@kamino/protocol";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireUser } from "../auth/http.js";
import { readPlain } from "../blobs/uploads.js";
import type { BlobStore } from "../blobs/store.js";
import { ConflictService } from "../conflicts/service.js";
import type { Db } from "../db/client.js";
import { files, fileVersions } from "../db/schema.js";
import { HistoryService } from "../history/service.js";
import { zipFileName, zipStream } from "../history/zip.js";
import { ApiError, notFound, notImplemented } from "../http/errors.js";
import type { Hub } from "../realtime/hub.js";
import { ownedVault } from "../vaults/access.js";
import { deleteVault } from "../vaults/delete.js";
import type { Vault, VaultService } from "../vaults/service.js";
import { parse } from "./auth.js";
import { vaultDto } from "./vaults.js";

type IdParams = { id: string };

/**
 * P1 (M4): the user area over the owner's vaults. Every route resolves the vault through
 * `ownedVault` or the user's own vault list: someone else's vault is a 404, admins included.
 * History, trash and conflicts are read only for now (F2): restore and resolve answer 501.
 */
export function userAreaRoutes(deps: {
  db: Db;
  vaults: VaultService;
  store: BlobStore;
  hub: Hub;
  now: () => number;
}) {
  const { db, vaults: vaultsSvc, store, hub, now } = deps;
  const history = new HistoryService(db, store, now);
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
      return vaultDto(db, vaultsSvc, o.vault);
    });

    app.patch<{ Params: IdParams }>("/vaults/:id", async (req, reply) => {
      const o = await owned(req, reply, req.params.id);
      if (!o) return reply;
      const b = parse(VaultPatch, req, reply);
      if (!b) return reply;
      const v = await vaultsSvc.update(o.vault, b);
      return vaultDto(db, vaultsSvc, v);
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

    // F2: writing history and resolving conflicts arrive with M3.
    const later = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!requireUser(req, reply)) return reply;
      throw notImplemented();
    };
    app.post("/versions/:id/restore", later);
    app.post("/trash/:id/restore", later);
    app.post("/conflicts/resolve-all", later);
    app.post("/conflicts/:id/resolve", later);
  };
}
