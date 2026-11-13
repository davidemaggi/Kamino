import { createBackup, BackupError, BackupReader, restoreBackup } from "../../backup/archive.js";
import { verifyBackup } from "../../backup/verify.js";
import { createBlobStore } from "../../blobs/store.js";
import { MasterKeyError } from "../../crypto/keyring.js";
import { createDb } from "../../db/client.js";
import { loadConfigAndKek } from "./load.js";
import type { Command, Io } from "../io.js";

/** Known failures print their message (never keys, paths of vault files or row contents). */
function report(e: unknown, io: Io, what: string): number {
  if (e instanceof BackupError || e instanceof MasterKeyError) io.stderr(`${e.message}\n`);
  else io.stderr(`${what} failed\n`);
  return 1;
}

function fileArg(args: string[], io: Io, cmd: string): string | undefined {
  if (args.length !== 1 || !args[0]) {
    io.stderr(`usage: backup ${cmd} <file>\n`);
    return undefined;
  }
  return args[0];
}

/** M7b B2: database snapshot + storage objects; the master key is never written. */
export const backupCreate: Command = async (args, env, io) => {
  const file = fileArg(args, io, "create");
  if (!file) return 2;
  const loaded = loadConfigAndKek(env, io);
  if (!loaded) return 1;
  const db = createDb(loaded.config.databaseUrl);
  try {
    const m = await createBackup(db, createBlobStore(loaded.config.storage), file);
    const rows = m.tables.reduce((n, t) => n + t.rows, 0);
    io.stdout(`backup written: ${m.tables.length} tables, ${rows} rows, ${m.blobs} objects\n`);
    if (m.missingBlobs.length > 0)
      io.stdout(`${m.missingBlobs.length} objects were already gone from the storage (skipped)\n`);
    io.stdout("keep the master key separately: the backup can't be read without it\n");
    return 0;
  } catch (e) {
    return report(e, io, "backup");
  } finally {
    await db.$client.end({ timeout: 5 });
  }
};

/** M7b B3: restore into a temporary database and check keys and a sample of blobs. */
export const backupVerify: Command = async (args, env, io) => {
  const file = fileArg(args, io, "verify");
  if (!file) return 2;
  const loaded = loadConfigAndKek(env, io);
  if (!loaded) return 1;
  try {
    const r = await verifyBackup(loaded.config.databaseUrl, file, loaded.kek);
    io.stdout(
      `backup verified: ${r.tables} tables, ${r.rows} rows, ${r.vaults} vault keys opened, ` +
        `${r.blobsChecked} of ${r.blobsTotal} objects decrypted and checked\n`,
    );
    return 0;
  } catch (e) {
    return report(e, io, "verification");
  }
};

/** M7b B4: only into an empty database, with the same server version and master key. */
export const backupRestore: Command = async (args, env, io) => {
  const file = fileArg(args, io, "restore");
  if (!file) return 2;
  const loaded = loadConfigAndKek(env, io);
  if (!loaded) return 1;
  const db = createDb(loaded.config.databaseUrl);
  let backup: BackupReader | undefined;
  try {
    backup = await BackupReader.open(file);
    const r = await restoreBackup(db, createBlobStore(loaded.config.storage), backup, loaded.kek);
    io.stdout(`restored: ${r.tables} tables, ${r.rows} rows, ${r.blobs} objects\n`);
    return 0;
  } catch (e) {
    return report(e, io, "restore");
  } finally {
    backup?.close();
    await db.$client.end({ timeout: 5 });
  }
};
