import { and, asc, eq, gt, isNotNull, isNull, max, ne, sql, count } from "drizzle-orm";
import { uuidv7 } from "../auth/tokens.js";
import { systemKey, unwrapDek, wrapDek } from "../crypto/dek.js";
import { decryptField, encryptField, type FieldRef } from "../crypto/field.js";
import { ensureKeyCheck } from "../crypto/key-check.js";
import { MasterKeyError, type Kek, type Keyring } from "../crypto/keyring.js";
import type { Db } from "../db/client.js";
import {
  auditLog,
  emailOutbox,
  keyCheck,
  systemConfig,
  userExports,
  users,
  vaults,
} from "../db/schema.js";

export type RotationReport = {
  /** Rows moved to the new key in this run (0 on a repeated run). */
  vaults: number;
  secrets: number;
  /** Rows that neither key opens: they were already unreadable; the old key is kept. */
  unreadable: number;
  /** True when the previous key's check has been retired. */
  done: boolean;
  /**
   * Deletion exports built under the previous key: their key comes from the link's token, which
   * isn't stored, so they can't be re-encrypted. Keep the previous key configured until `until`.
   */
  pendingExports: { count: number; until: Date | null };
};

const BATCH = 100;

/**
 * 04 §5.2: re-wraps every DEK and re-encrypts every system secret still under the previous key,
 * in small transactions; contents are never touched. Safe to repeat and to interrupt: each row
 * is moved on its own and a row already under the new key is skipped. Runs while the server is
 * up with both keys configured: every write the server makes meanwhile uses the new key, and an
 * update only lands if the row still holds the value that was read.
 */
export async function rotateKeys(
  db: Db,
  ring: Keyring,
  actor: string,
  batch = BATCH,
): Promise<RotationReport> {
  const previous = ring.previous;
  if (!previous) throw new MasterKeyError("no previous master key configured");
  const current: Kek = { id: ring.id, key: ring.key };
  await ensureKeyCheck(db, ring);

  const report: RotationReport = {
    vaults: 0,
    secrets: 0,
    unreadable: 0,
    done: false,
    pendingExports: { count: 0, until: null },
  };

  // DEKs: rows still tagged with the previous key. A destroyed DEK (deleted vault) only changes tag.
  for (;;) {
    const moved = await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: vaults.id, dekWrapped: vaults.dekWrapped })
        .from(vaults)
        .where(eq(vaults.kekId, previous.id))
        .limit(batch)
        .for("update");
      for (const r of rows) {
        const dekWrapped = r.dekWrapped
          ? wrapDek(current, r.id, unwrapDek(previous, r.id, r.dekWrapped))
          : null;
        await tx.update(vaults).set({ dekWrapped, kekId: current.id }).where(eq(vaults.id, r.id));
      }
      return rows.length;
    });
    report.vaults += moved;
    if (moved < batch) break;
  }
  const [stray] = await db.select({ n: count() }).from(vaults).where(ne(vaults.kekId, current.id));
  report.unreadable += stray?.n ?? 0;

  // System secrets have no key tag: whatever the new key doesn't open, the old one must.
  const oldSys = systemKey(previous);
  const newSys = systemKey(current);
  const reseal = (ref: FieldRef, sealed: Buffer): Buffer | "current" | "unreadable" => {
    try {
      decryptField(newSys, ref, sealed);
      return "current";
    } catch {
      // Not under the new key: try the old one below.
    }
    try {
      return encryptField(newSys, ref, decryptField(oldSys, ref, sealed));
    } catch {
      return "unreadable";
    }
  };

  // users.totp_secret, page by page.
  let after = "";
  for (;;) {
    const rows = await db
      .select({ id: users.id, s: users.totpSecret })
      .from(users)
      .where(and(isNotNull(users.totpSecret), gt(sql`${users.id}::text`, after)))
      .orderBy(asc(sql`${users.id}::text`))
      .limit(batch);
    for (const r of rows) {
      const out = reseal({ table: "users", column: "totp_secret", rowId: r.id }, r.s!);
      if (out === "unreadable") report.unreadable++;
      else if (out !== "current") {
        const done = await db
          .update(users)
          .set({ totpSecret: out })
          .where(and(eq(users.id, r.id), eq(users.totpSecret, r.s!)))
          .returning({ id: users.id });
        report.secrets += done.length;
      }
    }
    if (rows.length < batch) break;
    after = rows[rows.length - 1]!.id;
  }

  // system_config: the SMTP password is the only secret row.
  for (const r of await db
    .select({ key: systemConfig.key, s: systemConfig.secretEnc })
    .from(systemConfig)
    .where(isNotNull(systemConfig.secretEnc))) {
    const out = reseal({ table: "system_config", column: "secret", rowId: r.key }, r.s!);
    if (out === "unreadable") report.unreadable++;
    else if (out !== "current") {
      const done = await db
        .update(systemConfig)
        .set({ secretEnc: out })
        .where(and(eq(systemConfig.key, r.key), eq(systemConfig.secretEnc, r.s!)))
        .returning({ key: systemConfig.key });
      report.secrets += done.length;
    }
  }

  // email_outbox: recipient and parameters of every row still holding them.
  after = "";
  for (;;) {
    const rows = await db
      .select({ id: emailOutbox.id, to: emailOutbox.toEnc, params: emailOutbox.paramsEnc })
      .from(emailOutbox)
      .where(gt(sql`${emailOutbox.id}::text`, after))
      .orderBy(asc(sql`${emailOutbox.id}::text`))
      .limit(batch);
    for (const r of rows) {
      const to = reseal({ table: "email_outbox", column: "to", rowId: r.id }, r.to);
      const params = reseal({ table: "email_outbox", column: "params", rowId: r.id }, r.params);
      if (to === "unreadable" || params === "unreadable") {
        report.unreadable++;
        continue;
      }
      if (to === "current" && params === "current") continue;
      const done = await db
        .update(emailOutbox)
        .set({
          toEnc: to === "current" ? r.to : to,
          paramsEnc: params === "current" ? r.params : params,
        })
        .where(
          and(
            eq(emailOutbox.id, r.id),
            eq(emailOutbox.toEnc, r.to),
            eq(emailOutbox.paramsEnc, r.params),
          ),
        )
        .returning({ id: emailOutbox.id });
      report.secrets += done.length;
    }
    if (rows.length < batch) break;
    after = rows[rows.length - 1]!.id;
  }

  // Exports built before the new key's check existed are under the previous key.
  const [since] = await db
    .select({ at: keyCheck.createdAt })
    .from(keyCheck)
    .where(eq(keyCheck.kekId, current.id));
  const [exp] = await db
    .select({ n: count(), until: max(userExports.expiresAt) })
    .from(userExports)
    .where(
      and(
        isNotNull(userExports.readyAt),
        sql`${userExports.readyAt} <= ${since!.at.toISOString()}::timestamptz`,
        gt(userExports.expiresAt, sql`now()`),
      ),
    );
  report.pendingExports = { count: exp?.n ?? 0, until: exp?.until ?? null };

  if (report.unreadable > 0) return report;
  await db.transaction(async (tx) => {
    const retired = await tx
      .update(keyCheck)
      .set({ retiredAt: sql`now()` })
      .where(and(eq(keyCheck.kekId, previous.id), isNull(keyCheck.retiredAt)))
      .returning({ id: keyCheck.kekId });
    if (retired.length > 0)
      await tx.insert(auditLog).values({
        id: uuidv7(),
        actor,
        action: "master_key_rotated",
        target: `${previous.id} → ${current.id}`,
      });
  });
  report.done = true;
  return report;
}
