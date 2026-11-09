import { ensureKeyCheck } from "../../crypto/key-check.js";
import { MasterKeyError } from "../../crypto/keyring.js";
import { createDb } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { loadConfigAndKek } from "./load.js";
import type { Command } from "../io.js";

export const migrate: Command = async (_args, env, io) => {
  const loaded = loadConfigAndKek(env, io);
  if (!loaded) return 1;
  const db = createDb(loaded.config.databaseUrl);
  try {
    // R16, as at server start: application migrations only after the master key check.
    await runMigrations(db, async () => {
      await ensureKeyCheck(db, loaded.kek);
    });
    io.stdout("migrations applied\n");
    return 0;
  } catch (e) {
    if (e instanceof MasterKeyError) {
      io.stderr(`${e.message}\n`);
      return 1;
    }
    io.stderr("migration failed: could not reach the database or apply migrations\n");
    return 1;
  } finally {
    await db.$client.end({ timeout: 5 });
  }
};
