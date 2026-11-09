import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/** KEK verification record checked at startup (docs/05-data-model.md section 3). */
export const keyCheck = pgTable("key_check", {
  kekId: text("kek_id").primaryKey(),
  checkValue: bytea("check_value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
});

export const role = pgEnum("role", ["user", "admin"]);
/** `invited`: created by an invitation, no password yet. */
export const userStatus = pgEnum("user_status", [
  "invited",
  "active",
  "blocked",
  "pending_deletion",
  "deleted",
]);
export const theme = pgEnum("theme", ["light", "dark", "system"]);
export const tokenKind = pgEnum("token_kind", [
  "invite",
  "activation",
  "password_reset",
  "setup",
  "export_download",
  "email_change",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
  /** NFC + case-folded: uniqueness without the citext extension. */
  usernameKey: text("username_key").notNull().unique(),
  email: text("email").notNull(),
  emailKey: text("email_key").notNull().unique(),
  passwordHash: text("password_hash"),
  role: role("role").notNull().default("user"),
  status: userStatus("status").notNull().default("active"),
  locale: text("locale").notNull().default("it"),
  theme: theme("theme").notNull().default("system"),
  /** Encrypted with k_system, AAD users ‖ totp_secret ‖ id. Set at setup, enabled at confirm. */
  totpSecret: bytea("totp_secret"),
  totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
  totpLastStep: bigint("totp_last_step", { mode: "number" }),
  /** U-09: a reset started by an admin, shown to the user until the password changes. */
  adminResetAt: timestamp("admin_reset_at", { withTimezone: true }),
  deletionScheduledAt: timestamp("deletion_scheduled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const recoveryCodes = pgTable("recovery_codes", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

export const webSessions = pgTable(
  "web_sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("web_sessions_user").on(t.userId)],
);

export const securityEvents = pgTable(
  "security_events",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    ip: text("ip"),
    client: text("client"),
    seenAt: timestamp("seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("security_events_user").on(t.userId, t.createdAt)],
);

export const oneTimeTokens = pgTable("one_time_tokens", {
  id: uuid("id").primaryKey(),
  kind: tokenKind("kind").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  email: text("email"),
  payload: jsonb("payload"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdBy: text("created_by"),
});

/** 04 §9: append-only, never contents or paths. */
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});
