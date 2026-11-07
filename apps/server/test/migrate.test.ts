import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";

describe.skipIf(dockerUnavailable)("runMigrations", () => {
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
      const journal = JSON.parse(
        readFileSync(
          fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url)),
          "utf8",
        ),
      ) as { entries: unknown[] };
      const count = async (): Promise<{ total: number; hashes: number }> => {
        const [r] = await a.$client<{ total: number; hashes: number }[]>`
          select count(*)::int as total, count(distinct hash)::int as hashes
          from drizzle.__drizzle_migrations`;
        return r ?? { total: -1, hashes: -2 };
      };
      const first = await count();
      expect(first.total).toBe(journal.entries.length);
      expect(first.hashes).toBe(first.total);
      const [table] = await a.$client<{ n: number }[]>`
        select count(*)::int as n from information_schema.tables where table_name = 'key_check'`;
      expect(table?.n).toBe(1);
      // Re-running is a no-op.
      await runMigrations(a);
      expect(await count()).toEqual(first);
    } finally {
      await a.$client.end({ timeout: 1 });
      await b.$client.end({ timeout: 1 });
    }
  });
});
