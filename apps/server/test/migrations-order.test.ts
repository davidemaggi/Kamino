import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureKeyCheck } from "../src/crypto/key-check.js";
import { MasterKeyError, parseMasterKey } from "../src/crypto/keyring.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";

const keyA = parseMasterKey(Buffer.alloc(32, 1).toString("base64"));
const keyB = parseMasterKey(Buffer.alloc(32, 2).toString("base64"));

describe.skipIf(dockerUnavailable)("migrations order (R16)", () => {
  let pg: TestPostgres;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => pg?.stop());

  async function tables(db: ReturnType<typeof createDb>): Promise<string[]> {
    const rows = await db.$client<
      { table_name: string }[]
    >`select table_name from information_schema.tables where table_schema = 'public'`;
    return rows.map((r) => r.table_name).sort();
  }

  it("verify runs after key_check exists and before application tables", async () => {
    const db = createDb(await pg.createDatabase("order_ok"));
    let seen: string[] = [];
    await runMigrations(db, async () => {
      seen = await tables(db);
      await ensureKeyCheck(db, keyA);
    });
    expect(seen).toEqual(["key_check"]);
    expect(await tables(db)).toContain("users");
    await db.$client.end();
  });

  it("a wrong key stops before any application migration; the right one proceeds", async () => {
    const db = createDb(await pg.createDatabase("order_wrong"));
    // A database initialised with key A that stopped right after the bootstrap migration.
    const stop = new Error("stop before application migrations");
    await expect(
      runMigrations(db, async () => {
        await ensureKeyCheck(db, keyA);
        throw stop;
      }),
    ).rejects.toBe(stop);
    expect(await tables(db)).toEqual(["key_check"]);
    await expect(
      runMigrations(db, async () => {
        await ensureKeyCheck(db, keyB);
      }),
    ).rejects.toBeInstanceOf(MasterKeyError);
    expect(await tables(db)).toEqual(["key_check"]);
    await runMigrations(db, async () => {
      await ensureKeyCheck(db, keyA);
    });
    expect(await tables(db)).toContain("users");
    await db.$client.end();
  });
});
