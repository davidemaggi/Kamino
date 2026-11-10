import { PRODUCT_NAME } from "@kamino/brand";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { registerAuthHttp } from "./auth/http.js";
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
import { createBlobStore, type BlobStore } from "./blobs/store.js";
import { UploadService } from "./blobs/uploads.js";
import { VaultService } from "./vaults/service.js";
import { healthRoutes } from "./routes/health.js";
import { versionRoutes } from "./routes/version.js";
import { webRoutes } from "./web.js";

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
  /** Directory with the web build; when absent or missing, no static routes are served. */
  webRoot?: string | undefined;
};

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
  const auth = deps.auth ?? new AuthService(deps.db, deps.kek, PRODUCT_NAME);
  await registerAuthHttp(app, auth);
  const secure = deps.config.publicUrl.startsWith("https:");
  await app.register(authRoutes(auth, secure), { prefix: "/api/v1" });
  await app.register(accountRoutes(auth), { prefix: "/api/v1" });
  const vaultsSvc = deps.vaults ?? new VaultService(deps.db, deps.kek);
  await app.register(enrollRoutes(deps.db, auth, vaultsSvc), { prefix: "/api/v1" });
  const blobStore = deps.blobStore ?? createBlobStore(deps.config.storage);
  const uploads =
    deps.uploads ??
    new UploadService(deps.db, blobStore, deps.config.stagingDir, deps.config.maxFileBytes);
  await app.register(transferRoutes(deps.db, vaultsSvc, uploads, blobStore), { prefix: "/api/v1" });
  healthRoutes(app, deps.db);
  versionRoutes(app, deps.buildInfo);
  webRoutes(app, deps.webRoot);
  return app;
}
