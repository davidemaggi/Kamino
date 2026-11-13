import { and, eq, inArray, isNotNull, lt, notExists, or, sql } from "drizzle-orm";
import { blobKeyOf } from "../blobs/uploads.js";
import type { BlobStore } from "../blobs/store.js";
import type { Db } from "../db/client.js";
import {
  blobs,
  conflictCandidates,
  conflicts,
  files,
  fileVersions,
  uploadSessions,
  vaults,
} from "../db/schema.js";
import { TRASH_MIN_DAYS } from "../history/service.js";

const DAY_MS = 86_400_000;
/** A blob nobody references yet may be about to be: a device uploads first and commits after. */
export const BLOB_GRACE_MS = 24 * 3_600_000;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Versions an open conflict still needs: its base, the head it opened on, its candidates. */
async function pinned(tx: Tx, vaultId: string): Promise<Set<string>> {
  const open = await tx
    .select({ id: conflicts.id, base: conflicts.baseVersionId, head: conflicts.headVersionId })
    .from(conflicts)
    .where(and(eq(conflicts.vaultId, vaultId), eq(conflicts.status, "open")));
  const out = new Set<string>();
  for (const c of open) {
    out.add(c.head);
    if (c.base) out.add(c.base);
  }
  if (open.length > 0) {
    const cands = await tx
      .select({ v: conflictCandidates.versionId })
      .from(conflictCandidates)
      .where(
        and(
          eq(conflictCandidates.vaultId, vaultId),
          inArray(
            conflictCandidates.conflictId,
            open.map((c) => c.id),
          ),
        ),
      );
    for (const c of cands) out.add(c.v);
  }
  return out;
}

/**
 * H-02/H-03 (03 §14): drops what the history window no longer covers, one vault at a time under
 * the same lock as commits.
 * - Old versions that are not current, beyond the vault's retention (capped by the system
 *   maximum), except those an open conflict needs.
 * - Files in the trash for more than max(7, retention) days, with all their versions, unless a
 *   conflict on them is still open. A device that edits one later just creates it again.
 * Then the blobs nothing references any more (see `collectBlobs`).
 */
export async function applyRetention(
  db: Db,
  store: BlobStore,
  now: number,
  maxRetentionDays = Infinity,
): Promise<{ versions: number; files: number; blobs: number }> {
  const list = await db.select({ id: vaults.id }).from(vaults).where(eq(vaults.status, "active"));
  let versions = 0;
  let removedFiles = 0;
  for (const { id } of list) {
    const r = await db.transaction(async (tx) => {
      const [v] = await tx
        .select({ retentionDays: vaults.retentionDays, status: vaults.status })
        .from(vaults)
        .where(eq(vaults.id, id))
        .for("update");
      if (!v || v.status !== "active") return { versions: 0, files: 0 };
      const days = Math.min(v.retentionDays, maxRetentionDays);
      const keep = await pinned(tx, id);

      // Trash first: its files' current versions go too.
      const trashCut = new Date(now - Math.max(TRASH_MIN_DAYS, days) * DAY_MS);
      const expired = await tx
        .select({ id: files.id })
        .from(files)
        .where(
          and(
            eq(files.vaultId, id),
            eq(files.deleted, true),
            isNotNull(files.deletedAt),
            lt(files.deletedAt, trashCut),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(conflicts)
                .where(
                  and(
                    eq(conflicts.vaultId, id),
                    eq(conflicts.fileId, files.id),
                    eq(conflicts.status, "open"),
                  ),
                ),
            ),
          ),
        );
      let gone = 0;
      for (const f of expired) {
        const vs = await tx
          .delete(fileVersions)
          .where(and(eq(fileVersions.vaultId, id), eq(fileVersions.fileId, f.id)))
          .returning({ id: fileVersions.id });
        gone += vs.length;
        await tx.delete(files).where(and(eq(files.vaultId, id), eq(files.id, f.id)));
      }

      const cut = new Date(now - days * DAY_MS);
      const old = await tx
        .select({ id: fileVersions.id })
        .from(fileVersions)
        .where(
          and(
            eq(fileVersions.vaultId, id),
            lt(fileVersions.createdAt, cut),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(files)
                .where(and(eq(files.vaultId, id), eq(files.headVersionId, fileVersions.id))),
            ),
          ),
        );
      const drop = old.map((o) => o.id).filter((x) => !keep.has(x));
      for (let i = 0; i < drop.length; i += 500) {
        const chunk = drop.slice(i, i + 500);
        await tx
          .delete(fileVersions)
          .where(and(eq(fileVersions.vaultId, id), inArray(fileVersions.id, chunk)));
        // Candidates of closed conflicts pointing at them: nothing reads them any more.
        await tx
          .delete(conflictCandidates)
          .where(
            and(eq(conflictCandidates.vaultId, id), inArray(conflictCandidates.versionId, chunk)),
          );
      }
      return { versions: gone + drop.length, files: expired.length };
    });
    versions += r.versions;
    removedFiles += r.files;
  }
  const collected = await collectBlobs(db, store, now);
  return { versions, files: removedFiles, blobs: collected };
}

