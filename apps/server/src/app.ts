import { PRODUCT_NAME } from "@kamino/brand";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { registerAuthHttp } from "./auth/http.js";
import { pairingKey, PairingService } from "./pairing/service.js";
import { pairingRoutes } from "./routes/pairing.js";
import { AuthService } from "./auth/service.js";
import type { BuildInfo } from "./build-info.js";
import type { Config } from "./config/schema.js";
import type { Kek } from "./crypto/keyring.js";
import type { Db } from "./db/client.js";
import type { Logger } from "./observability/logger.js";
import { accountRoutes } from "./routes/account.js";
import { authRoutes } from "./routes/auth.js";
import { enrollRoutes } from "./routes/enroll.js";
import { transferRoutes } from "./routes/transfer.js";
import { syncRoutes } from "./routes/sync.js";
import { vaultRoutes } from "./routes/vaults.js";
import { userAreaRoutes } from "./routes/user-area.js";
import { SyncService } from "./sync/commit.js";
import { Hub } from "./realtime/hub.js";
import { keepListening } from "./realtime/listener.js";
import { wsRoutes } from "./routes/ws.js";
import { deviceRoutes } from "./routes/devices.js";
import { DeviceService } from "./devices/service.js";
import { settingsRoutes } from "./routes/settings.js";
import { SettingsService } from "./vaults/settings.js";
import { createBlobStore, type BlobStore } from "./blobs/store.js";
import { UploadService } from "./blobs/uploads.js";
import { VaultService } from "./vaults/service.js";
import { healthRoutes } from "./routes/health.js";
import { versionRoutes } from "./routes/version.js";
import { webRoutes } from "./web.js";
import { securityHeaders } from "./http/security.js";
import { SystemConfigService } from "./system/config.js";
import { QuotaService } from "./quota/service.js";
import { Outbox } from "./email/outbox.js";
import { smtpTransport } from "./email/mailer.js";
import { AdminUsers } from "./admin/users.js";
import { adminRoutes } from "./routes/admin.js";
import { exportRoutes } from "./routes/exports.js";
import { UserDeletion } from "./users/deletion.js";

export type AppDeps = {
  config: Config;
  db: Db;
  logger: Logger;
  buildInfo: BuildInfo;
  kek: Kek;
  /** Injected by tests (fake clock); built from db + kek otherwise. */
  auth?: AuthService | undefined;
  vaults?: VaultService | undefined;
  blobStore?: BlobStore | undefined;
  uploads?: UploadService | undefined;
  sync?: SyncService | undefined;
  hub?: Hub | undefined;
  systemConfig?: SystemConfigService | undefined;
  outbox?: Outbox | undefined;
  quota?: QuotaService | undefined;
  deletion?: UserDeletion | undefined;
  /** WebSocket timings (tests shorten them); `listen: false` skips the LISTEN connection. */
  realtime?: { helloMs?: number; heartbeatMs?: number; listen?: boolean } | undefined;
  /** Application clock (tests inject a fake one). */
  now?: (() => number) | undefined;
  /** Directory with the web build; when absent or missing, no static routes are served. */
  webRoot?: string | undefined;
};

