import { z } from "zod";
import { Email, Lang, Password, Theme } from "./auth.js";

export const ProfilePatch = z.object({
  email: Email.optional(),
  lang: Lang.optional(),
  theme: Theme.optional(),
});
export type ProfilePatch = z.infer<typeof ProfilePatch>;

export const PasswordChange = z.object({ current: z.string().min(1), next: Password });
export type PasswordChange = z.infer<typeof PasswordChange>;

export const TotpSetupInfo = z.object({ secret: z.string(), otpauthUrl: z.string() });
export type TotpSetupInfo = z.infer<typeof TotpSetupInfo>;

export const TotpConfirm = z.object({ code: z.string().regex(/^\d{6}$/) });
export type TotpConfirm = z.infer<typeof TotpConfirm>;

export const RecoveryCodes = z.object({ recoveryCodes: z.array(z.string()).length(10) });
export type RecoveryCodes = z.infer<typeof RecoveryCodes>;

export const PasswordConfirm = z.object({ password: z.string().min(1) });
export type PasswordConfirm = z.infer<typeof PasswordConfirm>;

export const SessionInfo = z.object({
  id: z.string(),
  current: z.boolean(),
  /** "Firefox · macOS": described by the server, never raw user agents. */
  client: z.string(),
  /** Truncated IP, e.g. "192.168.1.x": never a location. */
  ipPrefix: z.string(),
  lastUsedAt: z.string(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;
export const SessionList = z.array(SessionInfo);

export const SecurityEventType = z.enum([
  "login",
  "login_failed",
  "device_linked",
  "password_changed",
  "admin_reset",
  "totp_enabled",
  "totp_disabled",
]);
export type SecurityEventType = z.infer<typeof SecurityEventType>;
export const SecurityEvent = z.object({
  id: z.string(),
  type: SecurityEventType,
  at: z.string(),
  client: z.string().optional(),
});
export type SecurityEvent = z.infer<typeof SecurityEvent>;
export const SecurityLogPage = z.object({
  items: z.array(SecurityEvent),
  page: z.number().int().min(1),
  pages: z.number().int().min(1),
});
export type SecurityLogPage = z.infer<typeof SecurityLogPage>;

export const Level = z.enum(["safe", "working", "attention", "decision", "blocked"]);
export const VaultsSummary = z.object({
  vaults: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      level: Level,
      conflicts: z.number().int().min(0),
    }),
  ),
});
export type VaultsSummary = z.infer<typeof VaultsSummary>;
