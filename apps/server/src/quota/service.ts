import { and, eq, gt, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { blobs, uploadSessions, users, vaults } from "../db/schema.js";
import { TransferError } from "../blobs/uploads.js";
import { ApiError } from "../http/errors.js";
import type { SystemConfigService } from "../system/config.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export const quotaExceeded = () => new ApiError("quota_exceeded", 413);

/**
 * Q-01..Q-03: what a user stores is the blobs of their active vaults (history and trash
 * included, H-03). Blobs are per vault, so the same content in two vaults is stored, and
 * counted, twice. Only new bytes are checked: deletes, renames and commits of content the
 * server already has never hit the quota.
 */
export class QuotaService {
  constructor(
    private readonly db: Db,
    private readonly config: SystemConfigService,
    private readonly now: () => number = Date.now,
  ) {}

  private async stored(userId: string, db: Db | Tx = this.db): Promise<number> {
    const [r] = await db
      .select({ n: sql<string>`coalesce(sum(${blobs.size}), 0)` })
      .from(blobs)
      .innerJoin(vaults, eq(vaults.id, blobs.vaultId))
      .where(and(eq(vaults.ownerId, userId), eq(vaults.status, "active")));
    return Number(r?.n ?? 0);
  }

  /** Open upload sessions hold their size until they complete or expire (03 §4). */
  private async reserved(userId: string, db: Db | Tx): Promise<number> {
    const [r] = await db
      .select({ n: sql<string>`coalesce(sum(${uploadSessions.size}), 0)` })
      .from(uploadSessions)
      .innerJoin(vaults, eq(vaults.id, uploadSessions.vaultId))
      .where(
        and(
          eq(vaults.ownerId, userId),
          eq(vaults.status, "active"),
          ne(uploadSessions.state, "done"),
          gt(uploadSessions.expiresAt, new Date(this.now())),
          sql`not exists (select 1 from ${blobs} where ${blobs.vaultId} = ${uploadSessions.vaultId} and ${blobs.blobId} = ${uploadSessions.blobId})`,
        ),
      );
    return Number(r?.n ?? 0);
  }

  private async limitOf(userId: string, db: Db | Tx = this.db): Promise<number | null> {
    const [u] = await db.select({ q: users.quotaBytes }).from(users).where(eq(users.id, userId));
    if (u?.q !== null && u?.q !== undefined) return u.q;
    return (await this.config.effective()).defaultQuotaBytes;
  }

  async usage(userId: string): Promise<{ usedBytes: number; limitBytes: number | null }> {
    return { usedBytes: await this.stored(userId), limitBytes: await this.limitOf(userId) };
  }

  /** Throws 413 quota_exceeded when `newBytes` don't fit; `tx` holds a per-user lock. */
  async assertRoom(userId: string, newBytes: number, tx?: Tx): Promise<void> {
    const run = async (t: Tx) => {
      await t.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`quota:${userId}`}, 0))`);
      const limit = await this.limitOf(userId, t);
      if (limit === null) return;
      const used = (await this.stored(userId, t)) + (await this.reserved(userId, t));
      if (used + newBytes > limit) throw quotaExceeded();
    };
    if (tx) await run(tx);
    else await this.db.transaction(run);
  }

  /**
   * The upload guard: the file size limit (E-03, may change from the UI) and the new bytes in
   * `vaultId` against its owner's quota, inside `tx`.
   */
  async assertUpload(tx: Tx, vaultId: string, blobId: string, size: number): Promise<void> {
    if (size > (await this.config.effective()).maxFileBytes)
      throw new TransferError("file_too_large", 413);
    const [v] = await tx
      .select({ ownerId: vaults.ownerId })
      .from(vaults)
      .where(eq(vaults.id, vaultId));
    if (!v) return;
    const [have] = await tx
      .select({ blobId: blobs.blobId })
      .from(blobs)
      .where(and(eq(blobs.vaultId, vaultId), eq(blobs.blobId, blobId)));
    if (have) return; // already stored: not new bytes
    await this.assertRoom(v.ownerId, size, tx);
  }
}
