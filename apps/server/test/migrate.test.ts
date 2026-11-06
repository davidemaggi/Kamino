import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";

describe("runMigrations", () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startPostgres();
  });
  afterAll(async () => {
    await pg?.stop();
  });

  it("applies each migration exactly once when two instances start together", async () => {
    const url = await pg.createDatabase("migrate_race");
    const a = createDb(url);
    const b = createDb(url);
    try {
      await Promise.all([runMigrations(a), runMigrations(b)]);
      const rows = await a.$client<{ id: number }[]>`select id from drizzle.__drizzle_migrations`;
      expect(rows.length).toBeGreaterThan(0);
      // One row per migration file: no duplicates despite the race.
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
      const [table] = await a.$client<{ n: number }[]>`
        select count(*)::int as n from information_schema.tables where table_name = 'key_check'`;
      expect(table?.n).toBe(1);
      // Re-running is a no-op.
      await runMigrations(a);
      const again = await a.$client`select id from drizzle.__drizzle_migrations`;
      expect(again.length).toBe(rows.length);
    } finally {
      await a.$client.end({ timeout: 1 });
      await b.$client.end({ timeout: 1 });
    }
  });
});
