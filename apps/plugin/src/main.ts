import { DEFAULT_THRESHOLDS, describeStatus } from "@kamino/status";
import { getIconIds, Platform, Plugin } from "obsidian";
import { registerStatusGallery } from "./dev/status-gallery.js";
import { detectLanguage } from "./i18n/index.js";
import { SettingsTab } from "./settings/SettingsTab.js";
import { INITIAL_SNAPSHOT, StatusIndicator } from "./ui/StatusIndicator.js";

export default class SyncPlugin extends Plugin {
  override onload(): void {
    this.addSettingTab(new SettingsTab(this.app, this));

    const lang = detectLanguage();
    const now = () => Date.now();
    const indicator = new StatusIndicator(this, {
      isMobile: Platform.isMobile,
      lang,
      now,
      available: new Set(getIconIds()),
    });
    indicator.mount();
    // Until the sync engine lands (M1) the honest state is "never synced".
    indicator.update(describeStatus(INITIAL_SNAPSHOT, DEFAULT_THRESHOLDS, now()));

    if (__DEV__) registerStatusGallery(this, indicator, { now, lang });
  }
}
