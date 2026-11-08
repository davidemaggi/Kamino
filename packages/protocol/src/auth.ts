import { z } from "zod";

/** Minimum password length (client and server). */
export const PASSWORD_MIN = 12;

export const Password = z.string().min(PASSWORD_MIN).max(1024);
export const Username = z.string().trim().min(1).max(64);
export const Email = z.email().max(254);
export const Lang = z.enum(["it", "en"]);
export type Lang = z.infer<typeof Lang>;
export const Theme = z.enum(["light", "dark", "system"]);
export type Theme = z.infer<typeof Theme>;
export const Role = z.enum(["user", "admin"]);
export type Role = z.infer<typeof Role>;

export const Me = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string(),
  role: Role,
  lang: Lang,
  theme: Theme,
  totpEnabled: z.boolean(),
  /** Admins without TOTP must configure it before anything else (U-07). */
  totpSetupRequired: z.boolean(),
  /** ISO date of a password reset started by an admin, shown once to the user (U-09). */
  adminResetAt: z.string().nullable(),
});
export type Me = z.infer<typeof Me>;

export const SetupStatus = z.object({ needed: z.boolean() });
export type SetupStatus = z.infer<typeof SetupStatus>;

export const SetupRequest = z.object({
  token: z.string().min(1),
  username: Username,
  email: Email,
  password: Password,
});
export type SetupRequest = z.infer<typeof SetupRequest>;

export const LoginRequest = z.object({ username: Username, password: z.string().min(1) });
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), me: Me }),
  z.object({ status: z.literal("totp_required"), challengeId: z.string() }),
]);
export type LoginResponse = z.infer<typeof LoginResponse>;

/** TOTP code (6 digits) or a recovery code. */
export const TotpLoginRequest = z.object({
  challengeId: z.string(),
  code: z.string().trim().min(6).max(32),
});
export type TotpLoginRequest = z.infer<typeof TotpLoginRequest>;

export const ForgotRequest = z.object({ email: Email });
export type ForgotRequest = z.infer<typeof ForgotRequest>;
/** Same answer whether the email exists or not; smtp=false means "ask the admin". */
export const ForgotResponse = z.object({ smtp: z.boolean() });
export type ForgotResponse = z.infer<typeof ForgotResponse>;

export const ResetRequest = z.object({ token: z.string().min(1), password: Password });
export type ResetRequest = z.infer<typeof ResetRequest>;

export const InviteInfo = z.object({ username: z.string(), email: z.string() });
export type InviteInfo = z.infer<typeof InviteInfo>;
export const InviteAccept = z.object({ password: Password });
export type InviteAccept = z.infer<typeof InviteAccept>;
