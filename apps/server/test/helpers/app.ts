import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { pino } from "pino";
import { buildApp } from "../../src/app.js";
import { AuthService } from "../../src/auth/service.js";
import { VaultService } from "../../src/vaults/service.js";
import { FsBlobStore } from "../../src/blobs/fs-store.js";
import { UploadService } from "../../src/blobs/uploads.js";
import { SyncService } from "../../src/sync/commit.js";
import { Hub } from "../../src/realtime/hub.js";
import { QuotaService } from "../../src/quota/service.js";
import { SystemConfigService } from "../../src/system/config.js";
import { Outbox } from "../../src/email/outbox.js";
import type { Message } from "../../src/email/mailer.js";
import type { Config, SystemEnv } from "../../src/config/schema.js";
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
  config: SystemConfigService;
  quota: QuotaService;
  outbox: Outbox;
  /** Email "sent" by the fake SMTP transport (after `outbox.drain()`). */
  mail: Message[];
  /** A WebSocket client on /api/v1/ws. */
  ws(opts?: { autoPong?: boolean }): Promise<TestWs>;
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
    /** Upload chunk size (default 8 bytes: small files span several STREAM segments). */
    chunkSize?: number;
    /** Reuse the blob and staging folders of a previous app (a server restart); kept on close. */
    dirs?: { blobs: string; staging: string };
    /** System settings "from the environment" (locked in the admin UI). */
    system?: SystemEnv;
  } = {},
): Promise<TestApp> {
  const db = createDb(url);
  await runMigrations(db, async () => {
    await ensureKeyCheck(db, kek);
  });
  const clock = { now: Date.UTC(2026, 10, 9, 12) };
  const auth = new AuthService(db, kek, "Kamino", () => clock.now);
  const vaults = new VaultService(db, kek, () => clock.now);
  const root = opts.dirs ? null : mkdtempSync(join(tmpdir(), "kamino-app-"));
  const dirs = opts.dirs ?? { blobs: join(root!, "blobs"), staging: join(root!, "staging") };
  const blobStore = new FsBlobStore(dirs.blobs);
  const config: Config = {
    publicUrl: opts.publicUrl ?? "http://localhost:8080",
    port: 0,
    databaseUrl: url,
    masterKey: "",
    logLevel: "error",
    storage: { kind: "fs", dir: "/tmp/kamino-test-blobs" },
    stagingDir: "/tmp/kamino-test-staging",
    maxFileBytes: 1_000_000,
    ...(opts.system ? { system: opts.system } : {}),
  };
  const systemConfig = new SystemConfigService(db, config, kek, () => clock.now);
  const quota = new QuotaService(db, systemConfig, () => clock.now);
  // 8-byte chunks: small files already span several STREAM segments.
  const uploads = new UploadService(
    db,
    blobStore,
    dirs.staging,
    1_000_000,
    () => clock.now,
    opts.chunkSize ?? 8,
    (tx, vaultId, blobId, size) => quota.assertUpload(tx, vaultId, blobId, size),
  );
  const sync = new SyncService(db, () => clock.now);
  const hub = new Hub();
  const logger = opts.log ? createLogger("debug", opts.log) : pino({ level: "silent" });
  const mail: Message[] = [];
  const outbox = new Outbox(
    db,
    kek,
    systemConfig,
    () => ({ send: async (m) => void mail.push(m) }),
    () => clock.now,
    logger,
  );
  const app = await buildApp({
    config,
    db,
    logger,
    buildInfo,
    kek,
    auth,
    vaults,
    blobStore,
    uploads,
    sync,
    hub,
    systemConfig,
    quota,
    outbox,
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
    config: systemConfig,
    quota,
    outbox,
    mail,
    ws: (o) => openWs(app, o?.autoPong ?? true),
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
      if (root) rmSync(root, { recursive: true, force: true });
    },
  };
}
