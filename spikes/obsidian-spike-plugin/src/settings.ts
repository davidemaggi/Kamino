import { PluginSettingTab, Setting, type App } from "obsidian";
import type SpikePlugin from "./main.ts";
import { platformLabel } from "./report.ts";

export interface SpikeSettings {
  /** Base URL of spikes/test-server, e.g. http://192.168.1.10:8787 or https://xyz.trycloudflare.com */
  serverUrl: string;
  /** Free label used in result note names, e.g. "iphone13-ios18". */
  deviceLabel: string;
  /** R-5: number of synthetic files to generate. */
  massFileCount: number;
  /** R-5: how many of them go in the folder that will be moved. */
  massMoveCount: number;
}

export const DEFAULT_SETTINGS: SpikeSettings = {
  serverUrl: "http://192.168.1.10:8787",
  deviceLabel: platformLabel(),
  massFileCount: 10_000,
  massMoveCount: 2_000,
};

export class SpikeSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: SpikePlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl)
      .setName("Test server URL")
      .setDesc("Base URL of spikes/test-server (http on LAN, or https via tunnel).")
      .addText((t) =>
        t.setValue(s.serverUrl).onChange(async (v) => {
          s.serverUrl = v.trim().replace(/\/+$/, "");
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Device label")
      .setDesc("Used in result note names, e.g. iphone13-ios18, pixel7-android15, win11.")
      .addText((t) =>
        t.setValue(s.deviceLabel).onChange(async (v) => {
          s.deviceLabel = v.trim() || platformLabel();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl).setName("R-5 synthetic file count").addText((t) =>
      t.setValue(String(s.massFileCount)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isInteger(n) && n > 0) s.massFileCount = n;
        await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl).setName("R-5 files in the folder to move").addText((t) =>
      t.setValue(String(s.massMoveCount)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isInteger(n) && n > 0) s.massMoveCount = n;
        await this.plugin.saveSettings();
      }),
    );
  }
}
