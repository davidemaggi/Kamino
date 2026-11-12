import { readFileSync } from "node:fs";
import { envName } from "@kamino/brand";
import {
  DEFAULT_LOG_LEVEL,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_STAGING_DIR,
  DEFAULT_STORAGE_DIR,
  DEFAULT_PORT,
  LOG_LEVELS,
  type Config,
  type SystemEnv,
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

/**
 * Decodes a secret file. Windows PowerShell 5.1 redirection writes UTF-16LE with a BOM, so
 * UTF-16 (LE/BE) is detected by its BOM; a UTF-8 BOM is stripped.
 */
function decodeSecret(raw: Buffer | string): string {
  if (typeof raw === "string") return raw.replace(/^\uFEFF/, "");
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe)
    return raw.subarray(2).toString("utf16le");
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    return Buffer.from(raw.subarray(2)).swap16().toString("utf16le");
  }
  return raw.toString("utf8").replace(/^\uFEFF/, "");
}

/** Resolves `NAME` or `NAME_FILE` (Docker secret); setting both is an error. */
function readSecret(
  env: Env,
  key: string,
  readFile: (p: string) => Buffer | string,
  issues: string[],
  required = true,
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
      const content = decodeSecret(readFile(path)).replace(/[\r\n]+$/, "");
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
  if (required) issues.push(`${name} is required (or ${fileName})`);
  return undefined;
}

/** An IPv4/IPv6 address with an optional /prefix (a shape check; the proxy library parses it). */
function isIpOrCidr(s: string): boolean {
  return /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(s) && /[.:]/.test(s);
}

function nonNegativeInt(env: Env, key: string, issues: string[], max?: number): number | undefined {
  const raw = read(env, envName(key));
  if (raw === undefined) return undefined;
  if (/^\d+$/.test(raw) && (max === undefined || Number(raw) <= max)) return Number(raw);
  issues.push(
    `${envName(key)} must be a non-negative integer${max === undefined ? "" : ` up to ${max}`}`,
  );
  return undefined;
}

function oneOf<T extends string>(
  env: Env,
  key: string,
  allowed: readonly T[],
  issues: string[],
): T | undefined {
  const raw = read(env, envName(key));
  if (raw === undefined) return undefined;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  issues.push(`${envName(key)} must be one of: ${allowed.join(", ")}`);
  return undefined;
}

/** E-03: only what is set ends up in the result, so the UI knows which fields are locked. */
function loadSystemEnv(
  env: Env,
  readFile: (p: string) => Buffer | string,
  issues: string[],
): SystemEnv {
  const out: SystemEnv = {};
  const registration = oneOf(env, "REGISTRATION", ["closed", "open"] as const, issues);
  if (registration) out.registration = registration;
  if (read(env, envName("DEFAULT_QUOTA_BYTES")) === "none") out.defaultQuotaBytes = null;
  else {
    const q = nonNegativeInt(env, "DEFAULT_QUOTA_BYTES", issues);
    if (q !== undefined) out.defaultQuotaBytes = q;
  }
  const days = nonNegativeInt(env, "MAX_RETENTION_DAYS", issues, 90);
  if (days !== undefined) out.maxRetentionDays = days;

  const smtp: NonNullable<SystemEnv["smtp"]> = {};
  const host = read(env, envName("SMTP_HOST"));
  if (host !== undefined) smtp.host = host;
  const portRaw = read(env, envName("SMTP_PORT"));
  if (portRaw !== undefined) {
    const n = Number(portRaw);
    if (/^\d+$/.test(portRaw) && n >= 1 && n <= 65535) smtp.port = n;
    else issues.push(`${envName("SMTP_PORT")} must be an integer between 1 and 65535`);
  }
  const security = oneOf(env, "SMTP_SECURITY", ["none", "starttls", "tls"] as const, issues);
  if (security) smtp.security = security;
  const username = read(env, envName("SMTP_USERNAME"));
  if (username !== undefined) smtp.username = username;
  const password = readSecret(env, "SMTP_PASSWORD", readFile, issues, false);
  if (password) smtp.password = password.value;
  const from = read(env, envName("SMTP_FROM"));
  if (from !== undefined) smtp.from = from;
  const invalid = oneOf(env, "SMTP_ALLOW_INVALID_CERTS", ["true", "false"] as const, issues);
  if (invalid) smtp.allowInvalidCerts = invalid === "true";
  if (Object.keys(smtp).length > 0) out.smtp = smtp;
  return out;
}

