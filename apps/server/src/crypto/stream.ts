import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { aadOf, CryptoError, FORMAT_V1 } from "./aead.js";
import { hkdf, INFO } from "./kdf.js";

/** version (1) ‖ salt (32) ‖ segmentSize (4, big-endian). */
export const HEADER_BYTES = 37;
export const TAG_BYTES = 16;
export const DEFAULT_SEGMENT = 4 * 1024 * 1024;

export interface BlobIds {
  vaultId: string;
  blobId: string;
}

/** Nonce = segment counter (8 bytes BE) ‖ 3 zero bytes ‖ last-segment flag. */
function nonce(index: number, last: boolean): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(index), 0);
  n[11] = last ? 1 : 0;
  return n;
}

/** Per-blob key: a fresh salt per blob, so counters never repeat under one key. */
export function blobKey(contentKey: Uint8Array, salt: Uint8Array): Buffer {
  return hkdf(contentKey, INFO.blob, salt);
}

export function encryptSegment(
  key: Uint8Array,
  ids: BlobIds,
  index: number,
  last: boolean,
  data: Uint8Array,
): Buffer {
  const c = createCipheriv("aes-256-gcm", key, nonce(index, last));
  c.setAAD(aadOf(ids.vaultId, ids.blobId));
  return Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
}

export function decryptSegment(
  key: Uint8Array,
  ids: BlobIds,
  index: number,
  last: boolean,
  sealed: Uint8Array,
): Buffer {
  const b = Buffer.from(sealed);
  if (b.length < TAG_BYTES) throw new CryptoError();
  try {
    const d = createDecipheriv("aes-256-gcm", key, nonce(index, last));
    d.setAAD(aadOf(ids.vaultId, ids.blobId));
    d.setAuthTag(b.subarray(b.length - TAG_BYTES));
    return Buffer.concat([d.update(b.subarray(0, b.length - TAG_BYTES)), d.final()]);
  } catch {
    throw new CryptoError();
  }
}

export function header(salt: Uint8Array, segmentSize: number): Buffer {
  const h = Buffer.alloc(HEADER_BYTES);
  h[0] = FORMAT_V1;
  Buffer.from(salt).copy(h, 1);
  h.writeUInt32BE(segmentSize, 33);
  return h;
}

/** Segmented AEAD (STREAM) of a whole buffer; M1c encrypts upload chunks with encryptSegment. */
export function encryptBlob(
  content: Uint8Array,
  contentKey: Uint8Array,
  ids: BlobIds,
  opts: { segmentSize?: number; salt?: Uint8Array } = {},
): Buffer {
  const segmentSize = opts.segmentSize ?? DEFAULT_SEGMENT;
  const salt = opts.salt ?? randomBytes(32);
  const key = blobKey(contentKey, salt);
  const count = Math.max(1, Math.ceil(content.length / segmentSize));
  const parts = [header(salt, segmentSize)];
  for (let i = 0; i < count; i++)
    parts.push(
      encryptSegment(
        key,
        ids,
        i,
        i === count - 1,
        content.subarray(i * segmentSize, (i + 1) * segmentSize),
      ),
    );
  return Buffer.concat(parts);
}

interface Layout {
  key: Buffer;
  segmentSize: number;
  count: number;
  /** Byte length of the plaintext. */
  size: number;
}

function layout(blob: Uint8Array, contentKey: Uint8Array): Layout {
  const b = Buffer.from(blob);
  if (b.length < HEADER_BYTES + TAG_BYTES || b[0] !== FORMAT_V1) throw new CryptoError();
  const segmentSize = b.readUInt32BE(33);
  if (segmentSize === 0) throw new CryptoError();
  const body = b.length - HEADER_BYTES;
  const full = segmentSize + TAG_BYTES;
  const count = Math.max(1, Math.ceil(body / full));
  const lastLen = body - (count - 1) * full;
  if (lastLen < TAG_BYTES || lastLen > full) throw new CryptoError();
  return {
    key: blobKey(contentKey, b.subarray(1, 33)),
    segmentSize,
    count,
    size: (count - 1) * segmentSize + lastLen - TAG_BYTES,
  };
}

function segmentAt(blob: Uint8Array, l: Layout, ids: BlobIds, i: number): Buffer {
  const full = l.segmentSize + TAG_BYTES;
  const start = HEADER_BYTES + i * full;
  const end = i === l.count - 1 ? blob.length : start + full;
  return decryptSegment(l.key, ids, i, i === l.count - 1, blob.subarray(start, end));
}

/** Whole-blob decryption: detects truncation, extension, reordering and tampering. */
export function decryptBlob(blob: Uint8Array, contentKey: Uint8Array, ids: BlobIds): Buffer {
  const l = layout(blob, contentKey);
  const parts: Buffer[] = [];
  for (let i = 0; i < l.count; i++) parts.push(segmentAt(blob, l, ids, i));
  return Buffer.concat(parts);
}

/** HTTP Range support: decrypts (and authenticates) only the segments covering the range. */
export function decryptRange(
  blob: Uint8Array,
  contentKey: Uint8Array,
  ids: BlobIds,
  offset: number,
  length: number,
): Buffer {
  const l = layout(blob, contentKey);
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > l.size
  )
    throw new CryptoError("range out of bounds");
  if (length === 0) return Buffer.alloc(0);
  const first = Math.floor(offset / l.segmentSize);
  const last = Math.floor((offset + length - 1) / l.segmentSize);
  const parts: Buffer[] = [];
  for (let i = first; i <= last; i++) parts.push(segmentAt(blob, l, ids, i));
  const joined = Buffer.concat(parts);
  const from = offset - first * l.segmentSize;
  return joined.subarray(from, from + length);
}
