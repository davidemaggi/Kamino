import { createDb } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { loadConfigAndKek } from "./load.js";
import type { Command } from "../io.js";

export const migrate: Command = async (_args, env, io) => {
  const loaded = loadConfigAndKek(env, io);
  if (!loaded) return 1;
  const db = createDb(loaded.config.databaseUrl);
  try {
    await runMigrations(db);
    io.stdout("migrations applied\n");
    return 0;
  } finally {
    await db.$client.end({ timeout: 5 });
  }
};
