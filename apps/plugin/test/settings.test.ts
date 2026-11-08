import { afterEach, describe, expect, it } from "vitest";
import { App, moment, PluginSettingTab } from "obsidian";
import { SettingsTab } from "../src/settings/SettingsTab.js";
import { detectLanguage } from "../src/i18n/index.js";
import { APP_CODENAME, APP_VERSION } from "../src/build-info.js";
import { makeCtx } from "../src/__mocks__/ui-context.js";

describe("SettingsTab", () => {
  it("shows version and codename", () => {
    const app = new App();
    const { ctx, plugin } = makeCtx();
    const tab = new SettingsTab(app, plugin as never, ctx);
    expect(tab).toBeInstanceOf(PluginSettingTab);
    tab.display();
    expect(tab.containerEl.textContent).toContain(APP_VERSION);
    expect(tab.containerEl.textContent).toContain("Ash");
    expect(APP_CODENAME).toBe("Ash");
  });
});

describe("language", () => {
  afterEach(() => {
    moment.locale("en");
  });

  it.each([
    ["it", "it"],
    ["it-ch", "it"],
    ["en", "en"],
    ["de", "en"],
  ] as const)("moment locale %s -> %s", (locale, expected) => {
    moment.locale(locale);
    expect(detectLanguage()).toBe(expected);
  });

  it("renders the copy in the context language", () => {
    for (const [lang, word] of [
      ["it", "Versione"],
      ["en", "Version"],
    ] as const) {
      const { ctx, plugin } = makeCtx({ lang });
      const tab = new SettingsTab(new App(), plugin as never, ctx);
      tab.display();
      expect(tab.containerEl.textContent).toContain(word);
    }
  });
});
