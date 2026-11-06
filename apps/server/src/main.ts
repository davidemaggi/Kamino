import { buildApp } from "./app.js";
import { buildInfo } from "./build-info.js";
import { ConfigError, loadConfig } from "./config/load.js";
import { ensureKeyCheck } from "./crypto/key-check.js";
import { MasterKeyError, parseMasterKey, type Kek } from "./crypto/keyring.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createLogger } from "./observability/logger.js";
import { resolveWebRoot } from "./web.js";

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
  // Fail fast on a malformed key before touching the database. Never log the key itself.
  let kek: Kek;
  try {
    kek = parseMasterKey(config.masterKey);
  } catch (e) {
    if (e instanceof MasterKeyError) {
      logger.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  const db = createDb(config.databaseUrl);

  // key_check is created by the migrations, so they run first; the port stays closed
  // until the master key has been verified against this database.
  // TODO: when the first application migration lands, run the key_check migration and verify
  // the key BEFORE applying the rest (ruling R16).
  await runMigrations(db);
  try {
    const result = await ensureKeyCheck(db, kek);
    logger.info({ kekId: kek.id, result }, "master key verified");
  } catch (e) {
    if (e instanceof MasterKeyError) {
      logger.error(e.message);
      await db.$client.end({ timeout: 5 });
      process.exit(1);
    }
    throw e;
  }

  const app = buildApp({ config, db, logger, buildInfo, webRoot: resolveWebRoot() });

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
