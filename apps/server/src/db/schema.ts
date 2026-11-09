import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
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
  "device_enrollment",
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

export const vaultStatus = pgEnum("vault_status", ["active", "deleted"]);
export const devicePlatform = pgEnum("device_platform", [
  "windows",
  "macos",
  "linux",
  "ios",
  "android",
  "unknown",
]);

export const vaults = pgTable("vaults", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Encrypted with the vault's k_meta, AAD vaults ‖ name ‖ id. */
  nameEnc: bytea("name_enc").notNull(),
  dekWrapped: bytea("dek_wrapped").notNull(),
  kekId: text("kek_id").notNull(),
  dekVersion: integer("dek_version").notNull().default(1),
  headSeq: bigint("head_seq", { mode: "number" }).notNull().default(0),
  retentionDays: integer("retention_days").notNull().default(30),
  status: vaultStatus("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  vaultId: uuid("vault_id")
    .notNull()
    .references(() => vaults.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  platform: devicePlatform("platform").notNull(),
  pluginVersion: text("plugin_version").notNull(),
  protocolVersion: integer("protocol_version").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  isOrigin: boolean("is_origin").notNull().default(false),
  cursorSeq: bigint("cursor_seq", { mode: "number" }).notNull().default(0),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastAckAt: timestamp("last_ack_at", { withTimezone: true }),
  pendingOps: integer("pending_ops").notNull().default(0),
  pendingBytes: bigint("pending_bytes", { mode: "number" }).notNull().default(0),
  deferredFiles: integer("deferred_files").notNull().default(0),
  lastErrorCode: text("last_error_code"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  lastIp: text("last_ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const files = pgTable(
  "files",
  {
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    kind: text("kind").notNull(),
    pathEnc: bytea("path_enc").notNull(),
    pathMac: bytea("path_mac").notNull(),
    headVersionId: text("head_version_id"),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    mtime: bigint("mtime", { mode: "number" }).notNull().default(0),
    deleted: boolean("deleted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.vaultId, t.id] }),
    uniqueIndex("files_live_path")
      .on(t.vaultId, t.pathMac)
      .where(sql`not ${t.deleted}`),
  ],
);

export const fileVersions = pgTable(
  "file_versions",
  {
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    fileId: text("file_id").notNull(),
    contentHashEnc: bytea("content_hash_enc").notNull(),
    blobId: text("blob_id").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    mtime: bigint("mtime", { mode: "number" }).notNull(),
    deviceId: uuid("device_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.id] })],
);

export const journal = pgTable(
  "journal",
  {
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    fileId: text("file_id").notNull(),
    kind: text("kind").notNull(),
    opId: text("op_id"),
    versionId: text("version_id"),
    /** AAD journal ‖ path ‖ vaultId:seq. */
    pathEnc: bytea("path_enc").notNull(),
    contentHashEnc: bytea("content_hash_enc"),
    size: bigint("size", { mode: "number" }),
    mtime: bigint("mtime", { mode: "number" }),
    conflictId: text("conflict_id"),
    deviceId: uuid("device_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.seq] })],
);

export const appliedOps = pgTable(
  "applied_ops",
  {
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    opId: text("op_id").notNull(),
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.opId] })],
);

export const blobs = pgTable(
  "blobs",
  {
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    blobId: text("blob_id").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    storedSize: bigint("stored_size", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.blobId] })],
);

export const uploadSessions = pgTable("upload_sessions", {
  id: uuid("id").primaryKey(),
  vaultId: uuid("vault_id")
    .notNull()
    .references(() => vaults.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").notNull(),
  /** AAD upload_sessions ‖ content_hash ‖ id. */
  contentHashEnc: bytea("content_hash_enc").notNull(),
  blobId: text("blob_id").notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  chunkSize: integer("chunk_size").notNull(),
  salt: bytea("salt").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conflicts = pgTable(
  "conflicts",
  {
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    fileId: text("file_id").notNull(),
    kind: text("kind").notNull(),
    baseVersionId: text("base_version_id"),
    headVersionId: text("head_version_id").notNull(),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.id] })],
);

export const conflictCandidates = pgTable(
  "conflict_candidates",
  {
    vaultId: uuid("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    conflictId: text("conflict_id").notNull(),
    versionId: text("version_id").notNull(),
    deviceId: uuid("device_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.conflictId, t.versionId] })],
);
