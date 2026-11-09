import { PLUGIN_ID, PRODUCT_SLUG } from "@kamino/brand";
import { CONFIG_PREFIX } from "./paths.js";

/** Categories of the configuration folder (03 §11). */
export const CONFIG_CATEGORIES = [
  "base",
  "appearance",
  "hotkeys",
  "pluginList",
  "plugins",
] as const;
export type ConfigCategory = (typeof CONFIG_CATEGORIES)[number];

export interface SyncSettings {
  config: Record<ConfigCategory, boolean>;
  /** Glob patterns on canonical paths (S-09). */
  patterns: string[];
}

/** Default exclusions outside the configuration folder (editable). */
export const DEFAULT_PATTERNS = [
  ".trash/**",
  ".git/**",
  "**/.DS_Store",
  "**/Thumbs.db",
  "**/desktop.ini",
];
export const DEFAULT_SETTINGS: SyncSettings = {
  config: { base: true, appearance: true, hotkeys: true, pluginList: true, plugins: true },
  patterns: DEFAULT_PATTERNS,
};

/** Never synced, not even if the settings say so. */
export const ALWAYS_EXCLUDED = [
  `${CONFIG_PREFIX}/plugins/${PLUGIN_ID}/**`,
  `${CONFIG_PREFIX}/workspace.json`,
  `${CONFIG_PREFIX}/workspace-mobile.json`,
  `${CONFIG_PREFIX}/workspaces.json`,
  `${CONFIG_PREFIX}/cache/**`,
  `**/*.${PRODUCT_SLUG}-tmp`,
];

/** Vault defaults ⊕ device override: device values replace the vault ones. */
export function mergeSettings(vault: SyncSettings, device: Partial<SyncSettings>): SyncSettings {
  return {
    config: { ...vault.config, ...device.config },
    patterns: device.patterns ?? vault.patterns,
  };
}

/** `*` (no "/"), `**` (zero or more segments), `?`, `[abc]`, `[!abc]`. Case-sensitive. */
export function globToRegExp(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
        continue;
      }
      re += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (c === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end > 0) {
        let body = pattern.slice(i + 1, end);
        const negated = body.startsWith("!");
        if (negated) body = body.slice(1);
        re += `[${negated ? "^" : ""}${body.replace(/[\\\]^]/g, "\\$&")}]`;
        i = end + 1;
        continue;
      }
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  return new RegExp(`${re}$`, "u");
}

const compiled = new Map<string, RegExp>();
export function globMatch(pattern: string, path: string): boolean {
  let re = compiled.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    compiled.set(pattern, re);
  }
  if (re.test(path)) return true;
  // "dir/**" also covers the folder itself.
  return pattern.endsWith("/**") && globMatch(pattern.slice(0, -3), path);
}

function configCategory(rel: string): ConfigCategory {
  if (rel === "appearance.json" || rel.startsWith("themes/") || rel.startsWith("snippets/"))
    return "appearance";
  if (rel === "hotkeys.json") return "hotkeys";
  if (rel === "community-plugins.json") return "pluginList";
  if (rel.startsWith("plugins/")) return "plugins";
  return "base";
}

export type Classification =
  | { excluded: false; category: ConfigCategory | "vault" }
  | { excluded: true; reason: "always" | "category" | "pattern" };

export function classify(path: string, settings: SyncSettings): Classification {
  if (ALWAYS_EXCLUDED.some((p) => globMatch(p, path))) return { excluded: true, reason: "always" };
  const pattern = settings.patterns.some((p) => globMatch(p, path));
  if (path === CONFIG_PREFIX || path.startsWith(`${CONFIG_PREFIX}/`)) {
    const category = configCategory(path.slice(CONFIG_PREFIX.length + 1));
    if (!settings.config[category]) return { excluded: true, reason: "category" };
    return pattern ? { excluded: true, reason: "pattern" } : { excluded: false, category };
  }
  return pattern ? { excluded: true, reason: "pattern" } : { excluded: false, category: "vault" };
}
