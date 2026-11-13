import type { ConfigPatch, ConfigSource, SystemConfig } from "@kamino/protocol";
import { inArray, sql } from "drizzle-orm";
import { uuidv7 } from "../auth/tokens.js";
import type { Config, SystemEnv } from "../config/schema.js";
import { systemKey } from "../crypto/dek.js";
import { decryptField, encryptField } from "../crypto/field.js";
import type { Kek } from "../crypto/keyring.js";
import type { Db } from "../db/client.js";
import { auditLog, systemConfig } from "../db/schema.js";
import { ApiError } from "../http/errors.js";

export type SmtpSecurity = "none" | "starttls" | "tls";
export interface SmtpSettings {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
  from: string;
  allowInvalidCerts: boolean;
}
export interface EffectiveConfig {
  registration: "closed" | "open";
  defaultQuotaBytes: number | null;
  maxRetentionDays: number;
  maxFileBytes: number;
}

export const configLocked = () => new ApiError("config_locked", 409);

type Plain = {
  registration: "closed" | "open";
  defaultQuotaBytes: number | null;
  maxRetentionDays: number;
  maxFileBytes: number;
  "smtp.host": string;
  "smtp.port": number;
  "smtp.security": SmtpSecurity;
  "smtp.username": string;
  "smtp.from": string;
  "smtp.allowInvalidCerts": boolean;
};
type Key = keyof Plain;
const PASSWORD = "smtp.password";
const KEYS: Key[] = [
  "registration",
  "defaultQuotaBytes",
  "maxRetentionDays",
  "maxFileBytes",
  "smtp.host",
  "smtp.port",
  "smtp.security",
  "smtp.username",
  "smtp.from",
  "smtp.allowInvalidCerts",
];

function envValues(env: SystemEnv | undefined): Partial<Plain> & { password?: string } {
  const out: Partial<Plain> & { password?: string } = {};
  if (!env) return out;
  if (env.registration !== undefined) out.registration = env.registration;
  if (env.defaultQuotaBytes !== undefined) out.defaultQuotaBytes = env.defaultQuotaBytes;
  if (env.maxRetentionDays !== undefined) out.maxRetentionDays = env.maxRetentionDays;
  if (env.maxFileBytes !== undefined) out.maxFileBytes = env.maxFileBytes;
  const s = env.smtp;
  if (s?.host !== undefined) out["smtp.host"] = s.host;
  if (s?.port !== undefined) out["smtp.port"] = s.port;
  if (s?.security !== undefined) out["smtp.security"] = s.security;
  if (s?.username !== undefined) out["smtp.username"] = s.username;
  if (s?.from !== undefined) out["smtp.from"] = s.from;
  if (s?.allowInvalidCerts !== undefined) out["smtp.allowInvalidCerts"] = s.allowInvalidCerts;
  if (s?.password !== undefined) out.password = s.password;
  return out;
}

/** The patch as flat keys; `undefined` fields are not part of it. */
function flatten(p: ConfigPatch): Partial<Plain> & { password?: string } {
  const out: Partial<Plain> & { password?: string } = {};
  if (p.registration !== undefined) out.registration = p.registration;
  if (p.defaultQuotaBytes !== undefined) out.defaultQuotaBytes = p.defaultQuotaBytes;
  if (p.maxRetentionDays !== undefined) out.maxRetentionDays = p.maxRetentionDays;
  if (p.maxFileBytes !== undefined) out.maxFileBytes = p.maxFileBytes;
  const s = p.smtp;
  if (s?.host !== undefined) out["smtp.host"] = s.host;
  if (s?.port !== undefined) out["smtp.port"] = s.port;
  if (s?.security !== undefined) out["smtp.security"] = s.security;
  if (s?.username !== undefined) out["smtp.username"] = s.username;
  if (s?.from !== undefined) out["smtp.from"] = s.from;
  if (s?.allowInvalidCerts !== undefined) out["smtp.allowInvalidCerts"] = s.allowInvalidCerts;
  if (s?.password !== undefined) out.password = s.password;
  return out;
}

const show = (v: unknown) => (v === null ? "none" : String(v));

/**
 * E-03: system settings with the source of each value. Precedence: environment → UI → default;
 * a field set from the environment can't be changed from the UI (409 config_locked). The SMTP
 * password is write-only: stored under k_system, never returned, never audited.
 */
export class SystemConfigService {
  private readonly env: Partial<Plain> & { password?: string };
  private readonly defaults: Plain;
  private readonly key: Buffer;

  constructor(
    private readonly db: Db,
    config: Config,
    kek: Kek,
    private readonly now: () => number = Date.now,
  ) {
    this.env = envValues(config.system);
    this.key = systemKey(kek);
    this.defaults = {
      registration: "closed",
      defaultQuotaBytes: null,
      maxRetentionDays: 90,
      maxFileBytes: config.maxFileBytes,
      "smtp.host": "",
      "smtp.port": 587,
      "smtp.security": "starttls",
      "smtp.username": "",
      "smtp.from": "",
      "smtp.allowInvalidCerts": false,
    };
  }

