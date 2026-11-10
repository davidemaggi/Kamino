import { BlobsCheckRequest, ContentHash, UploadCreateRequest } from "@kamino/protocol";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { AuthError } from "../auth/service.js";
import { CHUNK_SIZE, readPlain, TransferError, type UploadService } from "../blobs/uploads.js";
import type { BlobStore } from "../blobs/store.js";
import type { Db } from "../db/client.js";
import { blobs } from "../db/schema.js";
import { deviceGuard } from "../devices/auth.js";
import type { VaultService } from "../vaults/service.js";
import type { VaultCrypto } from "../vaults/vault-crypto.js";
import { parse } from "./auth.js";

type VaultParams = { vaultId: string };

/** "bytes=a-b" / "bytes=a-" / "bytes=-n" → [start, end) within size, or null when absent/invalid. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size : Math.min(size, Number(m[2]) + 1);
  }
  return start < end && start < size ? { start, end } : null;
}

export function transferRoutes(
  db: Db,
  vaultsSvc: VaultService,
  uploads: UploadService,
  store: BlobStore,
) {
  const guard = deviceGuard(db);
  const cryptoFor = async (req: FastifyRequest): Promise<VaultCrypto> => {
    const v = await vaultsSvc.byId(req.device!.vaultId);
    if (!v || v.status !== "active") throw new AuthError("not_found", 404);
    return vaultsSvc.cryptoOf(v);
  };

  return async (app: FastifyInstance) => {
    // Chunks are raw bytes (C6); one chunk at most plus some slack.
    app.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: CHUNK_SIZE + 1024 },
      (_req, body, done) => done(null, body),
    );

    app.post<{ Params: VaultParams }>(
      "/vaults/:vaultId/blobs/check",
      { preHandler: guard },
      async (req, reply) => {
        const b = parse(BlobsCheckRequest, req, reply);
        if (!b) return reply;
        return { missing: await uploads.missing(await cryptoFor(req), b.hashes) };
      },
    );

    app.post<{ Params: VaultParams }>(
      "/vaults/:vaultId/uploads",
      { preHandler: guard },
      async (req, reply) => {
        const b = parse(UploadCreateRequest, req, reply);
        if (!b) return reply;
        return uploads.create(await cryptoFor(req), req.device!.id, b.contentHash, b.size);
      },
    );

    app.put<{ Params: VaultParams & { uploadId: string; index: string } }>(
      "/vaults/:vaultId/uploads/:uploadId/chunks/:index",
      { preHandler: guard },
      async (req) => {
        if (!Buffer.isBuffer(req.body)) throw new TransferError("invalid_request", 415);
        const received = await uploads.putChunk(
          await cryptoFor(req),
          req.params.uploadId,
          Number(req.params.index),
          req.body,
        );
        return { received };
      },
    );

    app.get<{ Params: VaultParams & { uploadId: string } }>(
      "/vaults/:vaultId/uploads/:uploadId",
      { preHandler: guard },
      async (req) => uploads.status(await cryptoFor(req), req.params.uploadId),
    );

    app.post<{ Params: VaultParams & { uploadId: string } }>(
      "/vaults/:vaultId/uploads/:uploadId/complete",
      { preHandler: guard },
      async (req) => uploads.complete(await cryptoFor(req), req.params.uploadId),
    );

    /** Plaintext of a blob, with Range (C7): only the needed segments are read and decrypted. */
    app.get<{ Params: VaultParams & { contentHash: string } }>(
      "/vaults/:vaultId/blobs/:contentHash",
      { preHandler: guard },
      async (req, reply) => {
        if (!ContentHash.safeParse(req.params.contentHash).success)
          throw new TransferError("invalid_request", 400);
        const vc = await cryptoFor(req);
        const id = vc.blobId(req.params.contentHash);
        const [row] = await db
          .select()
          .from(blobs)
          .where(and(eq(blobs.vaultId, vc.vaultId), eq(blobs.blobId, id)));
        if (!row) throw new TransferError("not_found", 404);
        const range = parseRange(req.headers.range, row.size);
        if (req.headers.range !== undefined && !range && row.size > 0) {
          void reply.header("content-range", `bytes */${row.size}`);
          return reply.code(416).send({
            error: { code: "invalid_request", message: "invalid_request", retryable: false },
          });
        }
        const { start, end } = range ?? { start: 0, end: row.size };
        void reply
          .header("accept-ranges", "bytes")
          .header("content-type", "application/octet-stream")
          .header("content-length", String(end - start));
        if (range)
          void reply.code(206).header("content-range", `bytes ${start}-${end - 1}/${row.size}`);
        return reply.send(Readable.from(readPlain(store, vc, id, row.size, start, end)));
      },
    );
  };
}
