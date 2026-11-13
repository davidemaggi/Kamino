import { AuditAction, type AuditPage, type HealthCheck, type SystemHealth } from "@kamino/protocol";
import { count, desc, inArray, ne, sql } from "drizzle-orm";
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { SYSTEM_PREFIX, type BlobStore } from "../blobs/store.js";
import type { BuildInfo } from "../build-info.js";
import type { Db } from "../db/client.js";
import { auditLog, users } from "../db/schema.js";
import type { SystemConfigService } from "../system/config.js";
import { systemTotals } from "./stats.js";

const TIMEOUT_MS = 2000;
export const DISK_WARN = 0.85;
export const DISK_ERROR = 0.95;
export const QUEUE_WARN = 100;
export const AUDIT_PAGE = 20;

async function within<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Used ratio of the filesystem holding `dir` (or its nearest existing parent). */
async function diskRatio(dir: string): Promise<number> {
  for (let d = dir; ; d = dirname(d)) {
    try {
      const s = await statfs(d);
      return s.blocks > 0 ? 1 - s.bavail / s.blocks : 0;
    } catch (e) {
      if (dirname(d) === d) throw e;
    }
  }
}

export interface HealthDeps {
  db: Db;
  store: BlobStore;
  config: SystemConfigService;
  buildInfo: BuildInfo;
  /** The blob directory for the disk check (fs storage only). */
  diskDir: string | null;
  startedAt: number;
  now: () => number;
}

/** E-05: state of the parts the admin can act on, plus system-wide counts (never names). */
export async function systemHealth(d: HealthDeps): Promise<SystemHealth> {
  const check = async (
    name: HealthCheck["name"],
    run: () => Promise<Omit<HealthCheck, "name">>,
  ): Promise<HealthCheck> => {
    try {
      return { name, ...(await within(run())) };
    } catch {
      return { name, status: "error" };
    }
  };
  const checks = await Promise.all([
    check("database", async () => {
      await d.db.execute(sql`select 1`);
      return { status: "ok" };
    }),
    check("storage", async () => {
      await d.store.size(`${SYSTEM_PREFIX}/0`);
      return { status: "ok" };
    }),
    ...(d.diskDir === null
      ? []
      : [
          check("disk", async () => {
            const value = await diskRatio(d.diskDir!);
            return {
              status: value >= DISK_ERROR ? "error" : value >= DISK_WARN ? "warn" : "ok",
              value,
            };
          }),
        ]),
    check("jobs", async () => {
      const r = await d.db.execute<{ n: number | null }>(
        sql`select case when to_regclass('pgboss.job') is null then null else (select count(*)::int from pgboss.job where state in ('created', 'retry')) end as n`,
      );
      const n = r[0]?.n ?? null;
      if (n === null) return { status: "off" };
      return { status: n >= QUEUE_WARN ? "warn" : "ok", value: n };
    }),
    check("smtp", async () => ({ status: (await d.config.smtp()) ? "ok" : "off" })),
  ]);
  const db = checks[0]!;
  const status =
    db.status === "error"
      ? "down"
      : checks.some((c) => c.status === "error" || c.status === "warn")
        ? "degraded"
        : "ok";
  const [uc] = await d.db.select({ n: count() }).from(users).where(ne(users.status, "deleted"));
  return {
    status,
    version: d.buildInfo.version,
    codename: d.buildInfo.codename,
    uptimeSeconds: Math.max(0, Math.floor((d.now() - d.startedAt) / 1000)),
    checks,
    totals: { users: uc?.n ?? 0, ...(await systemTotals(d.db)) },
  };
}

/** E-06: newest first, 20 per page; only the actions the UI knows (setup and CLI ones stay in the DB). */
export async function auditPage(db: Db, requested: number): Promise<AuditPage> {
  const known = inArray(auditLog.action, AuditAction.options);
  const [c] = await db.select({ n: count() }).from(auditLog).where(known);
  const pages = Math.max(1, Math.ceil((c?.n ?? 0) / AUDIT_PAGE));
  const page = Math.min(pages, Math.max(1, Number.isInteger(requested) ? requested : 1));
  const rows = await db
    .select()
    .from(auditLog)
    .where(known)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(AUDIT_PAGE)
    .offset((page - 1) * AUDIT_PAGE);
  return {
    items: rows.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      actor: r.actor,
      action: AuditAction.parse(r.action),
      target: r.target ?? "",
    })),
    page,
    pages,
  };
}
