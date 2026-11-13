/** Canonical paths (03 §2). Pure: no I/O. */

/** Canonical prefix of the Obsidian configuration folder (03 §11). */
export const CONFIG_PREFIX = "{config}";

export type PathError = "empty" | "empty_segment" | "dot_segment" | "reserved";
export type PathResult = { ok: true; path: string } | { ok: false; reason: PathError };

/** Local path → canonical: "/" separators, no leading/trailing "/", NFC, config folder → "{config}". */
export function normalizePath(raw: string, configDir: string): PathResult {
  const parts = raw.replace(/\\/g, "/").split("/");
  while (parts[0] === "") parts.shift();
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  if (parts.length === 0) return { ok: false, reason: "empty" };
  const out: string[] = [];
  for (const p of parts) {
    if (p === "") return { ok: false, reason: "empty_segment" };
    if (p === "." || p === "..") return { ok: false, reason: "dot_segment" };
    out.push(p.normalize("NFC"));
  }
  if (out[0] === CONFIG_PREFIX) return { ok: false, reason: "reserved" };
  if (out[0] === configDir.normalize("NFC")) out[0] = CONFIG_PREFIX;
  return { ok: true, path: out.join("/") };
}

/** Canonical → local path for this device's configuration folder name. */
export function localPath(canonical: string, configDir: string): string {
  if (canonical === CONFIG_PREFIX) return configDir;
  return canonical.startsWith(`${CONFIG_PREFIX}/`)
    ? `${configDir}${canonical.slice(CONFIG_PREFIX.length)}`
    : canonical;
}

/** True when `path` is already canonical: what the server accepts. */
export function isCanonical(path: string): boolean {
  if (path === CONFIG_PREFIX) return true;
  const body = path.startsWith(`${CONFIG_PREFIX}/`) ? path.slice(CONFIG_PREFIX.length + 1) : path;
  if (body.includes("\\")) return false;
  const r = normalizePath(body, "/");
  return r.ok && r.path === body;
}

/**
 * NFC + Unicode case folding, applied until stable. Deliberately broad ("ß" = "ss"): an extra
 * collision only yields a suffix or a conflict, never a loss (Z5). The server's value is the one that counts.
 */
export function collisionKey(path: string): string {
  let key = path.normalize("NFC");
  for (let i = 0; i < 8; i++) {
    const next = key.toUpperCase().toLowerCase().normalize("NFC");
    if (next === key) return key;
    key = next;
  }
  return key;
}

export type Platform = "windows" | "macos" | "ios" | "android" | "linux";
export type Unrepresentable =
  | "reserved_name"
  | "forbidden_char"
  | "trailing_dot_or_space"
  | "segment_too_long"
  | "path_too_long";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\..*)?$/i;
const FORBIDDEN: Record<Platform, string> = {
  windows: '<>:"|?*',
  android: '<>:"|?*',
  macos: ":",
  ios: ":",
  linux: "",
};

export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

function hasForbidden(segment: string, platform: Platform): boolean {
  for (const ch of segment) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0) return true;
    if (cp < 32 && (platform === "windows" || platform === "android")) return true;
    if (FORBIDDEN[platform].includes(ch)) return true;
  }
  return false;
}

/** Whether a local path can exist on this platform (03 §6.4). Pass the local path, not the canonical one. */
export function isRepresentable(
  path: string,
  platform: Platform,
): { ok: true } | { ok: false; reason: Unrepresentable } {
  if (utf8Length(path) > 4096) return { ok: false, reason: "path_too_long" };
  for (const segment of path.split("/")) {
    if (utf8Length(segment) > 255) return { ok: false, reason: "segment_too_long" };
    if (hasForbidden(segment, platform)) return { ok: false, reason: "forbidden_char" };
    if (platform === "windows") {
      if (WINDOWS_RESERVED.test(segment)) return { ok: false, reason: "reserved_name" };
      if (segment.endsWith(".") || segment.endsWith(" "))
        return { ok: false, reason: "trailing_dot_or_space" };
    }
  }
  return { ok: true };
}

/** "Nota.md" → "Nota (1).md"; ".env" → ".env (1)" (03 §5.3, §9.4). */
export function conflictSiblingPath(path: string, n: number): string {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  return `${dir}${stem} (${n})${ext}`;
}

/** The word in a conflict copy's name, in the user's language (03 §9.3). */
export const CONFLICT_COPY_LABEL = { it: "conflitto", en: "conflict" } as const;

/** "2026-11-13 1530": no ":" so the name is valid on every platform. */
export function conflictStamp(d: Date, utc: boolean): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const [y, mo, da, h, mi] = utc
    ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
  return `${y}-${p(mo)}-${p(da)} ${p(h)}${p(mi)}`;
}

/**
 * "Nota.md" → "Nota (conflitto - iPhone - 2026-11-13 1530).md": the name of the copy that keeps
 * the losing side next to the winner. The device name is made safe for any file system.
 */
export function conflictCopyPath(
  path: string,
  label: string,
  device: string,
  stamp: string,
): string {
  let safe = "";
  for (const ch of device) {
    const cp = ch.codePointAt(0) ?? 0;
    safe += cp < 32 || '/\\:*?"<>|'.includes(ch) ? "-" : ch;
  }
  safe = [...safe.trim()].slice(0, 40).join("").trim() || "?";
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  return `${dir}${stem} (${label} - ${safe} - ${stamp})${ext}`;
}
