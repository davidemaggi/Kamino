import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { BuildInfo } from "./build-info.js";
import type { Config } from "./config/schema.js";
import type { Db } from "./db/client.js";
import type { Logger } from "./observability/logger.js";
import { healthRoutes } from "./routes/health.js";
import { versionRoutes } from "./routes/version.js";
import { webRoutes } from "./web.js";

export type AppDeps = {
  config: Config;
  db: Db;
  logger: Logger;
  buildInfo: BuildInfo;
  /** Directory with the web build; when absent or missing, no static routes are served. */
  webRoot?: string | undefined;
};

export function buildApp(deps: AppDeps): FastifyInstance {
  // Widen pino's Logger so the instance type stays the default FastifyInstance.
  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app = Fastify({ loggerInstance });
  healthRoutes(app, deps.db);
  versionRoutes(app, deps.buildInfo);
  webRoutes(app, deps.webRoot);
  return app;
}
