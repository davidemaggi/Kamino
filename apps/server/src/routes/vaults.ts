import type { Vault as VaultDto } from "@kamino/protocol";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth/http.js";
import type { Db } from "../db/client.js";
import { conflicts, devices, files, fileVersions } from "../db/schema.js";
import type { Vault, VaultService } from "../vaults/service.js";

type Level = VaultDto["level"];

/** Admin maximum for history retention until system settings arrive (M5). */
const MAX_RETENTION_DAYS = 90;

interface Stats {
  fileCount: number;
  deviceCount: number;
  conflicts: number;
  usedBytes: number;
  trashBytes: number;
  historyBytes: number;
  level: Level;
}

async function statsOf(db: Db, v: Vault): Promise<Stats> {
  const [sizes] = await db
    .select({
      live: sql<string>`coalesce(sum(case when ${files.deleted} = false then ${fileVersions.size} end), 0)`,
      trash: sql<string>`coalesce(sum(case when ${files.deleted} = true then ${fileVersions.size} end), 0)`,
      liveFiles: sql<string>`count(*) filter (where ${files.deleted} = false and ${files.kind} = 'file')`,
    })
    .from(files)
    .leftJoin(
      fileVersions,
      and(eq(fileVersions.vaultId, files.vaultId), eq(fileVersions.id, files.headVersionId)),
    )
    .where(eq(files.vaultId, v.id));
  const [all] = await db
    .select({ total: sql<string>`coalesce(sum(${fileVersions.size}), 0)` })
    .from(fileVersions)
    .where(eq(fileVersions.vaultId, v.id));
  const [open] = await db
    .select({ n: sql<string>`count(*)` })
    .from(conflicts)
    .where(and(eq(conflicts.vaultId, v.id), eq(conflicts.status, "open")));
  const devs = await db
    .select({
      cursor: devices.cursorSeq,
      error: devices.lastErrorCode,
      pending: devices.pendingOps,
      deferred: devices.deferredFiles,
      lastSync: devices.lastSyncAt,
      lastAck: devices.lastAckAt,
    })
    .from(devices)
    .where(and(eq(devices.vaultId, v.id), isNull(devices.revokedAt)));
  const usedBytes = Number(sizes?.live ?? 0);
  const trashBytes = Number(sizes?.trash ?? 0);
  const openConflicts = Number(open?.n ?? 0);
  // "Safe" only when every device has synced, caught up with the head and queued nothing
  // (packages/status: working.notLinked / neverSynced / queued).
  const working =
    devs.length === 0 ||
    devs.some(
      (d) =>
        d.cursor < v.headSeq ||
        d.pending > 0 ||
        d.deferred > 0 ||
        (d.lastSync === null && d.lastAck === null),
    );
  // Worst first: a decision to take, then attention, then work in progress.
  const level: Level =
    openConflicts > 0
      ? "decision"
      : devs.some((d) => d.error !== null)
        ? "attention"
        : working
          ? "working"
          : "safe";
  return {
    fileCount: Number(sizes?.liveFiles ?? 0),
    deviceCount: devs.length,
    conflicts: openConflicts,
    usedBytes,
    trashBytes,
    historyBytes: Math.max(0, Number(all?.total ?? 0) - usedBytes - trashBytes),
    level,
  };
}

/** C1: the minimum the web app needs from the real server (the rest of the user area is M4). */
export function vaultRoutes(db: Db, vaultsSvc: VaultService) {
  return async (app: FastifyInstance) => {
    app.get("/vaults", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const list = await vaultsSvc.listForUser(s.user.id);
      const vaults: VaultDto[] = [];
      for (const v of list) {
        const st = await statsOf(db, v);
        vaults.push({
          id: v.id,
          name: vaultsSvc.nameOf(v),
          fileCount: st.fileCount,
          deviceCount: st.deviceCount,
          level: st.level,
          conflicts: st.conflicts,
          usedBytes: st.usedBytes,
          historyBytes: st.historyBytes,
          trashBytes: st.trashBytes,
          retentionDays: Math.min(v.retentionDays, MAX_RETENTION_DAYS),
          maxRetentionDays: MAX_RETENTION_DAYS,
          historyFrom: v.createdAt.toISOString(),
        });
      }
      const usedBytes = vaults.reduce((n, v) => n + v.usedBytes + v.historyBytes + v.trashBytes, 0);
      // Quotas arrive with M5: no limit yet.
      return { vaults, quota: { usedBytes, limitBytes: null } };
    });

    app.get("/vaults/summary", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const list = await vaultsSvc.listForUser(s.user.id);
      const vaults = [];
      for (const v of list) {
        const st = await statsOf(db, v);
        vaults.push({
          id: v.id,
          name: vaultsSvc.nameOf(v),
          level: st.level,
          conflicts: st.conflicts,
        });
      }
      return { vaults };
    });
  };
}
