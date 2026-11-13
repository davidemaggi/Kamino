import { z } from "zod";
import { DeviceStatusReport } from "./devices-auth.js";
import { ErrorCode } from "./errors.js";
import { SyncSettings } from "./settings.js";
import { JournalEntry } from "./sync.js";

/** Journal entries per `changes` message (catch-up is paged). */
export const WS_PAGE = 500;

/** 03 §7: the first message, within 5 s; the token never goes in the URL. */
export const Hello = z.object({
  type: z.literal("hello"),
  deviceToken: z.string().min(1).max(200),
  protocol: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }),
  cursor: z.number().int().min(0),
  pluginVersion: z.string().max(50),
  platform: z.string().max(20),
});
export type Hello = z.infer<typeof Hello>;

export const ClientMessage = z.discriminatedUnion("type", [
  Hello,
  z.object({ type: z.literal("ack"), seq: z.number().int().min(0) }),
  DeviceStatusReport.extend({ type: z.literal("status") }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("pong") }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    protocol: z.number().int(),
    head: z.number().int().min(0),
    deviceId: z.string(),
    serverVersion: z.string(),
    codename: z.string(),
  }),
  z.object({
    type: z.literal("changes"),
    entries: z.array(JournalEntry),
    head: z.number().int().min(0),
    hasMore: z.boolean(),
  }),
  z.object({ type: z.literal("device_revoked") }),
  z.object({ type: z.literal("vault_settings_changed"), settings: SyncSettings }),
  /** 03 §10: a new device claimed a pairing of this vault (sent to the vault's devices). */
  z.object({
    type: z.literal("pairing_request"),
    pairingId: z.string(),
    deviceName: z.string(),
    platform: z.string(),
    pluginVersion: z.string(),
    code: z.string().length(4),
    expiresAt: z.string(),
  }),
  /** Approved, denied or cancelled (here or elsewhere): drop the request. */
  z.object({ type: z.literal("pairing_closed"), pairingId: z.string() }),
  /** The link of an open pairing was presented again after its claim. */
  z.object({ type: z.literal("pairing_reused"), pairingId: z.string() }),
  z.object({ type: z.literal("error"), code: ErrorCode, message: z.string() }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("pong") }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
