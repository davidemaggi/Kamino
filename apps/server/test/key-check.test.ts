import { createCipheriv, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureKeyCheck, verifyKeyCheck } from "../src/crypto/key-check.js";
import {
  KEY_CHECK_PLAINTEXT,
  MasterKeyError,
  generateMasterKey,
  keyringOf,
  parseMasterKey,
} from "../src/crypto/keyring.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";

describe.skipIf(dockerUnavailable)("key check", () => {
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

  it("rotation (04 §5.2): the new key joins the old one, a stranger never does", async () => {
    const db = await freshDb("kc_rotate");
    try {
      const oldK = parseMasterKey(generateMasterKey());
      const newK = parseMasterKey(generateMasterKey());
      await ensureKeyCheck(db, oldK);
      // The new key alone: refused. With the old one as previous: the rotation starts.
      await expect(ensureKeyCheck(db, newK)).rejects.toThrow(MasterKeyError);
      expect(await ensureKeyCheck(db, keyringOf(newK, oldK))).toBe("rotating");
      expect(await ensureKeyCheck(db, keyringOf(newK, oldK))).toBe("rotating");
      expect(await verifyKeyCheck(db, keyringOf(newK, oldK))).toBe("verified");
      // Until the old check is retired, neither key alone is enough.
      await expect(ensureKeyCheck(db, newK)).rejects.toThrow(MasterKeyError);
      await expect(ensureKeyCheck(db, oldK)).rejects.toThrow(MasterKeyError);
      // A wrong previous key is refused.
      const other = parseMasterKey(generateMasterKey());
      await expect(ensureKeyCheck(db, keyringOf(newK, other))).rejects.toThrow(MasterKeyError);
      await db.$client`update key_check set retired_at = now() where kek_id = ${oldK.id}`;
      expect(await ensureKeyCheck(db, newK)).toBe("verified");
      // Only retired checks: nobody can claim the database.
      await db.$client`update key_check set retired_at = now()`;
      await expect(ensureKeyCheck(db, other)).rejects.toThrow(MasterKeyError);
      await expect(ensureKeyCheck(db, newK)).rejects.toThrow(MasterKeyError);
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

  it("two instances with DIFFERENT keys on an empty table: exactly one wins", async () => {
    const url = await pg.createDatabase("kc_race_diff");
    const a = createDb(url);
    const b = createDb(url);
    try {
      await runMigrations(a);
      const ka = parseMasterKey(generateMasterKey());
      const kb = parseMasterKey(generateMasterKey());
      const results = await Promise.allSettled([ensureKeyCheck(a, ka), ensureKeyCheck(b, kb)]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const ko = results.filter((r) => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(ko).toHaveLength(1);
      expect((ok[0] as PromiseFulfilledResult<string>).value).toBe("created");
      expect((ko[0] as PromiseRejectedResult).reason).toBeInstanceOf(MasterKeyError);
      const [n] = await a.$client<{ n: number }[]>`
        select count(*)::int as n from key_check where retired_at is null`;
      expect(n?.n).toBe(1);
    } finally {
      await a.$client.end();
      await b.$client.end();
    }
  });

  it("rejects when any active row belongs to a different key", async () => {
    const db = await freshDb("kc_two_active");
    try {
      const kek = parseMasterKey(generateMasterKey());
      await ensureKeyCheck(db, kek);
      await db.$client`insert into key_check (kek_id, check_value) values ('other', decode('00', 'hex'))`;
      await expect(ensureKeyCheck(db, kek)).rejects.toThrow(MasterKeyError);
      await expect(verifyKeyCheck(db, kek)).rejects.toThrow(MasterKeyError);
    } finally {
      await db.$client.end();
    }
  });

  it("GCM authentication: a flipped bit in tag or ciphertext is rejected", async () => {
    for (const offset of [12, 28]) {
      const db = await freshDb(`kc_flip_${offset}`);
      try {
        const kek = parseMasterKey(generateMasterKey());
        await ensureKeyCheck(db, kek);
        const [row] = await db.$client<{ v: Buffer }[]>`select check_value as v from key_check`;
        const blob = Buffer.from(row?.v ?? Buffer.alloc(0));
        expect(blob.length).toBeGreaterThan(28);
        blob[offset] = (blob[offset] ?? 0) ^ 1;
        await db.$client`update key_check set check_value = ${blob}`;
        await expect(ensureKeyCheck(db, kek)).rejects.toThrow(MasterKeyError);
      } finally {
        await db.$client.end();
      }
    }
  });

  it("GCM AAD: a check sealed with the same key but another AAD is rejected", async () => {
    const db = await freshDb("kc_aad");
    try {
      const kek = parseMasterKey(generateMasterKey());
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", kek.key, iv);
      c.setAAD(Buffer.from("not-the-kek-id"));
      const ct = Buffer.concat([c.update(KEY_CHECK_PLAINTEXT, "utf8"), c.final()]);
      const blob = Buffer.concat([iv, c.getAuthTag(), ct]);
      await db.$client`insert into key_check (kek_id, check_value) values (${kek.id}, ${blob})`;
      await expect(ensureKeyCheck(db, kek)).rejects.toThrow(MasterKeyError);
    } finally {
      await db.$client.end();
    }
  });

  it("verifyKeyCheck lets non-missing-table database errors through", async () => {
    const db = createDb("postgres://u:secretpw@127.0.0.1:1/x");
    try {
      const err: unknown = await verifyKeyCheck(db, parseMasterKey(generateMasterKey())).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeDefined();
      expect(err).not.toBeInstanceOf(MasterKeyError);
    } finally {
      await db.$client.end();
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
