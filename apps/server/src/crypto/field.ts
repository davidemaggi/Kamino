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
