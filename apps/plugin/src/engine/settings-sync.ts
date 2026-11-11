import type { SyncSettings } from "@kamino/protocol";
import type { Api, VaultFs } from "@kamino/sync-engine";
import type { PluginSettings } from "../settings/model.js";
import { configChanged, effectiveLocally, toOverride } from "./settings-map.js";

const STATE = "settings";

export interface SettingsSyncOptions {
  /** This device's choices (plugin settings): they decide its override. */
  local: () => PluginSettings;
  notice: (message: string) => void;
  /** S-12: "reload Obsidian to apply". */
  reloadText: string;
}

/**
 * The settings the engine runs with (E10): this device's override is set on the server, the
 * effective settings come back. Offline: the last vault defaults seen plus this device's choices,
 * so a cycle never runs with fewer exclusions than the user set.
 */
export class SettingsSync {
  private last: SyncSettings | null = null;
  /** The vault defaults last seen (server or saved copy). */
  private vault: SyncSettings | null = null;

  /** M10: this device's choices over the last vault defaults, at once (the server confirms later). */
  quick(): SyncSettings | null {
    return this.vault ? effectiveLocally(this.o.local(), this.vault) : null;
  }

  constructor(private readonly o: SettingsSyncOptions) {}

  async load(api: Api, fs: VaultFs): Promise<SyncSettings> {
    let vault: SyncSettings | null = null;
    let effective: SyncSettings;
    try {
      vault = await api.vaultSettings();
      this.vault = vault;
      // I5 (review): saved at once, whatever happens to the device part.
      await fs.saveState(STATE, JSON.stringify({ vault }));
      const device = await api.deviceSettings();
      const want = toOverride(this.o.local(), vault);
      effective =
        JSON.stringify(want) === JSON.stringify(device.override)
          ? device.effective
          : (await api.setDeviceOverride(want)).effective;
    } catch {
      vault ??= await this.cached(fs);
      this.vault = vault;
      // Never the generic defaults: without the vault's own, the engine must wait.
      if (!vault) throw new SettingsUnavailable();
      effective = effectiveLocally(this.o.local(), vault);
    }
    if (this.last && configChanged(this.last, effective)) this.o.notice(this.o.reloadText);
    this.last = effective;
    return effective;
  }

  private async cached(fs: VaultFs): Promise<SyncSettings | null> {
    try {
      const raw = await fs.loadState(STATE);
      return raw ? (JSON.parse(raw) as { vault: SyncSettings }).vault : null;
    } catch {
      return null;
    }
  }
}

/** The vault's settings were never obtained: no cycle may run yet. */
export class SettingsUnavailable extends Error {
  constructor() {
    super("settings_unavailable");
    this.name = "SettingsUnavailable";
  }
}
