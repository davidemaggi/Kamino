import type { AuditEntry, ConfigSource } from "@kamino/protocol";
import type { Level } from "@kamino/status";
import type { FakeUser } from "./db.js";

// Fake admin-side data (dev/tests). Per-user aggregates only (U-03).
const NOW = Date.UTC(2026, 10, 8, 10, 0);
const DAY = 86_400_000;
const GB = 1024 ** 3;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

export interface UserMeta {
  createdAt: string;
  lastLoginAt: string | null;
  quotaBytes: number | null;
  usedBytes: number;
  vaultCount: number;
  deviceCount: number;
  syncLevel: Level;
  invited: boolean;
  deletionAt: string | null;
}

type F<T> = { value: T; source: ConfigSource };
interface Config {
  registration: F<"closed" | "open">;
  defaultQuotaBytes: F<number | null>;
  maxRetentionDays: F<number>;
  maxFileBytes: F<number>;
  smtp: {
    host: F<string>;
    port: F<number>;
    security: F<"none" | "starttls" | "tls">;
    username: F<string>;
    from: F<string>;
    allowInvalidCerts: F<boolean>;
    password: string;
    passwordSource: ConfigSource;
  };
}

interface AdminData {
  meta: Map<string, UserMeta>;
  config: Config;
  audit: AuditEntry[];
  smtpFails: boolean;
  seq: number;
}

export const ad: AdminData = {
  meta: new Map(),
  config: undefined as unknown as Config,
  audit: [],
  smtpFails: false,
  seq: 0,
};

export function defaultMeta(over: Partial<UserMeta> = {}): UserMeta {
  return {
    createdAt: iso(0),
    lastLoginAt: null,
    quotaBytes: 10 * GB,
    usedBytes: 0,
    vaultCount: 0,
    deviceCount: 0,
    syncLevel: "safe",
    invited: false,
    deletionAt: null,
    ...over,
  };
}

export function seedAdminData(users: FakeUser[]): void {
  ad.seq = 0;
  ad.smtpFails = false;
  ad.meta = new Map();
  const levels: Level[] = ["decision", "safe", "working", "safe", "attention"];
  users.forEach((u, i) => {
    ad.meta.set(
      u.id,
      defaultMeta({
        createdAt: iso((60 - i) * DAY),
        lastLoginAt: iso(i * DAY),
        quotaBytes: u.username === "demo" ? null : 10 * GB,
        usedBytes: (i + 1) * 0.7 * GB,
        vaultCount: (i % 3) + 1,
        deviceCount: (i % 4) + 1,
        syncLevel: levels[i % levels.length]!,
      }),
    );
  });
  ad.config = {
    registration: { value: "closed", source: "default" },
    defaultQuotaBytes: { value: 10 * GB, source: "ui" },
    maxRetentionDays: { value: 90, source: "default" },
    maxFileBytes: { value: 500 * 1024 ** 2, source: "env" },
    smtp: {
      host: { value: "smtp.example.com", source: "env" },
      port: { value: 587, source: "ui" },
      security: { value: "starttls", source: "ui" },
      username: { value: "kamino", source: "ui" },
      from: { value: "kamino@example.com", source: "ui" },
      allowInvalidCerts: { value: false, source: "default" },
      password: "secret",
      passwordSource: "ui",
    },
  };
  const actions: AuditEntry["action"][] = [
    "user_created",
    "quota_changed",
    "config_changed",
    "user_blocked",
    "reset_link_created",
  ];
  ad.audit = Array.from({ length: 30 }, (_, i) => ({
    id: `a-${i}`,
    at: iso(i * 7_200_000),
    actor: "admin",
    action: actions[i % actions.length]!,
    target: i % 5 === 2 ? "smtp.port" : "demo",
  }));
}

export function addAudit(actor: string, action: AuditEntry["action"], target: string): void {
  ad.audit.unshift({
    id: `a-new-${++ad.seq}`,
    at: new Date().toISOString(),
    actor,
    action,
    target,
  });
}

/** Dev panel: the next SMTP test fails with a detailed error. */
export function simulateSmtpFailure(): void {
  ad.smtpFails = true;
}
