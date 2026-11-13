import { z } from "zod";
import { ErrorCode } from "./errors.js";
import { ContentHash } from "./sync.js";

export const DevicePlatform = z.enum(["windows", "macos", "linux", "ios", "android", "unknown"]);
export type DevicePlatform = z.infer<typeof DevicePlatform>;

/** Password and (when enabled) TOTP in one request, as the plugin's ConnectionService does. */
export const DeviceLoginRequest = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1),
  totp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export type DeviceLoginRequest = z.infer<typeof DeviceLoginRequest>;
export const DeviceLoginResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), enrollToken: z.string(), expiresAt: z.string() }),
  z.object({ status: z.literal("totp_required") }),
]);
export type DeviceLoginResponse = z.infer<typeof DeviceLoginResponse>;

export const EnrollVault = z.object({
  id: z.string(),
  name: z.string(),
  fileCount: z.number().int().min(0),
  deviceCount: z.number().int().min(0),
});
export type EnrollVault = z.infer<typeof EnrollVault>;
export const EnrollVaultList = z.object({ vaults: z.array(EnrollVault) });
export const CreateVaultRequest = z.object({ name: z.string().trim().min(1).max(100) });
export const LinkDeviceRequest = z.object({
  name: z.string().trim().min(1).max(100),
  platform: DevicePlatform,
  pluginVersion: z.string().max(32),
  protocolVersion: z.number().int().min(1),
});
export type LinkDeviceRequest = z.infer<typeof LinkDeviceRequest>;
export const LinkDeviceResponse = z.object({
  deviceId: z.string(),
  deviceToken: z.string(),
  vault: z.object({ id: z.string(), name: z.string() }),
});
export type LinkDeviceResponse = z.infer<typeof LinkDeviceResponse>;
export const DeviceRename = z.object({ name: z.string().trim().min(1).max(100) });

export const BlobsCheckRequest = z.object({ hashes: z.array(ContentHash).max(1000) });
export const BlobsCheckResponse = z.object({ missing: z.array(ContentHash) });
export const UploadCreateRequest = z.object({
  contentHash: ContentHash,
  size: z.number().int().min(0),
});
export const UploadSession = z.object({
  uploadId: z.string(),
  chunkSize: z.number().int().min(1),
  expiresAt: z.string(),
});
export type UploadSession = z.infer<typeof UploadSession>;
export const UploadStatus = z.object({
  received: z.array(z.number().int().min(0)),
  expiresAt: z.string(),
});
export const UploadComplete = z.object({ contentHash: ContentHash, size: z.number().int().min(0) });

export const AckRequest = z.object({ seq: z.number().int().min(0) });
export const DeviceStatusReport = z.object({
  pendingOps: z.number().int().min(0).max(2_147_483_647),
  pendingBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  deferredFiles: z.number().int().min(0).max(2_147_483_647),
  lastErrorCode: ErrorCode.optional(),
});
export type DeviceStatusReport = z.infer<typeof DeviceStatusReport>;

/** 03 §10: the new device presents the one-time token of the link (the token is the proof). */
export const PairingClaimRequest = z.object({
  token: z.string().min(1).max(200),
  deviceName: z.string().trim().min(1).max(100),
  platform: DevicePlatform,
  pluginVersion: z.string().max(32),
  protocolVersion: z.number().int().min(1),
});
export type PairingClaimRequest = z.infer<typeof PairingClaimRequest>;
export const PairingClaimResponse = z.object({
  claimId: z.string(),
  /** Polling credential (`Authorization: Claim <claimSecret>`): only the new device knows it. */
  claimSecret: z.string(),
  verificationCode: z.string().length(4),
  expiresAt: z.string(),
});
export type PairingClaimResponse = z.infer<typeof PairingClaimResponse>;
/** The new device's view; the device token is delivered once, then the claim is "consumed". */
export const PairingClaimState = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["pending", "denied", "expired", "consumed"]) }),
  z.object({
    status: z.literal("approved"),
    deviceId: z.string(),
    deviceToken: z.string(),
    username: z.string(),
    vault: z.object({ id: z.string(), name: z.string() }),
  }),
]);
export type PairingClaimState = z.infer<typeof PairingClaimState>;
