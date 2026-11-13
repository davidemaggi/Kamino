import { z } from "zod";
import { Level } from "./account.js";
import { Email, Role, Username } from "./auth.js";

/** U-03: aggregates only — no vault, file or folder names anywhere in the admin API. */
export const AdminUserStatus = z.enum(["active", "invited", "blocked", "deleting"]);
export const AdminUser = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string(),
  role: Role,
  status: AdminUserStatus,
  totpEnabled: z.boolean(),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
  quotaBytes: z.number().min(0).nullable(),
  usedBytes: z.number().min(0),
  vaultCount: z.number().int().min(0),
  deviceCount: z.number().int().min(0),
  syncLevel: Level,
  deletionAt: z.string().nullable(),
});
export type AdminUser = z.infer<typeof AdminUser>;
export const AdminUserList = z.array(AdminUser);

/** U-10: the admin never sets another user's password: invitation email or activation link. */
export const CreateUserRequest = z.object({
  username: Username,
  email: Email,
  role: Role,
  delivery: z.enum(["email", "link"]),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;
export const CreateUserResponse = z.object({ user: AdminUser, link: z.string().nullable() });
/**
 * `last_admin`: the server refuses to demote the last *active* admin (not blocked, not being deleted).
 * Creating a user with a username or email already in use → `username_taken` / `email_taken`.
 */
export const UpdateUserRequest = z.object({
  role: Role.optional(),
  quotaBytes: z.number().min(0).nullable().optional(),
});
export type UpdateUserRequest = z.infer<typeof UpdateUserRequest>;
export const ResetLink = z.object({ link: z.string() });
export const DeleteUserRequest = z.object({ confirmUsername: z.string(), sendZip: z.boolean() });
export type DeleteUserRequest = z.infer<typeof DeleteUserRequest>;

/** E-03: where a value comes from; "env" values are locked in the UI. */
export const ConfigSource = z.enum(["env", "ui", "default"]);
export type ConfigSource = z.infer<typeof ConfigSource>;
const field = <T extends z.ZodType>(t: T) => z.object({ value: t, source: ConfigSource });
export const SmtpSecurity = z.enum(["none", "starttls", "tls"]);
export const SystemConfig = z.object({
  registration: field(z.enum(["closed", "open"])),
  defaultQuotaBytes: field(z.number().min(0).nullable()),
  maxRetentionDays: field(z.number().int().min(0).max(90)),
  maxFileBytes: field(z.number().int().min(1)),
  smtp: z.object({
    host: field(z.string()),
    port: field(z.number().int().min(1).max(65535)),
    security: field(SmtpSecurity),
    username: field(z.string()),
    from: field(z.string()),
    allowInvalidCerts: field(z.boolean()),
    /** The password is write-only: the client only knows whether one is set. */
    passwordSet: z.boolean(),
    passwordSource: ConfigSource,
  }),
  smtpConfigured: z.boolean(),
});
export type SystemConfig = z.infer<typeof SystemConfig>;
export const ConfigPatch = z.object({
  registration: z.enum(["closed", "open"]).optional(),
  defaultQuotaBytes: z.number().min(0).nullable().optional(),
  maxRetentionDays: z.number().int().min(0).max(90).optional(),
  maxFileBytes: z.number().int().min(1).optional(),
  smtp: z
    .object({
      host: z.string().optional(),
      port: z.number().int().min(1).max(65535).optional(),
      security: SmtpSecurity.optional(),
      username: z.string().optional(),
      from: z.string().optional(),
      allowInvalidCerts: z.boolean().optional(),
      password: z.string().optional(),
    })
    .optional(),
});
export type ConfigPatch = z.infer<typeof ConfigPatch>;
/** E-04: detailed technical error (never the password). */
export const SmtpTestResult = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type SmtpTestResult = z.infer<typeof SmtpTestResult>;

export const HealthCheck = z.object({
  name: z.enum(["database", "storage", "disk", "jobs", "smtp"]),
  status: z.enum(["ok", "warn", "error", "off"]),
  /** disk: used ratio 0..1; jobs: queued jobs. The UI builds the text. */
  value: z.number().optional(),
});
export type HealthCheck = z.infer<typeof HealthCheck>;
export const SystemHealth = z.object({
  status: z.enum(["ok", "degraded", "down"]),
  version: z.string(),
  codename: z.string(),
  uptimeSeconds: z.number().min(0),
  checks: z.array(HealthCheck),
  totals: z.object({
    users: z.number().int().min(0),
    vaults: z.number().int().min(0),
    devices: z.number().int().min(0),
    storageBytes: z.number().min(0),
    devicesByLevel: z.record(Level, z.number().int().min(0)),
  }),
});
export type SystemHealth = z.infer<typeof SystemHealth>;

export const AuditAction = z.enum([
  "user_created",
  "user_invited",
  "user_blocked",
  "user_unblocked",
  "user_deleted",
  "quota_changed",
  "role_changed",
  "reset_link_created",
  "config_changed",
  "smtp_test",
]);
export const AuditEntry = z.object({
  id: z.string(),
  at: z.string(),
  actor: z.string(),
  action: AuditAction,
  target: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
export const AuditPage = z.object({
  items: z.array(AuditEntry),
  page: z.number().int().min(1),
  pages: z.number().int().min(1),
});
export type AuditPage = z.infer<typeof AuditPage>;
