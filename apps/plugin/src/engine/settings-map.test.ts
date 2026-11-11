import { DEFAULT_SYNC_SETTINGS, type SyncSettings } from "@kamino/protocol";
import { describe, expect, it } from "vitest";
import { defaultSettings } from "../settings/model.js";
import { categoriesOf, configChanged, effectiveLocally, toOverride } from "./settings-map.js";

const vault: SyncSettings = {
  config: { base: true, appearance: false, hotkeys: false, pluginList: false, plugins: false },
  patterns: [".trash/**"],
};

describe("settings map", () => {
  it("following the vault with no exclusions of its own = no override", () => {
    expect(toOverride(defaultSettings(false), vault)).toBeNull();
  });

  it("maps the plugin's categories onto the contract's", () => {
    const s = defaultSettings(false);
    s.configDir.useVaultDefault = false;
    s.configDir.categories = {
      core: true,
      appearance: true,
      hotkeys: false,
      enabledPlugins: true,
      installedPlugins: false,
    };
    expect(toOverride(s, vault)).toEqual({
      config: { base: true, appearance: true, hotkeys: false, pluginList: true, plugins: false },
      patterns: [".trash/**"],
    });
    expect(categoriesOf(vault.config)).toEqual({
      core: true,
      appearance: false,
      hotkeys: false,
      enabledPlugins: false,
      installedPlugins: false,
    });
  });

  it("device exclusions add to the vault's patterns", () => {
    const s = defaultSettings(false);
    s.exclusions = ["private/**", ".trash/**"];
    expect(toOverride(s, vault)).toEqual({
      config: vault.config,
      patterns: [".trash/**", "private/**"],
    });
  });

  it("works out the settings offline from the last known vault defaults", () => {
    const s = defaultSettings(false);
    s.exclusions = ["private/**"];
    expect(effectiveLocally(s, null).patterns).toEqual([
      ...DEFAULT_SYNC_SETTINGS.patterns,
      "private/**",
    ]);
    expect(effectiveLocally(defaultSettings(false), vault)).toEqual(vault);
  });

  it("tells when the configuration categories change (reload needed, S-12)", () => {
    expect(configChanged(vault, vault)).toBe(false);
    expect(configChanged(vault, { ...vault, patterns: [] })).toBe(false);
    expect(configChanged(vault, { ...vault, config: { ...vault.config, hotkeys: true } })).toBe(
      true,
    );
  });
});
