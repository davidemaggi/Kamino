import { createHash, randomBytes } from "node:crypto";
import { envName, PRODUCT_SLUG } from "@kamino/brand";

/**
 * Fixed cryptographic domain-separation constants. They are deliberately NOT derived
 * from @kamino/brand: renaming the product must never change key ids or invalidate
 * existing key checks (see docs/renaming.md, "non rinominare").
 */
export const KEK_ID_DOMAIN = "kamino-kek-id";
export const KEY_CHECK_PLAINTEXT = "kamino-key-check";

export const KEY_BYTES = 32;

/** Key-encryption key: `id` is the first 16 hex chars of SHA-256(domain || key). */
export type Kek = { id: string; key: Uint8Array };

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasterKeyError";
  }
}

function formatError(): MasterKeyError {
  return new MasterKeyError(
    `master key must be base64 (standard or URL-safe) of exactly ${KEY_BYTES} bytes; ` +
      `generate one with \`${PRODUCT_SLUG} keys generate\` ` +
      `(Docker: \`docker run --rm <image> keys generate\` or \`docker compose run --rm kamino keys generate\`)`,
  );
}

/** Never includes the supplied value in errors. */
export function parseMasterKey(raw: string): Kek {
  const s = raw.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) throw formatError();
  const unpadded = s.replace(/=+$/, "");
  // 32 bytes encode to exactly 43 significant base64 characters.
  if (unpadded.length !== 43) throw formatError();
  const key = Buffer.from(unpadded, "base64");
  if (key.length !== KEY_BYTES) throw formatError();
  const id = createHash("sha256").update(KEK_ID_DOMAIN).update(key).digest("hex").slice(0, 16);
  return { id, key: new Uint8Array(key) };
}

export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/**
 * 04 §5.2: the current KEK plus, during a rotation, the previous one. New data is always
 * written with the current key; reads fall back to the previous one until `keys rotate` is done.
 */
export type Keyring = Kek & { previous?: Kek | undefined };

export function keyringOf(current: Kek, previous?: Kek): Keyring {
  return previous && previous.id !== current.id ? { ...current, previous } : current;
}

/** The current key first, then the previous one. */
export function keksOf(ring: Keyring): Kek[] {
  const current: Kek = { id: ring.id, key: ring.key };
  return ring.previous ? [current, ring.previous] : [current];
}

/** The key a row was wrapped with (vaults.kek_id). */
export function kekFor(ring: Keyring, id: string): Kek {
  const k = keksOf(ring).find((x) => x.id === id);
  if (!k) throw new MasterKeyError("data wrapped with a master key that is not configured");
  return k;
}

/** Both configured keys; errors name the variable at fault, never the value. */
export function parseKeyring(current: string, previous?: string): Keyring {
  const kek = parseMasterKey(current);
  if (previous === undefined) return kek;
  try {
    return keyringOf(kek, parseMasterKey(previous));
  } catch (e) {
    if (e instanceof MasterKeyError)
      throw new MasterKeyError(`${envName("MASTER_KEY_PREVIOUS")}: ${e.message}`);
    throw e;
  }
}
