import { buildApp } from "./app.js";
import { buildInfo } from "./build-info.js";
import { ConfigError, loadConfig } from "./config/load.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createLogger } from "./observability/logger.js";

async function main(): Promise<void> {
  let loaded;
  try {
    loaded = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  const { config } = loaded;
  const logger = createLogger(config.logLevel);
  const db = createDb(config.databaseUrl);

  // TODO(task-6): verify the master key (key_check) here, before running migrations.

  await runMigrations(db);

  const app = buildApp({ config, db, logger, buildInfo });

  const shutdown = async (): Promise<void> => {
    try {
      await app.close();
      await db.$client.end({ timeout: 5 });
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
