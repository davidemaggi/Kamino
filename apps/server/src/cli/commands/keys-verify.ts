import { verifyKeyCheck } from "../../crypto/key-check.js";
import { MasterKeyError } from "../../crypto/keyring.js";
import { createDb } from "../../db/client.js";
import { loadConfigAndKek } from "./load.js";
import type { Command } from "../io.js";

/** Read-only: never creates the key check; the server initializes it on first start. */
export const keysVerify: Command = async (_args, env, io) => {
  const loaded = loadConfigAndKek(env, io);
  if (!loaded) return 1;
  const db = createDb(loaded.config.databaseUrl);
  try {
    await verifyKeyCheck(db, loaded.kek);
    io.stdout("master key verified\n");
    return 0;
  } catch (e) {
    if (e instanceof MasterKeyError) {
      io.stderr(`${e.message}\n`);
      return 1;
    }
    io.stderr("could not reach the database to verify the master key\n");
    return 1;
  } finally {
    await db.$client.end({ timeout: 5 });
  }
};
