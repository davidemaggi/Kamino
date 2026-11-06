import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import type { Db } from "./client.js";

/** Arbitrary constant key for the session-level advisory lock around migrations. */
export const MIGRATION_LOCK_ID = 7_243_650_066n;

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Applies pending migrations. Concurrent instances serialize on a Postgres advisory
 * lock held on one reserved connection for the whole run, so the loser waits and then
 * finds nothing to do. The lock is session-level and only acts as a mutex: the migrator
 * itself needs a pool connection (drizzle calls sql.begin, absent on reserved connections).
 */
export async function runMigrations(db: Db): Promise<void> {
  const conn = await db.$client.reserve();
  try {
    await conn`select pg_advisory_lock(${MIGRATION_LOCK_ID.toString()}::bigint)`;
    try {
      await migrate(db, { migrationsFolder });
    } finally {
      await conn`select pg_advisory_unlock(${MIGRATION_LOCK_ID.toString()}::bigint)`;
    }
  } finally {
    conn.release();
  }
}
