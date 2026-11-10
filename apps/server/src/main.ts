import { PRODUCT_NAME } from "@kamino/brand";
import { buildApp } from "./app.js";
import { AuthService } from "./auth/service.js";
import { createBlobStore } from "./blobs/store.js";
import { UploadService } from "./blobs/uploads.js";
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

  // R16: key_check migration, then the master key check, then every other migration;
  // the port stays closed until the key has been verified against this database.
  try {
    await runMigrations(db, async () => {
      const result = await ensureKeyCheck(db, kek);
      logger.info({ kekId: kek.id, result }, "master key verified");
    });
  } catch (e) {
    if (e instanceof MasterKeyError) {
      logger.error(e.message);
      await db.$client.end({ timeout: 5 });
      process.exit(1);
    }
    throw e;
  }

  const auth = new AuthService(db, kek, PRODUCT_NAME);
  const setupToken = await auth.ensureSetupToken();
  // 04 §8: the only token ever logged, once, while the server has no users.
  if (setupToken)
    logger.warn(`no users yet: finish the setup at ${config.publicUrl}/setup?token=${setupToken}`);
  const app = await buildApp({
    config,
    db,
    logger,
    buildInfo,
    kek,
    auth,
    webRoot: resolveWebRoot(),
  });

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

  // C10: expired upload sessions and their (encrypted) staging are cleaned up every hour.
  const uploads = new UploadService(
    db,
    createBlobStore(config.storage),
    config.stagingDir,
    config.maxFileBytes,
  );
  const sweeper = setInterval(() => void uploads.sweep().catch(() => undefined), 3_600_000);
  sweeper.unref();

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
