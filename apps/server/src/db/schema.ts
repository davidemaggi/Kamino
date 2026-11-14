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
  theme: theme("theme").notNull().default("dark"),
  /** Encrypted with k_system, AAD users ‖ totp_secret ‖ id. Set at setup, enabled at confirm. */
  totpSecret: bytea("totp_secret"),
  totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
  totpLastStep: bigint("totp_last_step", { mode: "number" }),
  /** U-09: a reset started by an admin, shown to the user until the password changes. */
  adminResetAt: timestamp("admin_reset_at", { withTimezone: true }),
  deletionScheduledAt: timestamp("deletion_scheduled_at", { withTimezone: true }),
  /** Q-01: per-user limit in bytes; null = the system default (which may itself be none). */
  quotaBytes: bigint("quota_bytes", { mode: "number" }),
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
  /** Null once the vault is deleted: the DEK is destroyed (crypto-shredding, F5). */
  dekWrapped: bytea("dek_wrapped"),
  kekId: text("kek_id").notNull(),
  dekVersion: integer("dek_version").notNull().default(1),
  headSeq: bigint("head_seq", { mode: "number" }).notNull().default(0),
  /** Last journal seq removed by compaction: a cursor below it gets cursor_too_old (03 §6.3). */
  journalFloor: bigint("journal_floor", { mode: "number" }).notNull().default(0),
  /** Time of the newest entry removed by compaction: history can't be rebuilt before it. */
  journalFloorAt: timestamp("journal_floor_at", { withTimezone: true }),
  /** Vault sync settings (S-10), AAD vaults ‖ settings ‖ id; null = the S-10 defaults. */
  settingsEnc: bytea("settings_enc"),
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
  /** Device override of the vault settings, AAD devices ‖ settings_override ‖ id; null = follow. */
  settingsOverrideEnc: bytea("settings_override_enc"),
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
    /** When the tombstone was set: dates the trash entry after the journal is compacted. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
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
    baseVersionId: text("base_version_id"),
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
    /** Path before the entry when it changed it (moves, restores next to a taken path); AAD journal ‖ from_path ‖ vaultId:seq. */
    fromPathEnc: bytea("from_path_enc"),
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
  /** open → completing (claimed by one `complete`) → done (kept until expiry, for repeated calls). */
  state: text("state").notNull().default("open"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
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

/**
 * E-03: settings changed from the admin UI, one row per field ("registration", "smtp.host"…).
 * Secrets (only "smtp.password" today) live in `secret_enc` under k_system, AAD
 * system_config ‖ secret ‖ key; `value` stays null for them.
 */
export const systemConfig = pgTable("system_config", {
  key: text("key").primaryKey(),
  value: jsonb("value"),
  secretEnc: bytea("secret_enc"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * F8: email waiting to be sent. Recipient and parameters (links included) are encrypted with
 * k_system, AAD email_outbox ‖ column ‖ id; only the template and the attempts are in clear.
 */
export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: uuid("id").primaryKey(),
    toEnc: bytea("to_enc").notNull(),
    /** The recipient's account, when there is one: their pending mail goes at deletion (F6). */
    userId: uuid("user_id").references(() => users.id),
    template: text("template").notNull(),
    locale: text("locale").notNull(),
    paramsEnc: bytea("params_enc").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAt: timestamp("next_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("email_outbox_due")
      .on(t.nextAt)
      .where(sql`${t.sentAt} is null`),
  ],
);

/**
 * F6: the ZIP offered to a user being deleted. Encrypted with HKDF(k_system, token): only the
 * link's token (hashed here, sent only to the user's email) can read it. Destroyed at finalize.
 */
export const userExports = pgTable("user_exports", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Null until the ZIP is built. */
  tokenHash: text("token_hash").unique(),
  storedSize: bigint("stored_size", { mode: "number" }),
  readyAt: timestamp("ready_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pairingStatus = pgEnum("pairing_status", [
  "waiting",
  "requested",
  "approved",
  "consumed",
  "denied",
  "cancelled",
]);

/**
 * 03 §10 / F11: one QR or magic-link pairing. Only hashes of the link token, of the claim secret
 * and of the future device token are kept: nothing here lets anyone sign in as a device.
 */
export const pairings = pgTable("pairings", {
  id: uuid("id").primaryKey(),
  vaultId: uuid("vault_id")
    .notNull()
    .references(() => vaults.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** The device that offered it; null = the web app. */
  originDeviceId: uuid("origin_device_id"),
  tokenHash: text("token_hash").notNull().unique(),
  status: pairingStatus("status").notNull().default("waiting"),
  claimId: uuid("claim_id").unique(),
  claimSecretHash: text("claim_secret_hash"),
  /** Hash of the device token derived from the claim secret: the device is created with it. */
  deviceTokenHash: text("device_token_hash"),
  /** { deviceName, platform, pluginVersion, protocolVersion, code } of the claim. */
  request: jsonb("request"),
  deviceId: uuid("device_id"),
  reusedAt: timestamp("reused_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Forced sync (ADR-0019): one request per vault at a time (a new one replaces the old). The
 * source pushes its files, then each target joins again.
 */
export const forceSyncs = pgTable("force_syncs", {
  id: uuid("id").primaryKey(),
  vaultId: uuid("vault_id")
    .notNull()
    .unique()
    .references(() => vaults.id, { onDelete: "cascade" }),
  sourceDeviceId: uuid("source_device_id")
    .notNull()
    .references(() => devices.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sourceDoneAt: timestamp("source_done_at", { withTimezone: true }),
});

export const forceSyncTargets = pgTable(
  "force_sync_targets",
  {
    forceSyncId: uuid("force_sync_id")
      .notNull()
      .references(() => forceSyncs.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    doneAt: timestamp("done_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.forceSyncId, t.deviceId] })],
);
