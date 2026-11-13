import { aadOf, open, seal } from "./aead.js";

/** Where an encrypted value lives: moving it to another row or column breaks decryption. */
export interface FieldRef {
  table: string;
  column: string;
  rowId: string;
}

export function encryptField(key: Uint8Array, ref: FieldRef, value: string | Uint8Array): Buffer {
  const plain = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return seal(key, plain, aadOf(ref.table, ref.column, ref.rowId));
}

export function decryptField(key: Uint8Array, ref: FieldRef, sealed: Uint8Array): Buffer {
  return open(key, sealed, aadOf(ref.table, ref.column, ref.rowId));
}

/** Tries each key in order (current, then previous during a rotation); GCM tells them apart. */
export function decryptFieldAny(
  keys: readonly Uint8Array[],
  ref: FieldRef,
  sealed: Uint8Array,
): Buffer {
  let last: unknown;
  for (const k of keys) {
    try {
      return decryptField(k, ref, sealed);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