export function loadConfig(
  env: Env,
  readFile: (p: string) => Buffer | string = (p) => readFileSync(p),
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
      publicUrl = publicUrlRaw.replace(/\/+$/, "");
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

  const proxyRaw = read(env, envName("TRUST_PROXY"));
  let trustProxy: number | string[] | undefined;
  if (proxyRaw !== undefined) {
    if (/^\d+$/.test(proxyRaw) && Number(proxyRaw) >= 1 && Number(proxyRaw) <= 10)
      trustProxy = Number(proxyRaw);
    else if (proxyRaw.replace(/\s/g, "").split(",").every(isIpOrCidr))
      trustProxy = proxyRaw.replace(/\s/g, "").split(",");
    else
      issues.push(
        `${envName("TRUST_PROXY")} must be a hop count (1-10) or a comma-separated list of IPs/CIDRs`,
      );
  }

  const storageKind = read(env, envName("STORAGE")) ?? "fs";
  let storage: Config["storage"] = {
    kind: "fs",
    dir: read(env, envName("STORAGE_DIR")) ?? DEFAULT_STORAGE_DIR,
  };
  if (storageKind === "s3") {
    const bucket = read(env, envName("S3_BUCKET"));
    const accessKeyId = read(env, envName("S3_ACCESS_KEY_ID"));
    const secret = readSecret(env, "S3_SECRET_ACCESS_KEY", readFile, issues);
    if (!bucket) issues.push(`${envName("S3_BUCKET")} is required with ${envName("STORAGE")}=s3`);
    if (!accessKeyId)
      issues.push(`${envName("S3_ACCESS_KEY_ID")} is required with ${envName("STORAGE")}=s3`);
    const endpoint = read(env, envName("S3_ENDPOINT"));
    if (bucket && accessKeyId && secret)
      storage = {
        kind: "s3",
        bucket,
        accessKeyId,
        secretAccessKey: secret.value,
        region: read(env, envName("S3_REGION")) ?? "us-east-1",
        forcePathStyle: read(env, envName("S3_FORCE_PATH_STYLE")) === "true",
        ...(endpoint ? { endpoint } : {}),
      };
  } else if (storageKind !== "fs") issues.push(`${envName("STORAGE")} must be fs or s3`);
  const stagingDir = read(env, envName("STAGING_DIR")) ?? DEFAULT_STAGING_DIR;
  const maxRaw = read(env, envName("MAX_FILE_BYTES"));
  let maxFileBytes = DEFAULT_MAX_FILE_BYTES;
  if (maxRaw !== undefined) {
    if (/^\d+$/.test(maxRaw) && Number(maxRaw) >= 1) maxFileBytes = Number(maxRaw);
    else issues.push(`${envName("MAX_FILE_BYTES")} must be a positive integer (bytes)`);
  }

  const system = loadSystemEnv(env, readFile, issues);
  if (maxRaw !== undefined) system.maxFileBytes = maxFileBytes;

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
      ...(trustProxy !== undefined ? { trustProxy } : {}),
      storage,
      stagingDir,
      maxFileBytes,
      system,
    },
    sources: {
      publicUrl: "env",
      port: portRaw === undefined ? "default" : "env",
      databaseUrl: databaseUrl.source,
      masterKey: masterKey.source,
      logLevel: levelRaw === undefined ? "default" : "env",
      trustProxy: proxyRaw === undefined ? "default" : "env",
      storage:
        storageKind === "s3" || read(env, envName("STORAGE_DIR")) !== undefined ? "env" : "default",
      stagingDir: read(env, envName("STAGING_DIR")) === undefined ? "default" : "env",
      maxFileBytes: maxRaw === undefined ? "default" : "env",
      system: Object.keys(system).length === 0 ? "default" : "env",
    },
  };
}