declare module "fastify" {
  interface FastifyInstance {
    routeList: { method: string; url: string }[];
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // Widen pino's Logger so the instance type stays the default FastifyInstance.
  const loggerInstance: FastifyBaseLogger = deps.logger;
  // trustProxy only when configured: otherwise X-Forwarded-For is ignored (rate limits key on the peer).
  const tp = deps.config.trustProxy;
  const app = Fastify({
    loggerInstance,
    // Only configured proxies are trusted: otherwise X-Forwarded-For is ignored (rate limits key on the peer).
    trustProxy:
      tp === undefined
        ? false
        : typeof tp === "number"
          ? (_addr: string, hop: number) => hop < tp
          : tp,
  });
  securityHeaders(app, deps.config.publicUrl);
  // M7a A3: every registered route, so the authorization matrix test can't miss a new one.
  const routes: { method: string; url: string }[] = [];
  app.addHook("onRoute", (r) => {
    for (const m of [r.method].flat()) if (m !== "HEAD") routes.push({ method: m, url: r.url });
  });
  app.decorate("routeList", routes);
  const auth = deps.auth ?? new AuthService(deps.db, deps.kek, PRODUCT_NAME);
  await registerAuthHttp(app, auth);
  const systemConfig =
    deps.systemConfig ?? new SystemConfigService(deps.db, deps.config, deps.kek, deps.now);
  const quota = deps.quota ?? new QuotaService(deps.db, systemConfig, deps.now);
  const now = deps.now ?? Date.now;
  const outbox =
    deps.outbox ?? new Outbox(deps.db, deps.kek, systemConfig, smtpTransport, now, deps.logger);
  const secure = deps.config.publicUrl.startsWith("https:");
  await app.register(
    authRoutes(auth, secure, { outbox, config: systemConfig, publicUrl: deps.config.publicUrl }),
    { prefix: "/api/v1" },
  );
  await app.register(accountRoutes(auth), { prefix: "/api/v1" });
  const vaultsSvc = deps.vaults ?? new VaultService(deps.db, deps.kek);
  const hub = deps.hub ?? new Hub();
  const devicesSvc = new DeviceService(deps.db, vaultsSvc, hub, deps.now ?? Date.now);
  await app.register(enrollRoutes(deps.db, auth, vaultsSvc, devicesSvc), { prefix: "/api/v1" });
  await app.register(deviceRoutes(deps.db, devicesSvc), { prefix: "/api/v1" });
  const settings = new SettingsService(deps.db, vaultsSvc, deps.now ?? Date.now);
  await app.register(settingsRoutes(deps.db, settings), { prefix: "/api/v1" });
  const blobStore = deps.blobStore ?? createBlobStore(deps.config.storage);
  const uploads =
    deps.uploads ??
    new UploadService(
      deps.db,
      blobStore,
      deps.config.stagingDir,
      null,
      deps.now,
      undefined,
      (tx, vaultId, blobId, size) => quota.assertUpload(tx, vaultId, blobId, size),
    );
  await app.register(transferRoutes(deps.db, vaultsSvc, uploads, blobStore), { prefix: "/api/v1" });
  const sync = deps.sync ?? new SyncService(deps.db);
  await app.register(syncRoutes(deps.db, vaultsSvc, sync), { prefix: "/api/v1" });
  await app.register(vaultRoutes(deps.db, vaultsSvc, quota, systemConfig), { prefix: "/api/v1" });
  await app.register(
    userAreaRoutes({
      db: deps.db,
      vaults: vaultsSvc,
      store: blobStore,
      hub,
      config: systemConfig,
      sync,
      uploads,
      now: deps.now ?? Date.now,
    }),
    { prefix: "/api/v1" },
  );
  const startedAt = now();
  const deletion =
    deps.deletion ??
    new UserDeletion({
      db: deps.db,
      kek: deps.kek,
      auth,
      vaults: vaultsSvc,
      store: blobStore,
      hub,
      config: systemConfig,
      outbox,
      publicUrl: deps.config.publicUrl,
      now,
      log: deps.logger,
    });
  await app.register(exportRoutes(deletion, now), { prefix: "/api/v1" });
  await app.register(
    pairingRoutes({
      db: deps.db,
      vaults: vaultsSvc,
      pairing: new PairingService(
        deps.db,
        vaultsSvc,
        hub,
        outbox,
        deps.config.publicUrl,
        pairingKey(deps.kek),
        now,
      ),
      now,
    }),
    { prefix: "/api/v1" },
  );
  await app.register(
    adminRoutes({
      users: new AdminUsers(deps.db, auth, hub, systemConfig, outbox, deps.config.publicUrl, now),
      auth,
      config: systemConfig,
      outbox,
      health: {
        db: deps.db,
        store: blobStore,
        config: systemConfig,
        buildInfo: deps.buildInfo,
        diskDir: deps.config.storage.kind === "fs" ? deps.config.storage.dir : null,
        startedAt,
        now,
      },
      deletion,
    }),
    { prefix: "/api/v1" },
  );
  // Spec §5: frames above 64 KB close the socket.
  await app.register(websocket, { options: { maxPayload: 65_536 } });
  await app.register(
    wsRoutes({
      db: deps.db,
      hub,
      sync,
      vaults: vaultsSvc,
      buildInfo: deps.buildInfo,
      settingsOf: (vaultId) => settings.vaultSettings(vaultId),
      helloMs: deps.realtime?.helloMs ?? 5_000,
      heartbeatMs: deps.realtime?.heartbeatMs ?? 30_000,
      now: deps.now ?? Date.now,
    }),
    { prefix: "/api/v1" },
  );
  if (deps.realtime?.listen !== false) {
    let listener: { stop(): Promise<void> } | undefined;
    app.addHook("onReady", async () => {
      listener = keepListening(deps.db, hub, (e) =>
        app.log.warn({ err: (e as Error).name }, "notify listener unavailable, retrying"),
      );
    });
    app.addHook("onClose", async () => listener?.stop());
  }
  healthRoutes(app, deps.db);
  versionRoutes(app, deps.buildInfo);
  webRoutes(app, deps.webRoot);
  return app;
}
