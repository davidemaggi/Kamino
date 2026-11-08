import { z } from "zod";
import { Level } from "./account.js";

export const Vault = z.object({
  id: z.string(),
  name: z.string(),
  fileCount: z.number().int().min(0),
  deviceCount: z.number().int().min(0),
  level: Level,
  conflicts: z.number().int().min(0),
  usedBytes: z.number().min(0),
  historyBytes: z.number().min(0),
  trashBytes: z.number().min(0),
  /** H-02: user choice within the admin maximum. */
  retentionDays: z.number().int().min(0).max(90),
  maxRetentionDays: z.number().int().min(0).max(90),
  /** Oldest restorable point in time (ISO). */
  historyFrom: z.string(),
});
export type Vault = z.infer<typeof Vault>;

export const Quota = z.object({
  usedBytes: z.number().min(0),
  limitBytes: z.number().min(0).nullable(),
});
export type Quota = z.infer<typeof Quota>;
export const VaultList = z.object({ vaults: z.array(Vault), quota: Quota });
export type VaultList = z.infer<typeof VaultList>;

export const VaultPatch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  retentionDays: z.number().int().min(0).max(90).optional(),
});
export type VaultPatch = z.infer<typeof VaultPatch>;
/** V-03: deletion is confirmed by typing the vault name. */
export const VaultDelete = z.object({ confirmName: z.string() });

export const PairingOffer = z.object({
  pairingId: z.string(),
  link: z.string(),
  expiresAt: z.string(),
});
export type PairingOffer = z.infer<typeof PairingOffer>;
export const PairingStatus = z.enum([
  "waiting",
  "requested",
  "approved",
  "denied",
  "expired",
  "cancelled",
]);
export const PairingState = z.object({
  status: PairingStatus,
  request: z
    .object({
      deviceName: z.string(),
      platform: z.string(),
      pluginVersion: z.string(),
      code: z.string().length(4),
    })
    .optional(),
});
export type PairingState = z.infer<typeof PairingState>;
