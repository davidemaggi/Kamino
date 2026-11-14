import { localPath, mergeJson3, type ScanItem } from "@kamino/sync-core";
import { sha256Hex } from "./hash.js";
import type { VaultFs } from "./ports.js";

/** JSON configuration files larger than this keep "last write wins" (never read whole). */
export const MAX_MERGE_BYTES = 1_000_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const once = (data: Uint8Array): AsyncIterable<Uint8Array> =>
  (async function* () {
    yield data;
  })();

/**
 * ADR-0020: Obsidian and its plugins keep their JSON configuration in memory and rewrite the whole
 * file from it, so a write after the engine applied another device's version is based on what
 * Obsidian knew, not on what is on disk. Per file the engine wrote this session (an Obsidian
 * session: the plugin loads with it), this remembers what Obsidian knew; when Obsidian writes over
 * the engine's version, the two merge three ways and the result replaces the file.
 */
export class ObsidianView {
  /** Local path → what Obsidian knows, and what the engine last wrote there. */
  private readonly files = new Map<
    string,
    { known: string; written: string | null; hash: string | null }
  >();

  constructor(
    private readonly fs: VaultFs,
    private readonly configDir: string,
  ) {}

  tracks(path: string): boolean {
    return path.startsWith(`${this.configDir}/`) && path.endsWith(".json");
  }

  /** Before the engine replaces a file: the first time, the file is what Obsidian knows. */
  async beforeWrite(path: string): Promise<void> {
    if (!this.tracks(path) || this.files.has(path)) return;
    const known = await this.text(path);
    if (known !== null) this.files.set(path, { known, written: null, hash: null });
  }

  async afterWrite(path: string, ok: boolean): Promise<void> {
    const f = this.files.get(path);
    if (!f) return;
    const written = ok ? await this.text(path) : null;
    if (written === null) {
      // Not written (or unreadable now): what Obsidian knows still matches the disk, or is lost.
      if (f.written === null || ok) this.files.delete(path);
      return;
    }
    f.written = written;
    f.hash = await sha256Hex(once(encoder.encode(written)));
  }

  /**
   * After a scan: files Obsidian rewrote over the engine's version merge with it. The merged
   * content is written to disk and replaces the scanned item. Returns how many files changed.
   */
  async reconcile(
    scan: ScanItem[],
    cached: (path: string, item: ScanItem) => void,
  ): Promise<number> {
    if (this.files.size === 0) return 0;
    let merged = 0;
    const present = new Set<string>();
    for (const item of scan) {
      const path = localPath(item.path, this.configDir);
      present.add(path);
      const f = this.files.get(path);
      if (!f || f.written === null || f.hash === item.hash) continue;
      const ours = await this.text(path);
      this.files.delete(path);
      if (ours === null) continue;
      const result = mergeJson3(f.known, ours, f.written);
      // Obsidian now holds what it wrote, whatever the file becomes.
      if (result === null || result === ours) continue;
      const data = encoder.encode(result);
      const want = await sha256Hex(once(data));
      if ((await this.fs.write(path, once(data), item.hash, want)) !== "ok") continue;
      const st = await this.fs.stat(path);
      if (!st) continue;
      Object.assign(item, { hash: want, size: st.size, mtime: st.mtime });
      cached(path, item);
      this.files.set(path, { known: ours, written: result, hash: want });
      merged++;
    }
    for (const p of [...this.files.keys()]) if (!present.has(p)) this.files.delete(p);
    return merged;
  }

  private async text(path: string): Promise<string | null> {
    const st = await this.fs.stat(path).catch(() => null);
    if (!st || st.kind !== "file" || st.size > MAX_MERGE_BYTES) return null;
    try {
      const parts: Uint8Array[] = [];
      for await (const p of this.fs.read(path)) parts.push(p);
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        all.set(p, at);
        at += p.length;
      }
      return decoder.decode(all);
    } catch {
      return null;
    }
  }
}
