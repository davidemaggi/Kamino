import { DEFAULT_SYNC_SETTINGS } from "@kamino/protocol";
import { classify, normalizePath, type ScanItem } from "@kamino/sync-core";
import { sha256Hex } from "./hash.js";
import type { VaultFs } from "./ports.js";

/** Local path → what the last read found: unchanged size and mtime mean unchanged content. */
export type StatCache = Record<string, { size: number; mtime: number; hash: string }>;

export interface ScanResult {
  files: ScanItem[];
  /** Canonical folder paths (Z9). */
  folders: string[];
  /** Local paths that couldn't be read: shown in the status, retried at the next scan. */
  unreadable: string[];
}

/** Full scan for a sync cycle (03 §8), hashing only what changed (E4). */
export class Scanner {
  constructor(
    private readonly fs: VaultFs,
    private readonly configDir: string,
    readonly cache: StatCache = {},
  ) {}

  async scan(): Promise<ScanResult> {
    const files: ScanItem[] = [];
    const folders: string[] = [];
    const unreadable: string[] = [];
    const seen = new Set<string>();
    for (const e of await this.fs.list()) {
      const n = normalizePath(e.path, this.configDir);
      if (!n.ok) continue;
      // Never synced whatever the settings (plugin data, layout, cache): not even hashed.
      const c = classify(n.path, DEFAULT_SYNC_SETTINGS);
      if (c.excluded && c.reason === "always") continue;
      if (e.kind === "folder") {
        folders.push(n.path);
        continue;
      }
      seen.add(e.path);
      const known = this.cache[e.path];
      let hash = known && known.size === e.size && known.mtime === e.mtime ? known.hash : null;
      if (hash === null) {
        try {
          hash = await sha256Hex(this.fs.read(e.path));
        } catch {
          unreadable.push(e.path);
          delete this.cache[e.path];
          continue;
        }
        this.cache[e.path] = { size: e.size, mtime: e.mtime, hash };
      }
      files.push({ path: n.path, hash, size: e.size, mtime: e.mtime });
    }
    for (const p of Object.keys(this.cache)) if (!seen.has(p)) delete this.cache[p];
    return { files, folders, unreadable };
  }
}
