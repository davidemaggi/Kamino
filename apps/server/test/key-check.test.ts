import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureKeyCheck, verifyKeyCheck } from "../src/crypto/key-check.js";
import { MasterKeyError, generateMasterKey, parseMasterKey } from "../src/crypto/keyring.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";

describe("key check", () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startPostgres();
  });
  afterAll(async () => {
    await pg?.stop();
  });

  async function freshDb(name: string) {
    const db = createDb(await pg.createDatabase(name));
    await runMigrations(db);
    return db;
  }

  it("creates, then verifies with the same key, then rejects another key", async () => {
    const db = await freshDb("kc_basic");
    try {
      const kek = parseMasterKey(generateMasterKey());
      expect(await ensureKeyCheck(db, kek)).toBe("created");
      expect(await ensureKeyCheck(db, kek)).toBe("verified");
      const other = parseMasterKey(generateMasterKey());
      await expect(ensureKeyCheck(db, other)).rejects.toThrow(MasterKeyError);
      await expect(ensureKeyCheck(db, other)).rejects.toThrow(
        "master key does not match this database",
      );
    } finally {
      await db.$client.end();
    }
  });

  it("rejects a tampered check value even when the kek id matches", async () => {
    const db = await freshDb("kc_tamper");
    try {
      const kek = parseMasterKey(generateMasterKey());
      await ensureKeyCheck(db, kek);
      await db.$client`update key_check set check_value = decode('00', 'hex')`;
      await expect(ensureKeyCheck(db, kek)).rejects.toThrow(MasterKeyError);
    } finally {
      await db.$client.end();
    }
  });

  it("is race-safe: two instances on an empty table both succeed with one row", async () => {
    const url = await pg.createDatabase("kc_race");
    const a = createDb(url);
    const b = createDb(url);
    try {
      await runMigrations(a);
      const kek = parseMasterKey(generateMasterKey());
      const results = await Promise.all([ensureKeyCheck(a, kek), ensureKeyCheck(b, kek)]);
      expect(results).toContain("created");
      expect(results.filter((r) => r === "created")).toHaveLength(1);
      const [n] = await a.$client<{ n: number }[]>`select count(*)::int as n from key_check`;
      expect(n?.n).toBe(1);
    } finally {
      await a.$client.end();
      await b.$client.end();
    }
  });

  it("verifyKeyCheck is read-only and reports a missing check", async () => {
    const db = await freshDb("kc_readonly");
    try {
      const kek = parseMasterKey(generateMasterKey());
      await expect(verifyKeyCheck(db, kek)).rejects.toThrow("no key check found");
      const [n] = await db.$client<{ n: number }[]>`select count(*)::int as n from key_check`;
      expect(n?.n).toBe(0);
      await ensureKeyCheck(db, kek);
      expect(await verifyKeyCheck(db, kek)).toBe("verified");
    } finally {
      await db.$client.end();
    }
  });

  it("verifyKeyCheck reports a missing table (no migrations)", async () => {
    const db = createDb(await pg.createDatabase("kc_notable"));
    try {
      await expect(verifyKeyCheck(db, parseMasterKey(generateMasterKey()))).rejects.toThrow(
        "no key check found",
      );
    } finally {
      await db.$client.end();
    }
  });
});
