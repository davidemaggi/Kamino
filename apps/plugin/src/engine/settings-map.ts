import { CONFIG_CATEGORIES, DEFAULT_SYNC_SETTINGS, type SyncSettings } from "@kamino/protocol";
import type { ConfigCategory, PluginSettings } from "../settings/model.js";

type ContractConfig = SyncSettings["config"];
type ContractCategory = keyof ContractConfig;

/** Plugin category → contract category (E10). */
const TO_CONTRACT: Record<ConfigCategory, ContractCategory> = {
  core: "base",
  appearance: "appearance",
  hotkeys: "hotkeys",
  enabledPlugins: "pluginList",
  installedPlugins: "plugins",
};

export function categoriesOf(config: ContractConfig): Record<ConfigCategory, boolean> {
  return Object.fromEntries(
    (Object.keys(TO_CONTRACT) as ConfigCategory[]).map((c) => [c, config[TO_CONTRACT[c]]]),
  ) as Record<ConfigCategory, boolean>;
}

/**
 * This device's override: null while it follows the vault and adds no exclusions. Device
 * exclusions are added to the vault's patterns.
 */
export function toOverride(s: PluginSettings, vault: SyncSettings): SyncSettings | null {
  const extra = s.exclusions.filter((p) => !vault.patterns.includes(p));
  if (s.configDir.useVaultDefault && extra.length === 0) return null;
  const config = s.configDir.useVaultDefault
    ? vault.config
    : (Object.fromEntries(CONFIG_CATEGORIES.map((k) => [k, false])) as ContractConfig);
  if (!s.configDir.useVaultDefault)
    for (const c of Object.keys(TO_CONTRACT) as ConfigCategory[])
      config[TO_CONTRACT[c]] = s.configDir.categories[c];
  return { config, patterns: [...vault.patterns, ...extra] };
}

/** Without the server: the override this device would set, over the last known vault defaults. */
export function effectiveLocally(s: PluginSettings, vault: SyncSettings | null): SyncSettings {
  const base = vault ?? DEFAULT_SYNC_SETTINGS;
  return toOverride(s, base) ?? base;
}

/** S-12: a different set of configuration categories only applies after reloading Obsidian. */
export function configChanged(a: SyncSettings, b: SyncSettings): boolean {
  return CONFIG_CATEGORIES.some((k) => a.config[k] !== b.config[k]);
}
