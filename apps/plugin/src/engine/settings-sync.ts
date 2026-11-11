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

  constructor(private readonly o: SettingsSyncOptions) {}

  async load(api: Api, fs: VaultFs): Promise<SyncSettings> {
    let effective: SyncSettings;
    try {
      const [vault, device] = await Promise.all([api.vaultSettings(), api.deviceSettings()]);
      const want = toOverride(this.o.local(), vault);
      effective =
        JSON.stringify(want) === JSON.stringify(device.override)
          ? device.effective
          : (await api.setDeviceOverride(want)).effective;
      await fs.saveState(STATE, JSON.stringify({ vault }));
    } catch {
      let vault: SyncSettings | null;
      try {
        const raw = await fs.loadState(STATE);
        vault = raw ? (JSON.parse(raw) as { vault: SyncSettings }).vault : null;
      } catch {
        vault = null;
      }
      effective = effectiveLocally(this.o.local(), vault);
    }
    if (this.last && configChanged(this.last, effective)) this.o.notice(this.o.reloadText);
    this.last = effective;
    return effective;
  }
}
