import type { Config } from "../config/schema.js";
import { FsBlobStore } from "./fs-store.js";
import { S3BlobStore } from "./s3-store.js";

/** Encrypted blobs by key ("vaultId/blobId"). `put` is durable when it resolves. */
export interface BlobStore {
  put(key: string, parts: AsyncIterable<Uint8Array>): Promise<void>;
  /** Bytes [start, endExclusive). */
  getRange(key: string, start: number, endExclusive: number): AsyncIterable<Uint8Array>;
  size(key: string): Promise<number | null>;
  delete(key: string): Promise<void>;
}

/** Keys outside every vault (exports, probes): a nil-UUID "vault" no vault can have. */
export const SYSTEM_PREFIX = "00000000-0000-0000-0000-000000000000";

export function createBlobStore(storage: Config["storage"]): BlobStore {
  return storage.kind === "fs" ? new FsBlobStore(storage.dir) : new S3BlobStore(storage);
}

export async function collect(parts: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const p of parts) out.push(Buffer.from(p));
  return Buffer.concat(out);
}
