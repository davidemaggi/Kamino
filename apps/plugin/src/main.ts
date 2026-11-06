import { Plugin } from "obsidian";
import { SettingsTab } from "./settings/SettingsTab.js";

export default class SyncPlugin extends Plugin {
  override onload(): void {
    this.addSettingTab(new SettingsTab(this.app, this));
  }
}
