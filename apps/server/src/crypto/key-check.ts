import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isNull, sql } from "drizzle-orm";
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

/** Any active check for a different key means this database belongs to another master key. */
function verifyRows(rows: { kekId: string; checkValue: Buffer }[], kek: Kek): void {
  if (rows.some((r) => r.kekId !== kek.id)) throw new MasterKeyError(MISMATCH_MESSAGE);
  const row = rows.find((r) => r.kekId === kek.id);
  if (!row || !opens(kek, row.checkValue)) throw new MasterKeyError(MISMATCH_MESSAGE);
}

/** Arbitrary constant for the transaction-level advisory lock serializing key-check creation. */
export const KEY_CHECK_LOCK_ID = 7_243_650_067n;

/**
 * Empty table: creates the check ("created"). Matching active row that decrypts:
 * "verified". Anything else (including any active row for a different key): MasterKeyError.
 * Check and insert run in one transaction under an advisory lock, so two instances racing
 * on an empty table with different keys cannot both create a check: the loser sees the
 * winner's row and fails.
 */
export async function ensureKeyCheck(db: Db, kek: Kek): Promise<"created" | "verified"> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${KEY_CHECK_LOCK_ID.toString()}::bigint)`);
    const rows = await tx.select().from(keyCheck).where(isNull(keyCheck.retiredAt));
    if (rows.length > 0) {
      verifyRows(rows, kek);
      return "verified";
    }
    await tx.insert(keyCheck).values({ kekId: kek.id, checkValue: seal(kek) });
    return "created";
  });
}

const UNDEFINED_TABLE = "42P01";

function isUndefinedTable(e: unknown): boolean {
  for (let cur: unknown = e, i = 0; cur && typeof cur === "object" && i < 5; i++) {
    if ((cur as { code?: unknown }).code === UNDEFINED_TABLE) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Read-only variant for `keys verify`: never writes. A missing table (SQLSTATE 42P01) or
 * zero active rows throws MISSING_MESSAGE; any other database error propagates unchanged.
 */
export async function verifyKeyCheck(db: Db, kek: Kek): Promise<"verified"> {
  let rows;
  try {
    rows = await db.select().from(keyCheck).where(isNull(keyCheck.retiredAt));
  } catch (e) {
    if (isUndefinedTable(e)) throw new MasterKeyError(MISSING_MESSAGE);
    throw e;
  }
  if (rows.length === 0) throw new MasterKeyError(MISSING_MESSAGE);
  verifyRows(rows, kek);
  return "verified";
}