/**
 * Blobs no version references, with no open upload session, older than the grace period. The
 * row goes first (under the vault lock, so no commit can start using it meanwhile), then the
 * object, only if no new row for the same content appeared: a crash in between leaves an
 * unreferenced object (wasted space), never a version whose content is missing. The quota
 * follows by itself: it is the sum of the blob rows.
 */
export async function collectBlobs(db: Db, store: BlobStore, now: number): Promise<number> {
  const graceCut = new Date(now - BLOB_GRACE_MS);
  const unreferenced = (tx: Db | Tx, only?: { vaultId: string; blobId: string }) =>
    tx
      .select({ vaultId: blobs.vaultId, blobId: blobs.blobId })
      .from(blobs)
      .innerJoin(vaults, eq(vaults.id, blobs.vaultId))
      .where(
        and(
          eq(vaults.status, "active"),
          lt(blobs.createdAt, graceCut),
          only ? and(eq(blobs.vaultId, only.vaultId), eq(blobs.blobId, only.blobId)) : undefined,
          notExists(
            tx
              .select({ one: sql`1` })
              .from(fileVersions)
              .where(
                and(eq(fileVersions.vaultId, blobs.vaultId), eq(fileVersions.blobId, blobs.blobId)),
              ),
          ),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(uploadSessions)
              .where(
                and(
                  eq(uploadSessions.vaultId, blobs.vaultId),
                  eq(uploadSessions.blobId, blobs.blobId),
                  or(
                    sql`${uploadSessions.state} <> 'done'`,
                    sql`${uploadSessions.expiresAt} > ${new Date(now).toISOString()}::timestamptz`,
                  ),
                ),
              ),
          ),
        ),
      );
  const candidates = await unreferenced(db);
  let n = 0;
  for (const b of candidates) {
    const key = blobKeyOf(b.vaultId, b.blobId);
    const removed = await db.transaction(async (tx) => {
      const [v] = await tx
        .select({ status: vaults.status })
        .from(vaults)
        .where(eq(vaults.id, b.vaultId))
        .for("update");
      if (v?.status !== "active") return false;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      // Checked again under the locks: a commit may have started using it.
      const still = await unreferenced(tx, b);
      if (still.length === 0) return false;
      await tx.delete(blobs).where(and(eq(blobs.vaultId, b.vaultId), eq(blobs.blobId, b.blobId)));
      return true;
    });
    if (!removed) continue;
    await db.transaction(async (tx) => {
      // Same lock as an upload's `complete`: it either stored the content again (row back, keep
      // the object) or will see no row and write the object anew.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      const [again] = await tx
        .select({ blobId: blobs.blobId })
        .from(blobs)
        .where(and(eq(blobs.vaultId, b.vaultId), eq(blobs.blobId, b.blobId)));
      if (!again) await store.delete(key);
    });
    n++;
  }
  return n;
}
