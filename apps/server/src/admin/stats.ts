import { and, count, eq, inArray, isNull, max, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { blobs, conflicts, devices, securityEvents, vaults } from "../db/schema.js";
import { deviceLevel, vaultLevel, type DeviceFacts, type Level } from "../devices/level.js";

/** Worst last: the level shown for a user is the worst of their vaults. */
export const LEVEL_ORDER: readonly Level[] = [
  "safe",
  "working",
  "attention",
  "decision",
  "blocked",
];
export const worst = (a: Level, b: Level): Level =>
  LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b;

export interface UserStats {
  usedBytes: number;
  vaultCount: number;
  deviceCount: number;
  syncLevel: Level;
  lastLoginAt: Date | null;
}

const deviceFacts = {
  cursor: devices.cursorSeq,
  error: devices.lastErrorCode,
  pending: devices.pendingOps,
  deferred: devices.deferredFiles,
  lastSync: devices.lastSyncAt,
  lastAck: devices.lastAckAt,
};
const facts = (d: Omit<DeviceFacts, "revoked">): DeviceFacts => ({ ...d, revoked: false });

/**
 * U-03: per-user aggregates from sizes, counters and states only. Nothing here reads a name, a
 * path or a key: vault and file names stay encrypted and are never decrypted by the admin module.
 */
export async function userStats(db: Db, ids: string[]): Promise<Map<string, UserStats>> {
  const out = new Map<string, UserStats>();
  if (ids.length === 0) return out;
  for (const id of ids)
    out.set(id, {
      usedBytes: 0,
      vaultCount: 0,
      deviceCount: 0,
      syncLevel: "safe",
      lastLoginAt: null,
    });
  const active = and(inArray(vaults.ownerId, ids), eq(vaults.status, "active"));
  const used = await db
    .select({ owner: vaults.ownerId, n: sql<string>`coalesce(sum(${blobs.size}), 0)` })
    .from(blobs)
    .innerJoin(vaults, eq(vaults.id, blobs.vaultId))
    .where(active)
    .groupBy(vaults.ownerId);
  for (const r of used) out.get(r.owner)!.usedBytes = Number(r.n);
  const vs = await db
    .select({ id: vaults.id, owner: vaults.ownerId, head: vaults.headSeq })
    .from(vaults)
    .where(active);
  const vids = vs.map((v) => v.id);
  const open = new Map<string, number>();
  const devs = new Map<string, DeviceFacts[]>();
  if (vids.length > 0) {
    for (const r of await db
      .select({ v: conflicts.vaultId, n: count() })
      .from(conflicts)
      .where(and(inArray(conflicts.vaultId, vids), eq(conflicts.status, "open")))
      .groupBy(conflicts.vaultId))
      open.set(r.v, r.n);
    for (const { vaultId, ...d } of await db
      .select({ ...deviceFacts, vaultId: devices.vaultId })
      .from(devices)
      .where(and(inArray(devices.vaultId, vids), isNull(devices.revokedAt))))
      devs.set(vaultId, [...(devs.get(vaultId) ?? []), facts(d)]);
  }
  for (const v of vs) {
    const s = out.get(v.owner)!;
    const ds = devs.get(v.id) ?? [];
    s.vaultCount++;
    s.deviceCount += ds.length;
    s.syncLevel = worst(s.syncLevel, vaultLevel(open.get(v.id) ?? 0, ds, v.head));
  }
  for (const r of await db
    .select({ u: securityEvents.userId, at: max(securityEvents.createdAt) })
    .from(securityEvents)
    .where(and(inArray(securityEvents.userId, ids), eq(securityEvents.type, "login")))
    .groupBy(securityEvents.userId))
    out.get(r.u)!.lastLoginAt = r.at;
  return out;
}

/** System totals for the health page: counts, stored bytes and devices by level. */
export async function systemTotals(db: Db): Promise<{
  vaults: number;
  devices: number;
  storageBytes: number;
  devicesByLevel: Record<Level, number>;
}> {
  const [st] = await db
    .select({ n: sql<string>`coalesce(sum(${blobs.storedSize}), 0)` })
    .from(blobs)
    .innerJoin(vaults, eq(vaults.id, blobs.vaultId))
    .where(eq(vaults.status, "active"));
  const rows = await db
    .select({ ...deviceFacts, head: vaults.headSeq })
    .from(devices)
    .innerJoin(vaults, eq(vaults.id, devices.vaultId))
    .where(and(eq(vaults.status, "active"), isNull(devices.revokedAt)));
  const [vc] = await db.select({ n: count() }).from(vaults).where(eq(vaults.status, "active"));
  const devicesByLevel = Object.fromEntries(LEVEL_ORDER.map((l) => [l, 0])) as Record<
    Level,
    number
  >;
  for (const { head, ...d } of rows) devicesByLevel[deviceLevel(facts(d), head)]++;
  return {
    vaults: vc?.n ?? 0,
    devices: rows.length,
    storageBytes: Number(st?.n ?? 0),
    devicesByLevel,
  };
}
