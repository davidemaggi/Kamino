import { describe, expect, it } from "vitest";
import { defaultSettings, normalizeSettings, validateGlob } from "./model.js";

describe("defaultSettings", () => {
  it("live mode, Wi-Fi only on mobile", () => {
    expect(defaultSettings(false)).toEqual({
      sync: { mode: "live", liveDebounceSec: 5, periodicMinutes: 15 },
      largeFiles: { wifiOnly: false, thresholdMb: 10 },
      exclusions: [],
      configDir: {
        useVaultDefault: true,
        categories: {
          core: false,
          appearance: false,
          hotkeys: false,
          enabledPlugins: false,
          installedPlugins: false,
        },
      },
    });
    expect(defaultSettings(true).largeFiles.wifiOnly).toBe(true);
  });
});

describe("normalizeSettings", () => {
  it.each([undefined, null, "garbage", 42, [], { sync: "x" }])("%o -> defaults", (raw) => {
    expect(normalizeSettings(raw, false)).toEqual(defaultSettings(false));
  });

  it("keeps valid values and clamps out-of-range ones", () => {
    const s = normalizeSettings(
      {
        sync: { mode: "periodic", liveDebounceSec: 99, periodicMinutes: 0 },
        largeFiles: { wifiOnly: true, thresholdMb: -3 },
        exclusions: ["Archivio/**", 7, "  ", "[bad"],
        configDir: { useVaultDefault: false, categories: { core: true, hotkeys: "yes" } },
      },
      false,
    );
    expect(s.sync).toEqual({ mode: "periodic", liveDebounceSec: 30, periodicMinutes: 1 });
    expect(s.largeFiles).toEqual({ wifiOnly: true, thresholdMb: 1 });
    expect(s.exclusions).toEqual(["Archivio/**"]);
    expect(s.configDir.useVaultDefault).toBe(false);
    expect(s.configDir.categories).toMatchObject({ core: true, hotkeys: false });
  });

  it("rejects unknown modes", () => {
    expect(normalizeSettings({ sync: { mode: "turbo" } }, false).sync.mode).toBe("live");
  });
});

describe("validateGlob", () => {
  it.each(["*.md", "Archivio/**", "**/tmp/**", "Foto/*.{jpg,png}", "Note [old]/*", "a?.md"])(
    "%s is valid",
    (p) => {
      expect(validateGlob(p)).toBe(true);
    },
  );
  it.each(["", "   ", "[abc", "{a,b", "a]", "x**", "**y/z", "a/***/b"])("%s is invalid", (p) => {
    expect(validateGlob(p)).toBe(false);
  });
});
