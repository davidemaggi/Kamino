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

/** Forced sync (ADR-0019): the source's files win, the targets join again. */
export const ForceSyncRequest = z
  .object({
    sourceDeviceId: z.string().uuid(),
    targetDeviceIds: z.array(z.string().uuid()).min(1).max(50),
  })
  .refine((r) => !r.targetDeviceIds.includes(r.sourceDeviceId), { path: ["targetDeviceIds"] });
export type ForceSyncRequest = z.infer<typeof ForceSyncRequest>;
const ForceSyncDevice = z.object({ id: z.string(), name: z.string(), done: z.boolean() });
/** The vault's current request; null = none. */
export const ForceSyncState = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    source: ForceSyncDevice,
    targets: z.array(ForceSyncDevice),
  })
  .nullable();
export type ForceSyncState = z.infer<typeof ForceSyncState>;
export const ForceSyncRole = z.enum(["source", "target"]);
export type ForceSyncRole = z.infer<typeof ForceSyncRole>;
/** What the server has for the asking device, asked before each cycle; null = nothing. */
export const ForcedForDevice = z.object({ requestId: z.string(), role: ForceSyncRole }).nullable();
export type ForcedForDevice = z.infer<typeof ForcedForDevice>;
export const ForcedDone = z.object({ role: ForceSyncRole });
/** Bodies are objects, never a bare null. */
export const ForceSyncResponse = z.object({ request: ForceSyncState });
export type ForceSyncResponse = z.infer<typeof ForceSyncResponse>;
export const ForcedResponse = z.object({ forced: ForcedForDevice });
export type ForcedResponse = z.infer<typeof ForcedResponse>;
