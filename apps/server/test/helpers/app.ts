import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { pino } from "pino";
import { buildApp } from "../../src/app.js";
import { AuthService } from "../../src/auth/service.js";
import { VaultService } from "../../src/vaults/service.js";
import { CSRF_VALUE, SESSION_COOKIE } from "../../src/auth/http.js";
import { buildInfo } from "../../src/build-info.js";
import { ensureKeyCheck } from "../../src/crypto/key-check.js";
import { parseMasterKey } from "../../src/crypto/keyring.js";
import { createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createLogger } from "../../src/observability/logger.js";

export const kek = parseMasterKey(Buffer.alloc(32, 3).toString("base64"));

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  auth: AuthService;
  vaults: VaultService;
  clock: { now: number };
  /** JSON request with CSRF header and the cookie jar of `agent`. */
  call(agent: Agent, method: string, url: string, body?: unknown): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}
export type Agent = { cookie?: string | undefined };

export async function testApp(
  url: string,
  opts: { publicUrl?: string; log?: { write(line: string): void } } = {},
): Promise<TestApp> {
  const db = createDb(url);
  await runMigrations(db, async () => {
    await ensureKeyCheck(db, kek);
  });
  const clock = { now: Date.UTC(2026, 10, 9, 12) };
  const auth = new AuthService(db, kek, "Kamino", () => clock.now);
  const vaults = new VaultService(db, kek, () => clock.now);
  const app = await buildApp({
    config: {
      publicUrl: opts.publicUrl ?? "http://localhost:8080",
      port: 0,
      databaseUrl: url,
      masterKey: "",
      logLevel: "error",
      storage: { kind: "fs", dir: "/tmp/kamino-test-blobs" },
      stagingDir: "/tmp/kamino-test-staging",
      maxFileBytes: 1_000_000,
    },
    db,
    logger: opts.log ? createLogger("debug", opts.log) : pino({ level: "silent" }),
    buildInfo,
    kek,
    auth,
    vaults,
  });
  return {
    app,
    db,
    auth,
    vaults,
    clock,
    async call(agent, method, path, body) {
      const res = await app.inject({
        method: method as "GET",
        url: `/api/v1${path}`,
        headers: {
          "x-requested-with": CSRF_VALUE,
          ...(agent.cookie ? { cookie: agent.cookie } : {}),
          "user-agent": "Mozilla/5.0 (Macintosh) Firefox/131.0",
        },
        ...(body !== undefined ? { payload: body as object } : {}),
      });
      const set = res.cookies.find((c) => c.name === SESSION_COOKIE);
      if (set) agent.cookie = set.value ? `${SESSION_COOKIE}=${set.value}` : undefined;
      return res;
    },
    async close() {
      await app.close();
      await db.$client.end();
    },
  };
}
