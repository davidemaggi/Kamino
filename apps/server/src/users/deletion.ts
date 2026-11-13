import type { DeleteUserRequest } from "@kamino/protocol";
import { and, eq, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { assertOtherAdmin } from "../admin/users.js";
import type { AuthService, User } from "../auth/service.js";
import { hashToken, randomToken, uuidv7 } from "../auth/tokens.js";
import { SYSTEM_PREFIX, type BlobStore } from "../blobs/store.js";
import { readPlain } from "../blobs/uploads.js";
import { systemKey } from "../crypto/dek.js";
import { hkdf } from "../crypto/kdf.js";
import type { Kek } from "../crypto/keyring.js";
import {
  blobKey,
  decryptSegment,
  encryptSegment,
  header,
  HEADER_BYTES,
  TAG_BYTES,
} from "../crypto/stream.js";
import type { Db } from "../db/client.js";
import {
  oneTimeTokens,
  pairings,
  recoveryCodes,
  securityEvents,
  userExports,
  users,
  webSessions,
} from "../db/schema.js";
import type { Outbox } from "../email/outbox.js";
import { folderNames, zipParts, type ZipPart } from "../history/zip.js";
import { HistoryService } from "../history/service.js";
import { ApiError, notFound } from "../http/errors.js";
import type { Logger } from "../observability/logger.js";
import type { Hub } from "../realtime/hub.js";
import type { SystemConfigService } from "../system/config.js";
import { destroyVault } from "../vaults/delete.js";
import type { VaultService } from "../vaults/service.js";

/** U-12: the time the user has to download their export before everything is destroyed. */
export const DELETION_GRACE_MS = 7 * 24 * 3600_000;
/** Domain separation for the export key (B4: a fixed label, never from @kamino/brand). */
const INFO_EXPORT = "kamino/v1/export";
const SEGMENT = 1024 * 1024;
const EXPORT_IDS = (id: string) => ({ vaultId: id, blobId: "export" });
export const exportExpired = () => new ApiError("export_expired", 410);
export const storeKeyOf = (exportId: string) => `${SYSTEM_PREFIX}/${exportId.replaceAll("-", "")}`;

export interface DeletionDeps {
  db: Db;
  kek: Kek;
  auth: AuthService;
  vaults: VaultService;
  store: BlobStore;
  hub: Hub;
  config: SystemConfigService;
  outbox: Outbox;
  publicUrl: string;
  now: () => number;
  log?: Logger;
  /** STREAM segment of the export (tests use a small one to cross segment boundaries). */
  exportSegmentBytes?: number;
  /** Queues the export or the finalize job right away (main: pg-boss; tests run them by hand). */
  kick?: (job: "exports" | "finalize") => void;
}

/** What may be logged about a failure: an error class or code, never a message (it can hold paths). */
function failureCode(e: unknown): string {
  if (e instanceof ApiError) return e.code;
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
  return e instanceof Error ? e.name : "unknown";
}

/** Splits a byte stream into fixed segments, flagging the last one (STREAM needs to know it). */
async function* segments(src: AsyncIterable<Buffer>, size: number) {
  let buf = Buffer.alloc(0);
  let pending: Buffer | null = null;
  for await (const piece of src) {
    buf = Buffer.concat([buf, piece]);
    while (buf.length >= size) {
      if (pending) yield { data: pending, last: false };
      pending = buf.subarray(0, size);
      buf = buf.subarray(size);
    }
  }
  if (buf.length > 0) {
    if (pending) yield { data: pending, last: false };
    yield { data: buf, last: true };
  } else yield { data: pending ?? Buffer.alloc(0), last: true };
}

/**
 * F6 / U-12: deleting a user. Start: the account stops working at once (sessions, logins, device
 * tokens) and, if asked, an encrypted ZIP of all their vaults is built and its link goes to the
 * user's email only. Finalize (after 7 days, or at once without export): DEKs destroyed
 * (crypto-shredding), export destroyed, personal data removed, the row kept anonymized.
 */
export class UserDeletion {
  private readonly sysKey: Buffer;
  private readonly history: HistoryService;

  constructor(private readonly d: DeletionDeps) {
    this.sysKey = systemKey(d.kek);
    this.history = new HistoryService(d.db, d.store, d.now);
  }

  private exportKey(token: string): Buffer {
    return hkdf(this.sysKey, INFO_EXPORT, Buffer.from(token));
  }

  async start(by: User, userId: string, r: DeleteUserRequest): Promise<void> {
    const { db, now } = this.d;
    const [u] = await db
      .select()
      .from(users)
      .where(and(sql`${users.id}::text = ${userId}`, ne(users.status, "deleted")));
    if (!u) throw notFound();
    if (u.id === by.id) throw new ApiError("forbidden", 403);
    if (r.confirmUsername.trim() !== u.username) throw new ApiError("confirm_mismatch", 400);
    if (u.status === "pending_deletion") throw new ApiError("forbidden", 409);
    if (r.sendZip && !(await this.d.config.smtp())) throw new ApiError("smtp_not_configured", 409);
    const at = now();
    const deleteAt = new Date(at + (r.sendZip ? DELETION_GRACE_MS : 0));
    await db.transaction(async (tx) => {
      if (u.role === "admin") await assertOtherAdmin(tx, u.id);
      await tx
        .update(users)
        .set({ status: "pending_deletion", deletionScheduledAt: deleteAt, updatedAt: new Date(at) })
        .where(eq(users.id, u.id));
      await this.d.auth.revokeOtherSessions(u.id, null, tx);
      // Pending invitation or reset links die with the account.
      await tx.delete(oneTimeTokens).where(eq(oneTimeTokens.userId, u.id));
      await tx.delete(pairings).where(eq(pairings.userId, u.id));
      if (r.sendZip)
        await tx
          .insert(userExports)
          .values({ id: uuidv7(at), userId: u.id, expiresAt: deleteAt, createdAt: new Date(at) });
      await this.d.auth.audit(by.username, "user_deleted", u.username, tx);
    });
    this.d.hub.closeUser(u.id, { type: "error", code: "user_blocked", message: "user_blocked" });
    this.d.kick?.(r.sendZip ? "exports" : "finalize");
  }

  /** Builds the pending exports (job). Without SMTP they wait: the link could not be sent. */
  async runExports(): Promise<number> {
    if (!(await this.d.config.smtp())) return 0;
    const due = await this.d.db
      .select({ id: userExports.id })
      .from(userExports)
      .innerJoin(users, eq(users.id, userExports.userId))
      .where(and(isNull(userExports.readyAt), eq(users.status, "pending_deletion")));
    for (const e of due) await this.each("export", () => this.runExport(e.id));
    return due.length;
  }

  async runExport(exportId: string): Promise<void> {
    const { db, vaults: vaultsSvc, store, now } = this.d;
    const [row] = await db.select().from(userExports).where(eq(userExports.id, exportId));
    if (!row || row.readyAt) return;
    const [u] = await db.select().from(users).where(eq(users.id, row.userId));
    if (!u || u.status !== "pending_deletion") return;
    const vs = await vaultsSvc.listForUser(u.id);
    const names = folderNames(vs.map((v) => vaultsSvc.nameOf(v)));
    const parts: ZipPart[] = [];
    for (const [i, v] of vs.entries()) {
      const vc = vaultsSvc.cryptoOf(v);
      parts.push({
        folder: names[i]!,
        tree: await this.history.treeAt(vc, null),
        open: (blobId, size) => readPlain(store, vc, blobId, size, 0, size),
      });
    }
    const token = randomToken();
    const salt = randomBytes(32);
    const key = blobKey(this.exportKey(token), salt);
    const ids = EXPORT_IDS(row.id);
    let storedSize = 0;
    const segment = this.d.exportSegmentBytes ?? SEGMENT;
    async function* sealed(): AsyncIterable<Uint8Array> {
      const h = header(salt, segment);
      storedSize += h.length;
      yield h;
      let i = 0;
      for await (const s of segments(zipParts(parts) as AsyncIterable<Buffer>, segment)) {
        const c = encryptSegment(key, ids, i++, s.last, s.data);
        storedSize += c.length;
        yield c;
      }
    }
    // The object key depends only on the row: a crashed run is overwritten by the next one.
    await store.put(storeKeyOf(row.id), sealed());
    // The user gets at least the full grace period from now (the build may have waited for SMTP).
    const readyAt = now();
    const expiresAt = new Date(Math.max(row.expiresAt.getTime(), readyAt + DELETION_GRACE_MS));
    const locale = u.locale === "en" ? "en" : "it";
    // One transaction: if the email can't be queued, the export stays "not ready" and is rebuilt.
    await db.transaction(async (tx) => {
      await tx
        .update(userExports)
        .set({ tokenHash: hashToken(token), storedSize, readyAt: new Date(readyAt), expiresAt })
        .where(eq(userExports.id, row.id));
      await tx.update(users).set({ deletionScheduledAt: expiresAt }).where(eq(users.id, u.id));
      await this.d.outbox.enqueue(
        u.email,
        "export_ready",
        locale,
        {
          username: u.username,
          link: `${this.d.publicUrl}/api/v1/exports/${token}`,
          expires: expiresAt.toLocaleDateString(locale === "en" ? "en-GB" : "it-IT", {
            timeZone: "UTC",
          }),
        },
        { tx, userId: u.id },
      );
    });
  }

  /** The decrypted ZIP for a valid token; unknown, expired or destroyed → 410 export_expired. */
  async openExport(token: string): Promise<{ stream: Readable; createdAt: Date }> {
    const { db, store, now } = this.d;
    const [row] = await db
      .select()
      .from(userExports)
      .where(and(eq(userExports.tokenHash, hashToken(token)), isNotNull(userExports.readyAt)));
    if (!row || row.storedSize === null) throw exportExpired();
    if (row.expiresAt.getTime() <= now()) {
      // Not yet extended by the job: the grace period also counts from the email's delivery.
      const sent = await this.d.outbox.sentAt(row.userId, "export_ready");
      if (!sent || sent.getTime() + DELETION_GRACE_MS <= now()) throw exportExpired();
    }
    const objectKey = storeKeyOf(row.id);
    const first = Buffer.concat(await collect(store.getRange(objectKey, 0, HEADER_BYTES)));
    const segmentSize = first.readUInt32BE(33);
    const key = blobKey(this.exportKey(token), first.subarray(1, 33));
    const ids = EXPORT_IDS(row.id);
    const full = segmentSize + TAG_BYTES;
    const count = Math.max(1, Math.ceil((row.storedSize - HEADER_BYTES) / full));
    const total = row.storedSize;
    async function* plain() {
      for (let i = 0; i < count; i++) {
        const from = HEADER_BYTES + i * full;
        const to = Math.min(total, from + full);
        const c = Buffer.concat(await collect(store.getRange(objectKey, from, to)));
        yield decryptSegment(key, ids, i, i === count - 1, c);
      }
    }
    return { stream: Readable.from(plain()), createdAt: row.readyAt! };
  }

  /** Users whose grace period is over (job). */
  async finalizeDue(): Promise<number> {
    const due = await this.d.db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.status, "pending_deletion"),
          lte(users.deletionScheduledAt, new Date(this.d.now())),
        ),
      );
    let done = 0;
    for (const u of due) if (await this.each("finalize", () => this.finalize(u.id))) done++;
    return done;
  }

  /** One user's failure (an unreadable blob…) must not hold back everyone after them. */
  private async each(job: string, run: () => Promise<boolean | void>): Promise<boolean> {
    try {
      return (await run()) !== false;
    } catch (e) {
      this.d.log?.error({ job, code: failureCode(e) }, "user deletion step failed");
      return false;
    }
  }

  /**
   * With an export, the grace period runs from the delivery of its link: an email stuck in the
   * outbox (SMTP down or removed) postpones the deletion instead of destroying unseen data.
   */
  private async exportDeadline(userId: string): Promise<number | null | "waiting"> {
    const [e] = await this.d.db.select().from(userExports).where(eq(userExports.userId, userId));
    if (!e) return null;
    const sent = await this.d.outbox.sentAt(userId, "export_ready");
    if (!e.readyAt || !sent) return "waiting";
    return Math.max(e.expiresAt.getTime(), sent.getTime() + DELETION_GRACE_MS);
  }

  /**
   * Idempotent: every step can run again after a crash. The blobs go with the purge job.
   * Returns false when it is not time yet.
   */
  async finalize(userId: string): Promise<boolean> {
    const { db, vaults: vaultsSvc, store, hub, now } = this.d;
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (!u || u.status !== "pending_deletion") return false;
    if (u.deletionScheduledAt && u.deletionScheduledAt.getTime() > now()) return false;
    const deadline = await this.exportDeadline(u.id);
    if (deadline === "waiting") return false;
    if (deadline !== null && deadline > now()) {
      const at = new Date(deadline);
      await db.update(users).set({ deletionScheduledAt: at }).where(eq(users.id, u.id));
      await db.update(userExports).set({ expiresAt: at }).where(eq(userExports.userId, u.id));
      return false;
    }
    for (const v of await vaultsSvc.listForUser(u.id))
      await destroyVault(db, hub, vaultsSvc, v, now());
    for (const e of await db.select().from(userExports).where(eq(userExports.userId, u.id))) {
      await store.delete(storeKeyOf(e.id));
      await db.delete(userExports).where(eq(userExports.id, e.id));
    }
    const anon = `deleted-${u.id}`;
    await db.transaction(async (tx) => {
      await this.d.outbox.forgetUser(u.id, tx);
      await tx.delete(webSessions).where(eq(webSessions.userId, u.id));
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, u.id));
      await tx.delete(securityEvents).where(eq(securityEvents.userId, u.id));
      await tx.delete(oneTimeTokens).where(eq(oneTimeTokens.userId, u.id));
      await tx
        .update(users)
        .set({
          status: "deleted",
          username: anon,
          usernameKey: anon,
          email: `${anon}@invalid`,
          emailKey: `${anon}@invalid`,
          passwordHash: null,
          totpSecret: null,
          totpEnabledAt: null,
          totpLastStep: null,
          adminResetAt: null,
          quotaBytes: null,
          updatedAt: new Date(now()),
        })
        .where(eq(users.id, u.id));
    });
    return true;
  }
}

async function collect(it: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const p of it) out.push(Buffer.from(p));
  return out;
}
