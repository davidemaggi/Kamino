import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli/index.js";
import { ensureKeyCheck } from "../src/crypto/key-check.js";
import { generateMasterKey, parseMasterKey } from "../src/crypto/keyring.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";

async function run(argv: string[], env: Record<string, string> = {}) {
  let out = "";
  let err = "";
  const code = await main(argv, env, {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
  });
  return { code, out, err };
}

describe.skipIf(dockerUnavailable)("cli", () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startPostgres();
  });
  afterAll(async () => {
    await pg?.stop();
  });

  const envFor = (databaseUrl: string, key: string) => ({
    KAMINO_PUBLIC_URL: "http://localhost:8080",
    KAMINO_DATABASE_URL: databaseUrl,
    KAMINO_MASTER_KEY: key,
  });

  it("keys generate prints a key accepted by parseMasterKey", async () => {
    const r = await run(["keys", "generate"]);
    expect(r.code).toBe(0);
    expect(() => parseMasterKey(r.out)).not.toThrow();
    expect(r.err).toBe("");
  });

  it("keys verify: right key exits 0, wrong key exits 1 with stderr and no key leak", async () => {
    const url = await pg.createDatabase("cli_verify");
    const good = generateMasterKey();
    const db = createDb(url);
    try {
      await runMigrations(db);
      await ensureKeyCheck(db, parseMasterKey(good));
    } finally {
      await db.$client.end();
    }
    const ok = await run(["keys", "verify"], envFor(url, good));
    expect(ok.code).toBe(0);

    const bad = generateMasterKey();
    const ko = await run(["keys", "verify"], envFor(url, bad));
    expect(ko.code).toBe(1);
    expect(ko.err).toContain("master key does not match this database");
    expect(ko.err).not.toContain(bad);
    expect(ko.out).not.toContain(bad);
  });

  it("keys verify on an uninitialized database exits 1 and does not create the check", async () => {
    const url = await pg.createDatabase("cli_verify_empty");
    const key = generateMasterKey();
    const db = createDb(url);
    try {
      await runMigrations(db);
      const r = await run(["keys", "verify"], envFor(url, key));
      expect(r.code).toBe(1);
      expect(r.err).toContain("no key check found; start the server once to initialize it");
      const [n] = await db.$client<{ n: number }[]>`select count(*)::int as n from key_check`;
      expect(n?.n).toBe(0);
    } finally {
      await db.$client.end();
    }
  });

  it("keys verify with a malformed key exits 1 without echoing it", async () => {
    const hex = "cd".repeat(32);
    const r = await run(["keys", "verify"], envFor("postgres://x@127.0.0.1:1/x", hex));
    expect(r.code).toBe(1);
    expect(r.err).toContain("kamino keys generate");
    expect(r.err).not.toContain(hex);
  });

  it("migrate with an unreachable database exits 1 with a generic message", async () => {
    const r = await run(
      ["migrate"],
      envFor("postgres://user:secretpw@127.0.0.1:1/db", generateMasterKey()),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("could not reach the database");
    expect(r.err).not.toContain("secretpw");
    expect(r.err).not.toContain("127.0.0.1");
    expect(r.err).not.toContain("ECONNREFUSED");
  });

  it("keys verify with an unreachable database exits 1 with a generic message", async () => {
    const r = await run(
      ["keys", "verify"],
      envFor("postgres://user:secretpw@127.0.0.1:1/db", generateMasterKey()),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("could not reach the database");
    expect(r.err).not.toContain("no key check found");
    expect(r.err).not.toContain("secretpw");
    expect(r.out).not.toContain("secretpw");
  });

  it("migrate applies migrations", async () => {
    const url = await pg.createDatabase("cli_migrate");
    const r = await run(["migrate"], envFor(url, generateMasterKey()));
    expect(r.code).toBe(0);
    const db = createDb(url);
    try {
      const [t] = await db.$client<{ n: number }[]>`
        select count(*)::int as n from information_schema.tables where table_name = 'key_check'`;
      expect(t?.n).toBe(1);
    } finally {
      await db.$client.end();
    }
  });

  it("unknown commands exit 2 with usage", async () => {
    const r = await run(["nope"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Usage");
  });
});
