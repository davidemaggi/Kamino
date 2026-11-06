import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { keyCheck } from "../db/schema.js";
import { KEY_CHECK_PLAINTEXT, MasterKeyError, type Kek } from "./keyring.js";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export const MISMATCH_MESSAGE = "master key does not match this database";
export const MISSING_MESSAGE = "no key check found; start the server once to initialize it";

/** Layout: iv (12) || auth tag (16) || ciphertext. AAD = kek.id. */
function seal(kek: Kek): Buffer {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv("aes-256-gcm", kek.key, iv);
  c.setAAD(Buffer.from(kek.id));
  const ct = Buffer.concat([c.update(KEY_CHECK_PLAINTEXT, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

function opens(kek: Kek, blob: Buffer): boolean {
  if (blob.length < IV_BYTES + TAG_BYTES) return false;
  try {
    const d = createDecipheriv("aes-256-gcm", kek.key, blob.subarray(0, IV_BYTES));
    d.setAAD(Buffer.from(kek.id));
    d.setAuthTag(blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const pt = Buffer.concat([d.update(blob.subarray(IV_BYTES + TAG_BYTES)), d.final()]);
    return pt.toString("utf8") === KEY_CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

async function activeRows(db: Db) {
  return db.select().from(keyCheck).where(isNull(keyCheck.retiredAt));
}

function verifyRows(rows: { kekId: string; checkValue: Buffer }[], kek: Kek): void {
  const row = rows.find((r) => r.kekId === kek.id);
  if (!row || !opens(kek, row.checkValue)) throw new MasterKeyError(MISMATCH_MESSAGE);
}

/**
 * Empty table: creates the check ("created"). Matching active row that decrypts:
 * "verified". Anything else: MasterKeyError. The insert is "on conflict do nothing"
 * followed by a re-read, so two instances racing on an empty table both end up verified.
 */
export async function ensureKeyCheck(db: Db, kek: Kek): Promise<"created" | "verified"> {
  const rows = await activeRows(db);
  if (rows.length > 0) {
    verifyRows(rows, kek);
    return "verified";
  }
  const inserted = await db
    .insert(keyCheck)
    .values({ kekId: kek.id, checkValue: seal(kek) })
    .onConflictDoNothing()
    .returning({ kekId: keyCheck.kekId });
  const after = await activeRows(db);
  verifyRows(after, kek);
  return inserted.length > 0 ? "created" : "verified";
}

/** Read-only variant for `keys verify`: never writes. Missing table or row throws. */
export async function verifyKeyCheck(db: Db, kek: Kek): Promise<"verified"> {
  let rows;
  try {
    rows = await db.select().from(keyCheck).where(isNull(keyCheck.retiredAt));
  } catch {
    throw new MasterKeyError(MISSING_MESSAGE);
  }
  if (rows.length === 0) throw new MasterKeyError(MISSING_MESSAGE);
  verifyRows(rows, kek);
  return "verified";
}

