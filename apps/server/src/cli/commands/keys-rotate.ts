import { envName } from "@kamino/brand";
import { MasterKeyError } from "../../crypto/keyring.js";
import { createDb } from "../../db/client.js";
import { rotateKeys } from "../../keys/rotate.js";
import { loadConfigAndKek } from "./load.js";
import type { Command } from "../io.js";

/**
 * 04 §5.2. Same environment as the server during a rotation: the new key in MASTER_KEY, the old
 * one in MASTER_KEY_PREVIOUS. Repeatable; prints counts only, never keys or row contents.
 */
export const keysRotate: Command = async (args, env, io) => {
  if (args.length > 0) {
    io.stderr("keys rotate takes no arguments\n");
    return 2;
  }
  const loaded = loadConfigAndKek(env, io);
  if (!loaded) return 1;
  if (!loaded.kek.previous) {
    io.stderr(
      `set the new key in ${envName("MASTER_KEY")} and the old one in ${envName("MASTER_KEY_PREVIOUS")} ` +
        `(or the *_FILE variants), restart the server with both, then run keys rotate\n`,
    );
    return 2;
  }
  const db = createDb(loaded.config.databaseUrl);
  try {
    const r = await rotateKeys(db, loaded.kek, "cli");
    io.stdout(`re-wrapped ${r.vaults} vault keys, re-encrypted ${r.secrets} secrets\n`);
    if (!r.done) {
      io.stderr(
        `${r.unreadable} items can't be read with either key: the old key is still needed, nothing was retired\n`,
      );
      return 1;
    }
    if (r.pendingExports.count > 0 && r.pendingExports.until)
      io.stdout(
        `${r.pendingExports.count} account deletion exports still use the old key: keep ` +
          `${envName("MASTER_KEY_PREVIOUS")} until ${r.pendingExports.until.toISOString()}, then remove it\n`,
      );
    else
      io.stdout(
        `rotation complete: remove ${envName("MASTER_KEY_PREVIOUS")} and restart the server; ` +
          `backups made before now still need the old key\n`,
      );
    return 0;
  } catch (e) {
    if (e instanceof MasterKeyError) {
      io.stderr(`${e.message}\n`);
      return 1;
    }
    io.stderr("could not complete the rotation; it can be run again safely\n");
    return 1;
  } finally {
    await db.$client.end({ timeout: 5 });
  }
};
