import { randomBytes } from "node:crypto";
import { aadOf, open, seal } from "./aead.js";
import { hkdf, INFO } from "./kdf.js";
import type { Kek } from "./keyring.js";

export const DEK_BYTES = 32;

export interface VaultKeys {
  content: Buffer;
  meta: Buffer;
  pathmac: Buffer;
  blobid: Buffer;
}

export function generateDek(): Buffer {
  return randomBytes(DEK_BYTES);
}

/** 04 §5.1: AAD = vaultId ‖ kekId, so a wrapped DEK can't move to another vault or key. */
export function wrapDek(kek: Kek, vaultId: string, dek: Uint8Array): Buffer {
  return seal(kek.key, dek, aadOf(vaultId, kek.id));
}

export function unwrapDek(kek: Kek, vaultId: string, wrapped: Uint8Array): Buffer {
  return open(kek.key, wrapped, aadOf(vaultId, kek.id));
}

export function vaultKeys(dek: Uint8Array): VaultKeys {
  return {
    content: hkdf(dek, INFO.content),
    meta: hkdf(dek, INFO.meta),
    pathmac: hkdf(dek, INFO.pathmac),
    blobid: hkdf(dek, INFO.blobid),
  };
}

/** Key for system secrets (TOTP secrets, SMTP password). */
export function systemKey(kek: Kek): Buffer {
  return hkdf(kek.key, INFO.system);
}
