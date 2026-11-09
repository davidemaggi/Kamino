import { hkdfSync } from "node:crypto";

/** Fixed domain-separation labels (B4): never derived from @kamino/brand. */
export const INFO = {
  system: "kamino/v1/system",
  content: "kamino/v1/content",
  meta: "kamino/v1/meta",
  pathmac: "kamino/v1/pathmac",
  blobid: "kamino/v1/blobid",
  blob: "kamino/v1/blob",
} as const;

/** HKDF-SHA-256. */
export function hkdf(
  key: Uint8Array,
  info: string,
  salt: Uint8Array = new Uint8Array(0),
  length = 32,
): Buffer {
  return Buffer.from(hkdfSync("sha256", key, salt, info, length));
}
