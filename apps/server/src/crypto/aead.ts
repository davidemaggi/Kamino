import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const FORMAT_V1 = 1;
const NONCE = 12;
const TAG = 16;

export class CryptoError extends Error {
  constructor(message = "decryption failed") {
    super(message);
    this.name = "CryptoError";
  }
}

/** AES-256-GCM with a random 96-bit nonce. Layout: version ‖ nonce ‖ ciphertext ‖ tag. */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  const nonce = randomBytes(NONCE);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([Buffer.from([FORMAT_V1]), nonce, ct, c.getAuthTag()]);
}

export function open(key: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Buffer {
  const b = Buffer.from(sealed);
  if (b.length < 1 + NONCE + TAG || b[0] !== FORMAT_V1) throw new CryptoError();
  try {
    const d = createDecipheriv("aes-256-gcm", key, b.subarray(1, 1 + NONCE));
    d.setAAD(aad);
    d.setAuthTag(b.subarray(b.length - TAG));
    return Buffer.concat([d.update(b.subarray(1 + NONCE, b.length - TAG)), d.final()]);
  } catch {
    throw new CryptoError();
  }
}

/** Unambiguous AAD from parts that never contain NUL. */
export function aadOf(...parts: string[]): Buffer {
  return Buffer.from(parts.join("\u0000"), "utf8");
}
