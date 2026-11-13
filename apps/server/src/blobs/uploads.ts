import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { uuidv7 } from "../auth/tokens.js";
import { CryptoError } from "../crypto/aead.js";
import {
  blobKey,
  decryptSegment,
  encryptSegment,
  header,
  HEADER_BYTES,
  TAG_BYTES,
} from "../crypto/stream.js";
import type { Db } from "../db/client.js";
import { blobs, uploadSessions, vaults } from "../db/schema.js";
import type { VaultCrypto } from "../vaults/vault-crypto.js";
import type { BlobStore } from "./store.js";

export const CHUNK_SIZE = 4 * 1024 * 1024;
const SESSION_TTL_MS = 24 * 3_600_000;
/** A `complete` that crashed mid-way leaves its claim; after this long another call may take over. */
const CLAIM_TTL_MS = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class TransferError extends Error {
  constructor(
    readonly code: "file_too_large" | "hash_mismatch" | "not_found" | "invalid_request",
    readonly status: number,
  ) {
    super(code);
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Checks run when an upload session is created, inside its transaction (quota, Q-03). */
export type UploadGuard = (tx: Tx, vaultId: string, blobId: string, size: number) => Promise<void>;

export const blobKeyOf = (vaultId: string, blobId: string) => `${vaultId}/${blobId}`;

export class UploadService {
  constructor(
    private readonly db: Db,
    private readonly store: BlobStore,
    private readonly stagingDir: string,
    /** `null`: the guard checks the size (the limit can change from the UI, E-03). */
    private readonly maxFileBytes: number | null,
    private readonly now: () => number = Date.now,
    private readonly chunkSize = CHUNK_SIZE,
    private readonly guard: UploadGuard = async () => undefined,
  ) {}

  private dir(id: string): string {
    return join(this.stagingDir, id);
  }

  async missing(vc: VaultCrypto, hashes: string[]): Promise<string[]> {
    if (hashes.length === 0) return [];
    const ids = new Map(hashes.map((h) => [vc.blobId(h), h]));
    const rows = await this.db
      .select({ blobId: blobs.blobId })
      .from(blobs)
      .where(and(eq(blobs.vaultId, vc.vaultId), inArray(blobs.blobId, [...ids.keys()])));
    const present = new Set(rows.map((r) => r.blobId));
    return hashes.filter((h) => !present.has(vc.blobId(h)));
  }

  async create(vc: VaultCrypto, deviceId: string, contentHash: string, size: number) {
    if (this.maxFileBytes !== null && size > this.maxFileBytes)
      throw new TransferError("file_too_large", 413);
    const id = uuidv7();
    const expiresAt = new Date(this.now() + SESSION_TTL_MS);
    const blobId = vc.blobId(contentHash);
    await this.db.transaction(async (tx) => {
      await this.guard(tx, vc.vaultId, blobId, size);
      await tx.insert(uploadSessions).values({
        id,
        vaultId: vc.vaultId,
        deviceId,
        contentHashEnc: vc.enc("upload_sessions", "content_hash", id, contentHash),
        blobId,
        size,
        chunkSize: this.chunkSize,
        salt: randomBytes(32),
        expiresAt,
      });
    });
    await mkdir(this.dir(id), { recursive: true });
    return { uploadId: id, chunkSize: this.chunkSize, expiresAt: expiresAt.toISOString() };
  }

  private async session(vc: VaultCrypto, id: string) {
    if (!UUID.test(id)) throw new TransferError("not_found", 404);
    const s = (
      await this.db
        .select()
        .from(uploadSessions)
        .where(and(eq(uploadSessions.id, id), eq(uploadSessions.vaultId, vc.vaultId)))
    )[0];
    if (!s || s.expiresAt.getTime() <= this.now()) throw new TransferError("not_found", 404);
    return s;
  }

  private static count(size: number, chunk: number): number {
    return Math.max(1, Math.ceil(size / chunk));
  }

  /** C6: the chunk is encrypted as STREAM segment `index` on arrival; plaintext never hits the disk. */
  async putChunk(vc: VaultCrypto, id: string, index: number, body: Buffer): Promise<number[]> {
    const s = await this.session(vc, id);
    // Once `complete` has claimed the session its chunks are frozen.
    if (s.state !== "open") throw new TransferError("invalid_request", 409);
    const count = UploadService.count(s.size, s.chunkSize);
    if (!Number.isInteger(index) || index < 0 || index >= count)
      throw new TransferError("invalid_request", 400);
    const expected = index === count - 1 ? s.size - (count - 1) * s.chunkSize : s.chunkSize;
    if (body.length !== expected) throw new TransferError("invalid_request", 400);
    const key = blobKey(vc.keys.content, s.salt);
    const ids = { vaultId: vc.vaultId, blobId: s.blobId };
    const target = join(this.dir(id), String(index));
    // A chunk is written once: a repeat must carry the same bytes (a different body would reuse
    // the segment's nonce with other plaintext).
    const previous = await readFile(target).catch(() => null);
    if (previous) {
      let same = false;
      try {
        same = decryptSegment(key, ids, index, index === count - 1, previous).equals(body);
      } catch (e) {
        if (!(e instanceof CryptoError)) throw e;
      }
      if (!same) throw new TransferError("invalid_request", 409);
      return this.received(id);
    }
    const sealed = encryptSegment(key, ids, index, index === count - 1, body);
    await writeFile(`${target}.tmp`, sealed);
    await rename(`${target}.tmp`, target);
    return this.received(id);
  }

  async received(id: string): Promise<number[]> {
    const names = await readdir(this.dir(id)).catch(() => [] as string[]);
    return names
      .filter((n) => /^\d+$/.test(n))
      .map(Number)
      .sort((a, b) => a - b);
  }

  async status(vc: VaultCrypto, id: string) {
    const s = await this.session(vc, id);
    return { received: await this.received(id), expiresAt: s.expiresAt.toISOString() };
  }

  /**
   * Claims the session, then in a single pass decrypts each staged segment once, hashing the
   * plaintext and streaming the same sealed bytes to the store (no re-encryption). Under a lock
   * per blob: a blob that already exists is never rewritten (dedup, and readers stay safe).
   * The blob row is written only after a durable `put` whose content matched the hash.
   */
  async complete(vc: VaultCrypto, id: string): Promise<{ contentHash: string; size: number }> {
    const s = await this.session(vc, id);
    const contentHash = vc.dec("upload_sessions", "content_hash", id, s.contentHashEnc);
    if (s.state === "done") return { contentHash, size: s.size };
    const count = UploadService.count(s.size, s.chunkSize);
    if (s.state === "open" && (await this.received(id)).length !== count)
      throw new TransferError("invalid_request", 409);
    const now = new Date(this.now());
    const claimed = await this.db
      .update(uploadSessions)
      .set({ state: "completing", claimedAt: now })
      .where(
        and(
          eq(uploadSessions.id, id),
          or(
            eq(uploadSessions.state, "open"),
            and(
              eq(uploadSessions.state, "completing"),
              lt(uploadSessions.claimedAt, new Date(this.now() - CLAIM_TTL_MS)),
            ),
          ),
        ),
      )
      .returning({ id: uploadSessions.id });
    if (claimed.length === 0) {
      // Another `complete` holds it (409, retry later) or has just finished.
      const again = await this.session(vc, id);
      if (again.state === "done") return { contentHash, size: s.size };
      throw new TransferError("invalid_request", 409);
    }
    const storeKey = blobKeyOf(vc.vaultId, s.blobId);
    let outcome: "stored" | "exists" | "mismatch" | "gone";
    try {
      outcome = await this.db.transaction(async (tx) => {
        // Shared lock on the vault row: a deletion waits for this blob or this blob sees it.
        const [vault] = await tx
          .select({ status: vaults.status })
          .from(vaults)
          .where(eq(vaults.id, vc.vaultId))
          .for("share");
        if (vault?.status !== "active") return "gone";
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${storeKey}, 0))`);
        const [exists] = await tx
          .select({ blobId: blobs.blobId })
          .from(blobs)
          .where(and(eq(blobs.vaultId, vc.vaultId), eq(blobs.blobId, s.blobId)));
        if (exists) return "exists";
        const key = blobKey(vc.keys.content, s.salt);
        const ids = { vaultId: vc.vaultId, blobId: s.blobId };
        const sha = createHash("sha256");
        const dir = this.dir(id);
        const hdr = header(s.salt, s.chunkSize);
        let bad = false;
        try {
          await this.store.put(
            storeKey,
            (async function* () {
              yield hdr;
              for (let i = 0; i < count; i++) {
                const sealed = await readFile(join(dir, String(i)));
                sha.update(decryptSegment(key, ids, i, i === count - 1, sealed));
                yield sealed;
              }
            })(),
          );
        } catch (e) {
          if (!(e instanceof CryptoError)) throw e;
          bad = true;
        }
        if (bad || sha.digest("hex") !== contentHash) {
          // No row references this key yet, and the lock keeps other writers out.
          await this.store.delete(storeKey);
          return "mismatch";
        }
        await tx.insert(blobs).values({
          vaultId: vc.vaultId,
          blobId: s.blobId,
          size: s.size,
          storedSize: HEADER_BYTES + s.size + count * TAG_BYTES,
        });
        return "stored";
      });
    } catch (e) {
      // Transient failure (storage, database): give the session back so the client can retry.
      await this.db
        .update(uploadSessions)
        .set({ state: "open", claimedAt: null })
        .where(eq(uploadSessions.id, id));
      throw e;
    }
    if (outcome === "gone") {
      await this.discard(id);
      throw new TransferError("not_found", 404);
    }
    if (outcome === "mismatch") {
      await this.discard(id);
      throw new TransferError("hash_mismatch", 422);
    }
    await this.db.update(uploadSessions).set({ state: "done" }).where(eq(uploadSessions.id, id));
    await rm(this.dir(id), { recursive: true, force: true });
    return { contentHash, size: s.size };
  }

  private async discard(id: string): Promise<void> {
    await this.db.delete(uploadSessions).where(eq(uploadSessions.id, id));
    await rm(this.dir(id), { recursive: true, force: true });
  }

  /** C10: expired sessions and their staging go away. */
  async sweep(): Promise<void> {
    const old = await this.db
      .select({ id: uploadSessions.id })
      .from(uploadSessions)
      .where(lt(uploadSessions.expiresAt, new Date(this.now())));
    for (const s of old) await this.discard(s.id);
    // Staging left behind by a crash. List first: a directory is created after its row (see
    // `create`), so any directory listed here already has its row if it is still live.
    const dirs = await readdir(this.stagingDir).catch(() => [] as string[]);
    const known = new Set(
      (await this.db.select({ id: uploadSessions.id }).from(uploadSessions)).map((r) => r.id),
    );
    for (const d of dirs)
      if (!known.has(d)) await rm(join(this.stagingDir, d), { recursive: true, force: true });
  }
}

/** Range download (C7): reads and decrypts only the segments covering [start, end). */
export async function* readPlain(
  store: BlobStore,
  vc: VaultCrypto,
  blobId: string,
  size: number,
  start: number,
  end: number,
): AsyncIterable<Buffer> {
  if (end <= start) return;
  const key = blobKeyOf(vc.vaultId, blobId);
  const head = Buffer.concat(await arrayOf(store.getRange(key, 0, HEADER_BYTES)));
  const segmentSize = head.readUInt32BE(33);
  const k = blobKey(vc.keys.content, head.subarray(1, 33));
  const count = Math.max(1, Math.ceil(size / segmentSize));
  const ids = { vaultId: vc.vaultId, blobId };
  for (let i = Math.floor(start / segmentSize); i <= Math.floor((end - 1) / segmentSize); i++) {
    const plainLen = i === count - 1 ? size - (count - 1) * segmentSize : segmentSize;
    const from = HEADER_BYTES + i * (segmentSize + TAG_BYTES);
    const sealed = Buffer.concat(
      await arrayOf(store.getRange(key, from, from + plainLen + TAG_BYTES)),
    );
    const plain = decryptSegment(k, ids, i, i === count - 1, sealed);
    const segStart = i * segmentSize;
    yield plain.subarray(Math.max(0, start - segStart), Math.min(plain.length, end - segStart));
  }
}

async function arrayOf(it: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const p of it) out.push(Buffer.from(p));
  return out;
}

/**
 * Stores content written on the server (a manual merge from the web app) through the same
 * upload path as a device: size and quota checks, encryption, dedup. `author` goes on the
 * session only. Returns what a put needs.
 */
export async function storePlain(
  uploads: UploadService,
  vc: VaultCrypto,
  author: string,
  data: Buffer,
): Promise<{ contentHash: string; size: number }> {
  const contentHash = createHash("sha256").update(data).digest("hex");
  if ((await uploads.missing(vc, [contentHash])).length === 0)
    return { contentHash, size: data.length };
  const s = await uploads.create(vc, author, contentHash, data.length);
  const count = Math.max(1, Math.ceil(data.length / s.chunkSize));
  for (let i = 0; i < count; i++)
    await uploads.putChunk(
      vc,
      s.uploadId,
      i,
      data.subarray(i * s.chunkSize, (i + 1) * s.chunkSize),
    );
  return uploads.complete(vc, s.uploadId);
}