  private async resolve(): Promise<{
    values: Plain;
    sources: Record<Key, ConfigSource>;
    password: string | null;
    passwordSource: ConfigSource;
  }> {
    const rows = await this.db.select().from(systemConfig);
    const ui = new Map(rows.map((r) => [r.key, r]));
    const values = { ...this.defaults } as Record<Key, unknown>;
    const sources = {} as Record<Key, ConfigSource>;
    for (const k of KEYS) {
      if (k in this.env) {
        values[k] = this.env[k];
        sources[k] = "env";
      } else if (ui.has(k)) {
        values[k] = ui.get(k)!.value;
        sources[k] = "ui";
      } else sources[k] = "default";
    }
    let password: string | null = null;
    let passwordSource: ConfigSource = "default";
    const stored = ui.get(PASSWORD)?.secretEnc;
    if (this.env.password !== undefined) {
      password = this.env.password;
      passwordSource = "env";
    } else if (stored) {
      password = decryptField(this.key, this.ref(), stored).toString("utf8");
      passwordSource = "ui";
    }
    return { values: values as Plain, sources, password, passwordSource };
  }

  private ref() {
    return { table: "system_config", column: "secret", rowId: PASSWORD };
  }

  async get(): Promise<SystemConfig> {
    const { values: v, sources: s, password, passwordSource } = await this.resolve();
    const f = <K extends Key>(k: K) => ({ value: v[k], source: s[k] });
    return {
      registration: f("registration"),
      defaultQuotaBytes: f("defaultQuotaBytes"),
      maxRetentionDays: f("maxRetentionDays"),
      maxFileBytes: f("maxFileBytes"),
      smtp: {
        host: f("smtp.host"),
        port: f("smtp.port"),
        security: f("smtp.security"),
        username: f("smtp.username"),
        from: f("smtp.from"),
        allowInvalidCerts: f("smtp.allowInvalidCerts"),
        passwordSet: password !== null && password !== "",
        passwordSource,
      },
      smtpConfigured: v["smtp.host"] !== "" && v["smtp.from"] !== "",
    };
  }

  /** All or nothing: one locked field refuses the whole patch. */
  async patch(p: ConfigPatch, actor: string): Promise<SystemConfig> {
    const flat = flatten(p);
    const { password, ...plain } = flat;
    if (Object.keys(plain).some((k) => k in this.env)) throw configLocked();
    if (password !== undefined && this.env.password !== undefined) throw configLocked();
    const before = (await this.resolve()).values;
    const at = new Date(this.now());
    await this.db.transaction(async (tx) => {
      for (const [k, value] of Object.entries(plain) as [Key, unknown][]) {
        await tx
          .insert(systemConfig)
          .values({ key: k, value: sql`${JSON.stringify(value)}::jsonb`, updatedAt: at })
          .onConflictDoUpdate({
            target: systemConfig.key,
            set: { value: sql`${JSON.stringify(value)}::jsonb`, updatedAt: at },
          });
        if (before[k] !== value)
          await tx.insert(auditLog).values({
            id: uuidv7(),
            actor,
            action: "config_changed",
            target: `${k}: ${show(before[k])} → ${show(value)}`,
            createdAt: at,
          });
      }
      if (password !== undefined) {
        if (password === "")
          await tx.delete(systemConfig).where(inArray(systemConfig.key, [PASSWORD]));
        else {
          const secretEnc = encryptField(this.key, this.ref(), password);
          await tx
            .insert(systemConfig)
            .values({ key: PASSWORD, secretEnc, updatedAt: at })
            .onConflictDoUpdate({ target: systemConfig.key, set: { secretEnc, updatedAt: at } });
        }
        // Secret: only the fact that it changed.
        await tx.insert(auditLog).values({
          id: uuidv7(),
          actor,
          action: "config_changed",
          target: PASSWORD,
          createdAt: at,
        });
      }
    });
    return this.get();
  }

  /** null when host or sender is missing: the features that need email are off (E-01). */
  async smtp(): Promise<SmtpSettings | null> {
    const { values: v, password } = await this.resolve();
    if (v["smtp.host"] === "" || v["smtp.from"] === "") return null;
    return {
      host: v["smtp.host"],
      port: v["smtp.port"],
      security: v["smtp.security"],
      username: v["smtp.username"],
      password: password ?? "",
      from: v["smtp.from"],
      allowInvalidCerts: v["smtp.allowInvalidCerts"],
    };
  }

  async effective(): Promise<EffectiveConfig> {
    const { values: v } = await this.resolve();
    return {
      registration: v.registration,
      defaultQuotaBytes: v.defaultQuotaBytes,
      maxRetentionDays: v.maxRetentionDays,
      maxFileBytes: v.maxFileBytes,
    };
  }
}
