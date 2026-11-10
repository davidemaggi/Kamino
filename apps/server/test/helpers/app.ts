import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { pino } from "pino";
import { buildApp } from "../../src/app.js";
import { AuthService } from "../../src/auth/service.js";
import { VaultService } from "../../src/vaults/service.js";
import { FsBlobStore } from "../../src/blobs/fs-store.js";
import { UploadService } from "../../src/blobs/uploads.js";
import { SyncService } from "../../src/sync/commit.js";
import { Hub } from "../../src/realtime/hub.js";
import { openWs, type TestWs } from "./ws.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  uploads: UploadService;
  sync: SyncService;
  hub: Hub;
  /** A WebSocket client on /api/v1/ws. */
  ws(): Promise<TestWs>;
  /** Temporary blob and staging directories (removed on close). */
  dirs: { blobs: string; staging: string };
  clock: { now: number };
  /** JSON request with CSRF header and the cookie jar of `agent`. */
  call(agent: Agent, method: string, url: string, body?: unknown): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}
export type Agent = { cookie?: string | undefined };

export async function testApp(
  url: string,
  opts: {
    publicUrl?: string;
    log?: { write(line: string): void };
    realtime?: { helloMs?: number; heartbeatMs?: number; listen?: boolean };
  } = {},
): Promise<TestApp> {
  const db = createDb(url);
  await runMigrations(db, async () => {
    await ensureKeyCheck(db, kek);
  });
  const clock = { now: Date.UTC(2026, 10, 9, 12) };
  const auth = new AuthService(db, kek, "Kamino", () => clock.now);
  const vaults = new VaultService(db, kek, () => clock.now);
  const root = mkdtempSync(join(tmpdir(), "kamino-app-"));
  const dirs = { blobs: join(root, "blobs"), staging: join(root, "staging") };
  const blobStore = new FsBlobStore(dirs.blobs);
  // 8-byte chunks: small files already span several STREAM segments.
  const uploads = new UploadService(db, blobStore, dirs.staging, 1_000_000, () => clock.now, 8);
  const sync = new SyncService(db, () => clock.now);
  const hub = new Hub();
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
    blobStore,
    uploads,
    sync,
    hub,
    realtime: { helloMs: 500, heartbeatMs: 30_000, ...opts.realtime },
    now: () => clock.now,
  });
  return {
    app,
    db,
    auth,
    vaults,
    uploads,
    sync,
    hub,
    ws: () => openWs(app),
    dirs,
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
      rmSync(root, { recursive: true, force: true });
    },
  };
}
