import { PLUGIN_ID, PRODUCT_SLUG } from "@kamino/brand";
import { describe, expect, it } from "vitest";
import { ALL_CONFIG, classify, DEFAULT_SETTINGS, globMatch, mergeSettings } from "./exclusions.js";

describe("globMatch", () => {
  it("*, **, ?, classes", () => {
    expect(globMatch("*.md", "a.md")).toBe(true);
    expect(globMatch("*.md", "d/a.md")).toBe(false);
    expect(globMatch("**/*.md", "a.md")).toBe(true);
    expect(globMatch("**/*.md", "d/e/a.md")).toBe(true);
    expect(globMatch("d/**", "d/e/a.md")).toBe(true);
    expect(globMatch("d/**", "d")).toBe(true);
    expect(globMatch("d/**", "dd/a")).toBe(false);
    expect(globMatch("a?.md", "ab.md")).toBe(true);
    expect(globMatch("[ab].md", "b.md")).toBe(true);
    expect(globMatch("[!ab].md", "b.md")).toBe(false);
    expect(globMatch("a.md", "A.md")).toBe(false);
    expect(globMatch("(x)+.md", "(x)+.md")).toBe(true);
    expect(globMatch("{config}/x", "{config}/x")).toBe(true);
    expect(globMatch("[!]", "a")).toBe(false);
    expect(globMatch("a[/]b", "a/b")).toBe(false);
    expect(globMatch("a[!x]b", "a/b")).toBe(false);
    expect(globMatch("d/**", "D/c.md")).toBe(false);
    expect(globMatch("d/**", "D/c.md", true)).toBe(true);
    expect(globMatch("e\u0301.md", "é.md")).toBe(true);
  });
});

describe("classify", () => {
  it("S-10: by default no configuration category is synced", () => {
    for (const p of ["{config}/app.json", "{config}/hotkeys.json", "{config}/plugins/x/main.js"])
      expect(classify(p, DEFAULT_SETTINGS)).toEqual({ excluded: true, reason: "category" });
    expect(classify("notes/a.md", DEFAULT_SETTINGS)).toEqual({
      excluded: false,
      category: "vault",
    });
  });

  it("always excluded, whatever the settings", () => {
    const all = { ...DEFAULT_SETTINGS, patterns: [] };
    for (const p of [
      `{config}/plugins/${PLUGIN_ID}/data.json`,
      "{config}/workspace.json",
      "{config}/workspace-mobile.json",
      "{config}/workspaces.json",
      "{config}/cache/x",
      `notes/a.md.${PRODUCT_SLUG}-tmp`,
    ])
      expect(classify(p, all)).toEqual({ excluded: true, reason: "always" });
  });

  it("config categories (03 §11)", () => {
    const s = mergeSettings(DEFAULT_SETTINGS, {
      config: { ...ALL_CONFIG, plugins: false },
    });
    expect(classify("{config}/app.json", s)).toEqual({ excluded: false, category: "base" });
    expect(classify("{config}/themes/x/theme.css", s)).toEqual({
      excluded: false,
      category: "appearance",
    });
    expect(classify("{config}/hotkeys.json", s)).toEqual({ excluded: false, category: "hotkeys" });
    expect(classify("{config}/community-plugins.json", s)).toEqual({
      excluded: false,
      category: "pluginList",
    });
    expect(classify("{config}/plugins/other/main.js", s)).toEqual({
      excluded: true,
      reason: "category",
    });
    expect(classify("notes/a.md", s)).toEqual({ excluded: false, category: "vault" });
  });

  it("default and device patterns", () => {
    expect(classify(".trash/a.md", DEFAULT_SETTINGS)).toEqual({
      excluded: true,
      reason: "pattern",
    });
    expect(classify("d/.DS_Store", DEFAULT_SETTINGS)).toEqual({
      excluded: true,
      reason: "pattern",
    });
    const device = mergeSettings(DEFAULT_SETTINGS, { patterns: ["big/**"] });
    expect(classify("big/video.mp4", device)).toEqual({ excluded: true, reason: "pattern" });
    expect(classify(".trash/a.md", device)).toEqual({ excluded: false, category: "vault" });
  });
});
