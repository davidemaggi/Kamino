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
  /** Directory with the web build; when absent or missing, no static routes are served. */
  webRoot?: string | undefined;
};

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // Widen pino's Logger so the instance type stays the default FastifyInstance.
  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app = Fastify({ loggerInstance, trustProxy: true });
  const auth = deps.auth ?? new AuthService(deps.db, deps.kek, PRODUCT_NAME);
  await registerAuthHttp(app, auth);
  const secure = deps.config.publicUrl.startsWith("https:");
  await app.register(authRoutes(auth, secure), { prefix: "/api/v1" });
  await app.register(accountRoutes(auth), { prefix: "/api/v1" });
  healthRoutes(app, deps.db);
  versionRoutes(app, deps.buildInfo);
  webRoutes(app, deps.webRoot);
  return app;
}
