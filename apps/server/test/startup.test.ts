import { spawn } from "node:child_process";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureKeyCheck } from "../src/crypto/key-check.js";
import { generateMasterKey, parseMasterKey } from "../src/crypto/keyring.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";

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

describe("server startup", () => {
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
    const port = await freePort();
    const wrong = generateMasterKey();
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      env: {
        ...process.env,
        KAMINO_PUBLIC_URL: "http://localhost",
        KAMINO_PORT: String(port),
        KAMINO_DATABASE_URL: url,
        KAMINO_MASTER_KEY: wrong,
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
    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    expect(everConnected).toBe(false);
    expect(await canConnect(port)).toBe(false);
    expect(output).toContain("master key does not match this database");
    expect(output).not.toContain(wrong);
  }, 120_000);
});
