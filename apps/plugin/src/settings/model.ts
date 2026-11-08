export type SyncMode = "live" | "periodic" | "manual";
export type ConfigCategory =
  "core" | "appearance" | "hotkeys" | "enabledPlugins" | "installedPlugins";
export const CONFIG_CATEGORIES: readonly ConfigCategory[] = [
  "core",
  "appearance",
  "hotkeys",
  "enabledPlugins",
  "installedPlugins",
];

export interface PluginSettings {
  sync: { mode: SyncMode; liveDebounceSec: number; periodicMinutes: number };
  largeFiles: { wifiOnly: boolean; thresholdMb: number };
  exclusions: string[];
  configDir: { useVaultDefault: boolean; categories: Record<ConfigCategory, boolean> };
}

export const LIMITS = {
  liveDebounceSec: { min: 2, max: 30 },
  periodicMinutes: { min: 1, max: 1440 },
  thresholdMb: { min: 1, max: 10_000 },
} as const;

export function defaultSettings(isMobile: boolean): PluginSettings {
  return {
    sync: { mode: "live", liveDebounceSec: 5, periodicMinutes: 15 },
    largeFiles: { wifiOnly: isMobile, thresholdMb: 10 },
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
  };
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function num(v: unknown, fallback: number, range: { min: number; max: number }): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(v)));
}

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

/** Fills defaults and fixes out-of-range values: an old or broken data.json never breaks loading. */
export function normalizeSettings(raw: unknown, isMobile: boolean): PluginSettings {
  const d = defaultSettings(isMobile);
  const r = obj(raw);
  const sync = obj(r["sync"]);
  const large = obj(r["largeFiles"]);
  const cfg = obj(r["configDir"]);
  const cats = obj(cfg["categories"]);
  const mode = sync["mode"];
  return {
    sync: {
      mode: mode === "live" || mode === "periodic" || mode === "manual" ? mode : d.sync.mode,
      liveDebounceSec: num(sync["liveDebounceSec"], d.sync.liveDebounceSec, LIMITS.liveDebounceSec),
      periodicMinutes: num(sync["periodicMinutes"], d.sync.periodicMinutes, LIMITS.periodicMinutes),
    },
    largeFiles: {
      wifiOnly: bool(large["wifiOnly"], d.largeFiles.wifiOnly),
      thresholdMb: num(large["thresholdMb"], d.largeFiles.thresholdMb, LIMITS.thresholdMb),
    },
    exclusions: Array.isArray(r["exclusions"])
      ? r["exclusions"]
          .filter((x): x is string => typeof x === "string" && validateGlob(x))
          .map((x) => x.trim())
      : d.exclusions,
    configDir: {
      useVaultDefault: bool(cfg["useVaultDefault"], d.configDir.useVaultDefault),
      categories: Object.fromEntries(
        CONFIG_CATEGORIES.map((c) => [c, bool(cats[c], d.configDir.categories[c])]),
      ) as Record<ConfigCategory, boolean>,
    },
  };
}

/** Syntax check of an exclusion glob: not empty, balanced [] and {}, "**" only as a whole path segment. */
export function validateGlob(pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  const stack: string[] = [];
  for (const ch of p) {
    if (ch === "[" || ch === "{") {
      if (stack.at(-1) === "[") return false;
      stack.push(ch);
    } else if (ch === "]" || ch === "}") {
      if (stack.pop() !== (ch === "]" ? "[" : "{")) return false;
    }
  }
  if (stack.length > 0) return false;
  for (const m of p.matchAll(/\*{2,}/g)) {
    if (m[0].length > 2) return false;
    const before = p[m.index - 1];
    const after = p[m.index + 2];
    if ((before !== undefined && before !== "/") || (after !== undefined && after !== "/"))
      return false;
  }
  return true;
}
