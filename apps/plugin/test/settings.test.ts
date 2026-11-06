import { describe, expect, it } from "vitest";
import { App, moment, PluginSettingTab } from "obsidian";
import { SettingsTab } from "../src/settings/SettingsTab.js";
import { detectLanguage } from "../src/i18n/index.js";
import { APP_CODENAME, APP_VERSION } from "../src/build-info.js";

describe("SettingsTab", () => {
  it("shows version and codename", () => {
    const app = new App();
    const tab = new SettingsTab(app, { app } as never);
    expect(tab).toBeInstanceOf(PluginSettingTab);
    tab.display();
    expect(tab.containerEl.textContent).toContain(APP_VERSION);
    expect(tab.containerEl.textContent).toContain("Ash");
    expect(APP_CODENAME).toBe("Ash");
  });
});

describe("language", () => {
  it.each([
    ["it", "it"],
    ["it-ch", "it"],
    ["en", "en"],
    ["de", "en"],
  ] as const)("moment locale %s -> %s", (locale, expected) => {
    moment.locale(locale);
    expect(detectLanguage()).toBe(expected);
  });

  it("renders Italian copy when locale is it", () => {
    moment.locale("it");
    const app = new App();
    const tab = new SettingsTab(app, { app } as never);
    tab.display();
    expect(tab.containerEl.textContent).toContain("Versione");
    moment.locale("en");
  });
});
