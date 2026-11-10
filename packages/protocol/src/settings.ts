import { z } from "zod";

/** Categories of the configuration folder (03 §11, S-10). */
export const CONFIG_CATEGORIES = [
  "base",
  "appearance",
  "hotkeys",
  "pluginList",
  "plugins",
] as const;
export const ConfigCategory = z.enum(CONFIG_CATEGORIES);
export type ConfigCategory = z.infer<typeof ConfigCategory>;

export const SyncSettings = z.object({
  config: z.object({
    base: z.boolean(),
    appearance: z.boolean(),
    hotkeys: z.boolean(),
    pluginList: z.boolean(),
    plugins: z.boolean(),
  }),
  /** Glob patterns on canonical paths (S-09). */
  patterns: z.array(z.string().min(1).max(500)).max(200),
});
export type SyncSettings = z.infer<typeof SyncSettings>;

/** Default exclusions outside the configuration folder (editable). */
export const DEFAULT_PATTERNS = [
  ".trash/**",
  ".git/**",
  "**/.DS_Store",
  "**/Thumbs.db",
  "**/desktop.ini",
];
/** S-10: by default only notes and attachments, no configuration category. */
export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  config: { base: false, appearance: false, hotkeys: false, pluginList: false, plugins: false },
  patterns: DEFAULT_PATTERNS,
};

/** A device follows the vault defaults while `override` is null (S-10). */
export const DeviceSettings = z.object({
  override: SyncSettings.nullable(),
  effective: SyncSettings,
});
export type DeviceSettings = z.infer<typeof DeviceSettings>;
export const DeviceSettingsPut = z.object({ override: SyncSettings.nullable() });

/** fileId and path of journal entries about the vault rather than a file (always `ignorable`). */
export const VAULT_EVENT_ID = "_vault";
