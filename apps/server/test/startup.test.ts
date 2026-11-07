import { spawn } from "node:child_process";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureKeyCheck } from "../src/crypto/key-check.js";
import { generateMasterKey, parseMasterKey } from "../src/crypto/keyring.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

/** Minimal environment: no inherited KAMINO_* variables can change behaviour. */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
  ]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

async function runServer(
  port: number,
  vars: Record<string, string>,
): Promise<{ code: number | null; everConnected: boolean; output: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    env: {
      ...baseEnv(),
      KAMINO_PUBLIC_URL: "http://localhost",
      KAMINO_PORT: String(port),
      ...vars,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr.on("data", (d: Buffer) => (output += d.toString()));
  let exited = false;
  const exit = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => {
      exited = true;
      resolve(code);
    }),
  );
  let everConnected = false;
  while (!exited) {
    if (await canConnect(port)) everConnected = true;
    await new Promise((r) => setTimeout(r, 50));
  }
  const code = await exit;
  if (await canConnect(port)) everConnected = true;
  return { code, everConnected, output };
}

describe.skipIf(dockerUnavailable)("server startup", () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startPostgres();
  });
  afterAll(async () => {
    await pg?.stop();
  });

  it("exits non-zero without ever opening the port when the master key is wrong", async () => {
    const url = await pg.createDatabase("startup_wrong_key");
    const db = createDb(url);
    try {
      await runMigrations(db);
      await ensureKeyCheck(db, parseMasterKey(generateMasterKey()));
    } finally {
      await db.$client.end();
    }
    const wrong = generateMasterKey();
    const r = await runServer(await freePort(), {
      KAMINO_DATABASE_URL: url,
      KAMINO_MASTER_KEY: wrong,
    });
    expect(r.code).not.toBeNull();
    expect(r.code).not.toBe(0);
    expect(r.everConnected).toBe(false);
    expect(r.output).toContain("master key does not match this database");
    expect(r.output).not.toContain(wrong);
  }, 120_000);

  it("exits non-zero before any database connection when the master key is malformed", async () => {
    const hex = "ef".repeat(32);
    // Port 1 is unreachable: a DB connection attempt would surface a different error.
    const r = await runServer(await freePort(), {
      KAMINO_DATABASE_URL: "postgres://user:secretpw@127.0.0.1:1/db",
      KAMINO_MASTER_KEY: hex,
    });
    expect(r.code).not.toBeNull();
    expect(r.code).not.toBe(0);
    expect(r.everConnected).toBe(false);
    expect(r.output).toContain("base64");
    expect(r.output).not.toContain(hex);
    expect(r.output).not.toContain("secretpw");
    expect(r.output).not.toMatch(/ECONNREFUSED/);
  }, 120_000);
});
