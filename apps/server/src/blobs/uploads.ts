import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, lt } from "drizzle-orm";
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
import { blobs, uploadSessions } from "../db/schema.js";
import type { VaultCrypto } from "../vaults/vault-crypto.js";
import type { BlobStore } from "./store.js";

export const CHUNK_SIZE = 4 * 1024 * 1024;
const SESSION_TTL_MS = 24 * 3_600_000;

export class TransferError extends Error {
  constructor(
    readonly code: "file_too_large" | "hash_mismatch" | "not_found" | "invalid_request",
    readonly status: number,
  ) {
    super(code);
  }
}

export const blobKeyOf = (vaultId: string, blobId: string) => `${vaultId}/${blobId}`;

export class UploadService {
  constructor(
    private readonly db: Db,
    private readonly store: BlobStore,
    private readonly stagingDir: string,
    private readonly maxFileBytes: number,
    private readonly now: () => number = Date.now,
    private readonly chunkSize = CHUNK_SIZE,
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
    if (size > this.maxFileBytes) throw new TransferError("file_too_large", 413);
    const id = uuidv7();
    const expiresAt = new Date(this.now() + SESSION_TTL_MS);
    await this.db.insert(uploadSessions).values({
      id,
      vaultId: vc.vaultId,
      deviceId,
      contentHashEnc: vc.enc("upload_sessions", "content_hash", id, contentHash),
      blobId: vc.blobId(contentHash),
      size,
      chunkSize: this.chunkSize,
      salt: randomBytes(32),
      expiresAt,
    });
    await mkdir(this.dir(id), { recursive: true });
    return { uploadId: id, chunkSize: this.chunkSize, expiresAt: expiresAt.toISOString() };
  }

  private async session(vc: VaultCrypto, id: string) {
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
    const count = UploadService.count(s.size, s.chunkSize);
    if (!Number.isInteger(index) || index < 0 || index >= count)
      throw new TransferError("invalid_request", 400);
    const expected = index === count - 1 ? s.size - (count - 1) * s.chunkSize : s.chunkSize;
    if (body.length !== expected) throw new TransferError("invalid_request", 400);
    const sealed = encryptSegment(
      blobKey(vc.keys.content, s.salt),
      { vaultId: vc.vaultId, blobId: s.blobId },
      index,
      index === count - 1,
      body,
    );
    const target = join(this.dir(id), String(index));
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

  /** Verifies SHA-256 by decrypting in order, then promotes the segments as the blob (no re-encryption). */
  async complete(vc: VaultCrypto, id: string): Promise<{ contentHash: string; size: number }> {
    const s = await this.session(vc, id);
    const contentHash = vc.dec("upload_sessions", "content_hash", id, s.contentHashEnc);
    const count = UploadService.count(s.size, s.chunkSize);
    const got = await this.received(id);
    if (got.length !== count) throw new TransferError("invalid_request", 409);
    const key = blobKey(vc.keys.content, s.salt);
    const ids = { vaultId: vc.vaultId, blobId: s.blobId };
    const sha = createHash("sha256");
    try {
      for (let i = 0; i < count; i++)
        sha.update(
          decryptSegment(
            key,
            ids,
            i,
            i === count - 1,
            await readFile(join(this.dir(id), String(i))),
          ),
        );
    } catch (e) {
      if (!(e instanceof CryptoError)) throw e;
      await this.discard(id);
      throw new TransferError("hash_mismatch", 422);
    }
    if (sha.digest("hex") !== contentHash) {
      await this.discard(id);
      throw new TransferError("hash_mismatch", 422);
    }
    const dir = this.dir(id);
    const hdr = header(s.salt, s.chunkSize);
    await this.store.put(
      blobKeyOf(vc.vaultId, s.blobId),
      (async function* () {
        yield hdr;
        for (let i = 0; i < count; i++) yield await readFile(join(dir, String(i)));
      })(),
    );
    const storedSize = HEADER_BYTES + s.size + count * TAG_BYTES;
    await this.db
      .insert(blobs)
      .values({ vaultId: vc.vaultId, blobId: s.blobId, size: s.size, storedSize })
      .onConflictDoNothing();
    await this.discard(id);
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
