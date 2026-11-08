import { z } from "zod";

export const ErrorCode = z.enum([
  "path_taken",
  "moved_elsewhere",
  "modified_since",
  "blob_missing",
  "path_invalid",
  "path_forbidden",
  "quota_exceeded",
  "file_too_large",
  "vault_read_only",
  "device_revoked",
  "user_blocked",
  "rate_limited",
  "protocol_unsupported",
  "cursor_too_old",
  "hash_mismatch",
  "stale_resolution",
  "pairing_already_claimed",
  "invalid_credentials",
  "totp_invalid",
  "challenge_expired",
  "setup_not_needed",
  "setup_token_invalid",
  "token_invalid",
  "token_expired",
  "password_weak",
  "password_wrong",
  "totp_mandatory",
  "forbidden",
  "unauthorized",
  "not_found",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;
