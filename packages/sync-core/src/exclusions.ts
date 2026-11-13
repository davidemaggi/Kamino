import { PLUGIN_ID, PRODUCT_SLUG } from "@kamino/brand";
import { DEFAULT_SYNC_SETTINGS, type ConfigCategory, type SyncSettings } from "@kamino/protocol";
import { CONFIG_PREFIX, collisionKey } from "./paths.js";

/** Categories, settings and defaults are the contract's (03 §11, S-10). */
export {
  CONFIG_CATEGORIES,
  DEFAULT_PATTERNS,
  type ConfigCategory,
  type SyncSettings,
} from "@kamino/protocol";

/** S-10: by default only notes and attachments, no configuration category. */
export const DEFAULT_SETTINGS: SyncSettings = DEFAULT_SYNC_SETTINGS;

/** Every configuration category on (tests, simulator, devices that opt in to everything). */
export const ALL_CONFIG: SyncSettings["config"] = {
  base: true,
  appearance: true,
  hotkeys: true,
  pluginList: true,
  plugins: true,
};

/** The plugin's own folder: its state and its temporary files, never the user's notes. */
const OWN_AREA = `${CONFIG_PREFIX}/plugins/${PLUGIN_ID}/**`;

/** Never synced, not even if the settings say so. */
export const ALWAYS_EXCLUDED = [
  OWN_AREA,
  `${CONFIG_PREFIX}/workspace.json`,
  `${CONFIG_PREFIX}/workspace-mobile.json`,
  `${CONFIG_PREFIX}/workspaces.json`,
  `${CONFIG_PREFIX}/cache/**`,
  `**/*.${PRODUCT_SLUG}-tmp`,
];

/**
 * In the plugin's own folder. A user never moves a note there: a rename to or from it is the
 * plugin's own housekeeping (a file set aside while it is replaced), reported by Obsidian.
 */
export function inOwnArea(path: string): boolean {
  return globMatch(OWN_AREA, path, true);
}

/** Vault defaults ⊕ device override: device values replace the vault ones. */
export function mergeSettings(vault: SyncSettings, device: Partial<SyncSettings>): SyncSettings {
  return {
    config: { ...vault.config, ...device.config },
    patterns: device.patterns ?? vault.patterns,
  };
}

/** `*` (no "/"), `**` (zero or more segments), `?`, `[abc]`, `[!abc]` (never "/"). Case-sensitive. */
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
      const negated = pattern[i + 1] === "!";
      const start = i + (negated ? 2 : 1);
      const end = pattern.indexOf("]", start + 1);
      const body = end > 0 ? pattern.slice(start, end).replaceAll("/", "") : "";
      if (body !== "") {
        const escaped = body.replace(/[\\\]^]/g, "\\$&");
        re += negated ? `[^/${escaped}]` : `[${escaped}]`;
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
/**
 * Patterns are NFC like paths. On case-insensitive file systems both sides are case-folded:
 * "d/**" must also exclude "D/c.md", which is the same file there.
 */
export function globMatch(pattern: string, path: string, caseInsensitive = false): boolean {
  const p = caseInsensitive ? collisionKey(pattern) : pattern.normalize("NFC");
  let re = compiled.get(p);
  if (!re) {
    re = globToRegExp(p);
    compiled.set(p, re);
  }
  if (re.test(caseInsensitive ? collisionKey(path) : path)) return true;
  // "dir/**" also covers the folder itself.
  return pattern.endsWith("/**") && globMatch(pattern.slice(0, -3), path, caseInsensitive);
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

export function classify(
  path: string,
  settings: SyncSettings,
  caseInsensitive = false,
): Classification {
  if (ALWAYS_EXCLUDED.some((p) => globMatch(p, path, caseInsensitive)))
    return { excluded: true, reason: "always" };
  const pattern = settings.patterns.some((p) => globMatch(p, path, caseInsensitive));
  if (path === CONFIG_PREFIX || path.startsWith(`${CONFIG_PREFIX}/`)) {
    const category = configCategory(path.slice(CONFIG_PREFIX.length + 1));
    if (!settings.config[category]) return { excluded: true, reason: "category" };
    return pattern ? { excluded: true, reason: "pattern" } : { excluded: false, category };
  }
  return pattern ? { excluded: true, reason: "pattern" } : { excluded: false, category: "vault" };
}
