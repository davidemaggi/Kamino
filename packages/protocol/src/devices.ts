import { z } from "zod";
import { Level } from "./account.js";

/** D-06: everything the user sees about a device. */
export const Device = z.object({
  id: z.string(),
  vaultId: z.string(),
  vaultName: z.string(),
  name: z.string(),
  platform: z.string(),
  pluginVersion: z.string(),
  lastSeenAt: z.string(),
  lastSyncAt: z.string().nullable(),
  /** Changes behind the vault head. */
  lag: z.number().int().min(0),
  /** Local changes not yet on the server. */
  pending: z.number().int().min(0),
  lastError: z.string().nullable(),
  level: Level,
  revoked: z.boolean(),
});
export type Device = z.infer<typeof Device>;
export const DeviceList = z.array(Device);
export type DeviceList = z.infer<typeof DeviceList>;
export const DevicePatch = z.object({ name: z.string().trim().min(1).max(100) });
