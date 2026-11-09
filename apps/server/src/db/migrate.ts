import { migrate } from "drizzle-orm/postgres-js/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./client.js";

export const MIGRATION_LOCK_ID = 7_243_650_066n;

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

interface Journal {
  entries: Array<{ idx: number; tag: string; when: number }>;
  [k: string]: unknown;
}

/** A copy of the migrations folder with only the first migration (key_check). */
function bootstrapFolder(): string {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"),
  ) as Journal;
  const first = journal.entries[0];
  if (!first) throw new Error("no migrations");
  const dir = mkdtempSync(join(tmpdir(), "kamino-migrations-"));
  mkdirSync(join(dir, "meta"));
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: [first] }));
  copyFileSync(join(migrationsFolder, `${first.tag}.sql`), join(dir, `${first.tag}.sql`));
  return dir;
}

/**
 * R16: the key_check migration runs first, then `verify` (master key check), then every other
 * migration, all under one advisory lock. A wrong key stops before any application table exists.
 * The original error is never masked by a failing unlock.
 */
export async function runMigrations(
  db: Db,
  verify: () => Promise<void> = async () => undefined,
): Promise<void> {
  const conn = await db.$client.reserve();
  let original: unknown;
  try {
    await conn`select pg_advisory_lock(${MIGRATION_LOCK_ID.toString()}::bigint)`;
    const bootstrap = bootstrapFolder();
    try {
      await migrate(db, { migrationsFolder: bootstrap });
    } finally {
      rmSync(bootstrap, { recursive: true, force: true });
    }
    await verify();
    await migrate(db, { migrationsFolder });
  } catch (e) {
    original = e;
  }
  let unlockError: unknown;
  try {
    await conn`select pg_advisory_unlock(${MIGRATION_LOCK_ID.toString()}::bigint)`;
  } catch (e) {
    unlockError = e;
  }
  conn.release();
  // The original error wins: a failing unlock never hides why the migrations stopped.
  if (original !== undefined) throw original;
  if (unlockError !== undefined) throw unlockError;
}
