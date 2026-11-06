import { ConfigError, loadConfig } from "../../config/load.js";
import type { Config } from "../../config/schema.js";
import { MasterKeyError, parseMasterKey, type Kek } from "../../crypto/keyring.js";
import type { Env, Io } from "../io.js";

/** Loads config and parses the master key; reports failures on stderr (never the key). */
export function loadConfigAndKek(env: Env, io: Io): { config: Config; kek: Kek } | undefined {
  let config: Config;
  try {
    config = loadConfig(env).config;
  } catch (e) {
    if (e instanceof ConfigError) {
      io.stderr(`${e.message}\n`);
      return undefined;
    }
    throw e;
  }
  try {
    return { config, kek: parseMasterKey(config.masterKey) };
  } catch (e) {
    if (e instanceof MasterKeyError) {
      io.stderr(`${e.message}\n`);
      return undefined;
    }
    throw e;
  }
}
