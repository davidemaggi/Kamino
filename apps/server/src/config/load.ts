import { readFileSync } from "node:fs";
import { envName } from "@kamino/brand";
import {
  DEFAULT_LOG_LEVEL,
  DEFAULT_PORT,
  LOG_LEVELS,
  type Config,
  type ConfigSource,
  type LogLevel,
} from "./schema.js";

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid configuration:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

type Env = Record<string, string | undefined>;
type Resolved = { value: string; source: ConfigSource } | undefined;

/** An empty string (e.g. `KAMINO_PUBLIC_URL=` in a compose file) counts as unset. */
function read(env: Env, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
}

/** Resolves `NAME` or `NAME_FILE` (Docker secret); setting both is an error. */
function readSecret(
  env: Env,
  key: string,
  readFile: (p: string) => string,
  issues: string[],
): Resolved {
  const name = envName(key);
  const fileName = `${name}_FILE`;
  const direct = read(env, name);
  const path = read(env, fileName);
  if (direct !== undefined && path !== undefined) {
    issues.push(`${name} and ${fileName} are both set: use only one of the two`);
    return undefined;
  }
  if (direct !== undefined) return { value: direct, source: "env" };
  if (path !== undefined) {
    try {
      const content = readFile(path).replace(/[\r\n]+$/, "");
      if (content === "") {
        issues.push(`${fileName} points to an empty file`);
        return undefined;
      }
      return { value: content, source: "file" };
    } catch {
      issues.push(`${fileName} points to a file that cannot be read`);
      return undefined;
    }
  }
  issues.push(`${name} is required (or ${fileName})`);
  return undefined;
}

export function loadConfig(
  env: Env,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): { config: Config; sources: Record<keyof Config, ConfigSource> } {
  const issues: string[] = [];

  const publicUrlRaw = read(env, envName("PUBLIC_URL"));
  let publicUrl = "";
  if (publicUrlRaw === undefined) {
    issues.push(`${envName("PUBLIC_URL")} is required`);
  } else {
    try {
      const u = new URL(publicUrlRaw);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
      publicUrl = publicUrlRaw;
    } catch {
      issues.push(`${envName("PUBLIC_URL")} must be an absolute http(s) URL`);
    }
  }

  const portRaw = read(env, envName("PORT"));
  let port = DEFAULT_PORT;
  if (portRaw !== undefined) {
    const n = Number(portRaw);
    if (/^\d+$/.test(portRaw) && n >= 1 && n <= 65535) port = n;
    else issues.push(`${envName("PORT")} must be an integer between 1 and 65535`);
  }

  const levelRaw = read(env, envName("LOG_LEVEL"));
  let logLevel: LogLevel = DEFAULT_LOG_LEVEL;
  if (levelRaw !== undefined) {
    if ((LOG_LEVELS as readonly string[]).includes(levelRaw)) logLevel = levelRaw as LogLevel;
    else issues.push(`${envName("LOG_LEVEL")} must be one of: ${LOG_LEVELS.join(", ")}`);
  }

  const databaseUrl = readSecret(env, "DATABASE_URL", readFile, issues);
  const masterKey = readSecret(env, "MASTER_KEY", readFile, issues);

  if (issues.length > 0 || !databaseUrl || !masterKey) throw new ConfigError(issues);

  return {
    config: {
      publicUrl,
      port,
      databaseUrl: databaseUrl.value,
      masterKey: masterKey.value,
      logLevel,
    },
    sources: {
      publicUrl: "env",
      port: portRaw === undefined ? "default" : "env",
      databaseUrl: databaseUrl.source,
      masterKey: masterKey.source,
      logLevel: levelRaw === undefined ? "default" : "env",
    },
  };
}
