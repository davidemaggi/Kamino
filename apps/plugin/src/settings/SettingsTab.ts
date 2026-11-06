import { PluginSettingTab, Setting, type App, type Plugin } from "obsidian";
import { APP_CODENAME, APP_VERSION } from "../build-info.js";
import { t } from "../i18n/index.js";

export class SettingsTab extends PluginSettingTab {
  constructor(app: App, plugin: Plugin) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    const m = t().settings;
    containerEl.empty();
    new Setting(containerEl).setName(m.title).setHeading();
    new Setting(containerEl).setName(m.version).setDesc(APP_VERSION);
    new Setting(containerEl).setName(m.release).setDesc(APP_CODENAME);
  }
}
