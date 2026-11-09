import { createHmac } from "node:crypto";

/** Unique-index key for a path inside one vault (04 §5.1). */
export function pathMac(key: Uint8Array, collisionKey: string): Buffer {
  return createHmac("sha256", key).update(collisionKey, "utf8").digest();
}

/** Blob id inside one vault: same content, same id (dedup); no correlation across vaults. */
export function blobId(key: Uint8Array, contentHash: string): string {
  return createHmac("sha256", key).update(contentHash, "utf8").digest("hex");
}
