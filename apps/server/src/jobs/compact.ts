import { and, eq, gt, isNull, lte, max, min, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { devices, journal, vaults } from "../db/schema.js";

/** 03 §6.3: devices not seen for this long no longer hold the journal back. */
export const INACTIVE_DEVICE_MS = 90 * 86_400_000;
const DAY_MS = 86_400_000;

/**
 * Removes journal entries that every active device has already acknowledged and that are older
 * than the vault's history retention. The removed prefix is recorded as `journal_floor`: a cursor
 * below it gets `cursor_too_old` and starts again from the snapshot.
 */
export async function compactJournal(
  db: Db,
  now: number,
  /** The system ceiling (E-03): a lowered maximum applies to vaults set above it. */
  maxRetentionDays = Infinity,
): Promise<{ vaults: number; deleted: number }> {
  const list = await db.select({ id: vaults.id }).from(vaults).where(eq(vaults.status, "active"));
  let deleted = 0;
  for (const { id } of list) {
    deleted += await db.transaction(async (tx) => {
      // Same lock as commits: the head and the floor move consistently.
      const [v] = await tx
        .select({
          head: vaults.headSeq,
          floor: vaults.journalFloor,
          retentionDays: vaults.retentionDays,
        })
        .from(vaults)
        .where(eq(vaults.id, id))
        .for("update");
      if (!v) return 0;
      const activeSince = new Date(now - INACTIVE_DEVICE_MS);
      const [cur] = await tx
        .select({ min: min(devices.cursorSeq) })
        .from(devices)
        .where(
          and(
            eq(devices.vaultId, id),
            isNull(devices.revokedAt),
            sql`coalesce(${devices.lastSeenAt}, ${devices.createdAt}) > ${activeSince.toISOString()}::timestamptz`,
          ),
        );
      const [old] = await tx
        .select({ max: max(journal.seq) })
        .from(journal)
        .where(
          and(
            eq(journal.vaultId, id),
            lte(journal.at, new Date(now - Math.min(v.retentionDays, maxRetentionDays) * DAY_MS)),
          ),
        );
      const minCursor = cur?.min === null || cur?.min === undefined ? v.head : Number(cur.min);
      const cut = Math.min(minCursor, Number(old?.max ?? 0));
      if (cut <= v.floor) return 0;
      const gone = await tx
        .delete(journal)
        .where(and(eq(journal.vaultId, id), gt(journal.seq, v.floor), lte(journal.seq, cut)))
        .returning({ seq: journal.seq, at: journal.at });
      const floorAt = gone.reduce<Date | null>((m, g) => (m && m >= g.at ? m : g.at), null);
      await tx
        .update(vaults)
        .set({ journalFloor: cut, ...(floorAt ? { journalFloorAt: floorAt } : {}) })
        .where(eq(vaults.id, id));
      return gone.length;
    });
  }
  return { vaults: list.length, deleted };
}
