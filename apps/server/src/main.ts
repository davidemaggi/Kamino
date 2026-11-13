import { PRODUCT_NAME } from "@kamino/brand";
import { buildApp } from "./app.js";
import { AuthService } from "./auth/service.js";
import { createBlobStore } from "./blobs/store.js";
import { UploadService } from "./blobs/uploads.js";
import { sweepPairings } from "./pairing/service.js";
import { buildInfo } from "./build-info.js";
import { ConfigError, loadConfig } from "./config/load.js";
import { ensureKeyCheck } from "./crypto/key-check.js";
import { MasterKeyError, parseMasterKey, type Kek } from "./crypto/keyring.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { startJobs, type Jobs } from "./jobs/boss.js";
import { compactJournal } from "./jobs/compact.js";
import { purgeDeletedVaults } from "./jobs/purge.js";
import { drainOutbox } from "./jobs/email.js";
import { finalizeDeletions, runExports } from "./jobs/deletion.js";
import { UserDeletion } from "./users/deletion.js";
import { VaultService } from "./vaults/service.js";
import { Hub } from "./realtime/hub.js";
import { smtpTransport } from "./email/mailer.js";
import { Outbox } from "./email/outbox.js";
import { SystemConfigService } from "./system/config.js";
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
  const systemConfig = new SystemConfigService(db, config, kek);
  // The drain is queued right after an enqueue; `jobs` exists only once pg-boss has started.
  const started: { jobs?: Jobs } = {};
  const outbox = new Outbox(db, kek, systemConfig, smtpTransport, Date.now, logger, () =>
    started.jobs?.kick("email"),
  );
  const store = createBlobStore(config.storage);
  const vaults = new VaultService(db, kek);
  const hub = new Hub();
  const deletion = new UserDeletion({
    db,
    kek,
    auth,
    vaults,
    store,
    hub,
    config: systemConfig,
    outbox,
    publicUrl: config.publicUrl,
    now: Date.now,
    log: logger,
    kick: (job) => started.jobs?.kick(job),
  });
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
    systemConfig,
    outbox,
    vaults,
    hub,
    blobStore: store,
    deletion,
    webRoot: resolveWebRoot(),
  });

  // ADR 0008: compaction (daily) and upload cleanup (hourly, C10), after the key check.
  const uploads = new UploadService(db, store, config.stagingDir, config.maxFileBytes);
  const jobs = await startJobs(
    config.databaseUrl,
    {
      compact: async () =>
        compactJournal(db, Date.now(), (await systemConfig.effective()).maxRetentionDays),
      // Abandoned uploads (C10), and pairings a day past their expiry.
      sweep: async () => {
        await uploads.sweep();
        await sweepPairings(db, Date.now());
      },
      purge: () => purgeDeletedVaults(db, store),
      email: () => drainOutbox(outbox),
      exports: () => runExports(deletion),
      finalize: () => finalizeDeletions(deletion),
    },
    logger,
  );
  started.jobs = jobs;

  const shutdown = async (): Promise<void> => {
    try {
      await app.close();
      await jobs.stop();
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
