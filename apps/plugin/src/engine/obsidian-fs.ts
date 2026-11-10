import {
  hashing,
  sha256Hex,
  type FsEntry,
  type VaultFs,
  type WriteOutcome,
} from "@kamino/sync-engine";
import type { App, DataAdapter } from "obsidian";

/** `appendBinary` exists from Obsidian 1.12.3 (R-1). */
type Adapter = DataAdapter & {
  appendBinary?: (path: string, data: ArrayBuffer) => Promise<void>;
  trashSystem?: (path: string) => Promise<boolean>;
  trashLocal?: (path: string) => Promise<void>;
};

type FetchLike = (url: string) => Promise<{ ok: boolean; body: ReadableStream<Uint8Array> | null }>;

const copy = (b: Uint8Array): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/**
 * The vault through Obsidian's adapter (E3): reads stream from the resource URL when that works,
 * writes go to a temporary file in the plugin folder (appended piece by piece when possible),
 * are verified against the expected hash, then renamed into place.
 */
export class ObsidianFs implements VaultFs {
  private readonly adapter: Adapter;
  private readonly fetchFn: FetchLike | undefined;
  /** null = not tried yet; false = the resource URL couldn't be streamed. */
  private readStreams: boolean | null = null;
  private tmpN = 0;

  constructor(
    app: App,
    private readonly pluginDir: string,
    opts: { fetch?: FetchLike | undefined } = {
      fetch: typeof fetch === "function" ? (u) => fetch(u) : undefined,
    },
  ) {
    this.adapter = app.vault.adapter as Adapter;
    this.fetchFn = opts.fetch;
  }

  get streaming(): boolean {
    return (
      typeof this.adapter.appendBinary === "function" &&
      this.fetchFn !== undefined &&
      this.readStreams !== false
    );
  }

  private ours(path: string): boolean {
    return path === this.pluginDir || path.startsWith(`${this.pluginDir}/`);
  }

  async list(): Promise<FsEntry[]> {
    const out: FsEntry[] = [];
    const queue = [""];
    while (queue.length > 0) {
      const dir = queue.shift()!;
      const { files, folders } = await this.adapter.list(dir);
      for (const f of folders) {
        if (this.ours(f)) continue;
        out.push({ path: f, kind: "folder", size: 0, mtime: 0 });
        queue.push(f);
      }
      for (const f of files) {
        if (this.ours(f)) continue;
        const st = await this.adapter.stat(f);
        if (st?.type === "file")
          out.push({ path: f, kind: "file", size: st.size, mtime: st.mtime });
      }
    }
    return out;
  }

  async stat(path: string) {
    const st = await this.adapter.stat(path);
    return st ? { size: st.size, mtime: st.mtime, kind: st.type } : null;
  }

  async *read(path: string): AsyncIterable<Uint8Array> {
    if (this.fetchFn && this.readStreams !== false) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        const res = await this.fetchFn(this.adapter.getResourcePath(path));
        if (res.ok && res.body) reader = res.body.getReader();
      } catch {
        reader = null;
      }
      if (reader) {
        this.readStreams = true;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value) yield value;
        }
      }
      this.readStreams = false; // detected once: whole files from now on
    }
    yield new Uint8Array(await this.adapter.readBinary(path));
  }

  private async hashOrNull(path: string): Promise<string | null> {
    if (!(await this.adapter.exists(path))) return null;
    return sha256Hex(this.read(path));
  }

  private async ensureDir(dir: string): Promise<void> {
    if (dir === "" || (await this.adapter.exists(dir))) return;
    await this.ensureDir(parentOf(dir));
    await this.adapter.mkdir(dir);
  }

  async write(
    path: string,
    parts: AsyncIterable<Uint8Array>,
    expect: string | null,
    want: string,
  ): Promise<WriteOutcome> {
    if ((await this.hashOrNull(path)) !== expect) return "changed";
    const tmpDir = `${this.pluginDir}/tmp`;
    await this.ensureDir(tmpDir);
    const tmp = `${tmpDir}/${Date.now()}-${++this.tmpN}.part`;
    const h = hashing(parts);
    try {
      if (typeof this.adapter.appendBinary === "function") {
        await this.adapter.writeBinary(tmp, new ArrayBuffer(0));
        for await (const p of h.parts) await this.adapter.appendBinary(tmp, copy(p));
      } else {
        const chunks: Uint8Array[] = [];
        for await (const p of h.parts) chunks.push(p);
        const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let o = 0;
        for (const c of chunks) {
          all.set(c, o);
          o += c.length;
        }
        await this.adapter.writeBinary(tmp, copy(all));
      }
      if (h.digest() !== want) {
        await this.adapter.remove(tmp);
        return "corrupt";
      }
      // Checked again after the (long) download: the user may have changed the file meanwhile.
      if ((await this.hashOrNull(path)) !== expect) {
        await this.adapter.remove(tmp);
        return "changed";
      }
      await this.ensureDir(parentOf(path));
      if (expect !== null) await this.adapter.remove(path);
      await this.adapter.rename(tmp, path);
      return "ok";
    } catch (e) {
      if (await this.adapter.exists(tmp)) await this.adapter.remove(tmp).catch(() => {});
      throw e;
    }
  }

  async rename(from: string, to: string): Promise<boolean> {
    if (!(await this.adapter.exists(from)) || (await this.adapter.exists(to))) return false;
    await this.ensureDir(parentOf(to));
    await this.adapter.rename(from, to);
    return true;
  }

  /** To the system trash, or Obsidian's `.trash` when there is none (03 §6.4): never deleted. */
  async trash(path: string): Promise<boolean> {
    if (!(await this.adapter.exists(path))) return false;
    if (this.adapter.trashSystem && (await this.adapter.trashSystem(path))) return true;
    if (!this.adapter.trashLocal) return false;
    await this.adapter.trashLocal(path);
    return true;
  }

  async mkdir(path: string): Promise<void> {
    await this.ensureDir(path);
  }

  async rmdirIfEmpty(path: string): Promise<boolean> {
    if (!(await this.adapter.exists(path))) return false;
    const { files, folders } = await this.adapter.list(path);
    if (files.length > 0 || folders.length > 0) return false;
    await this.adapter.rmdir(path, false);
    return true;
  }

  private statePath(name: string): string {
    return `${this.pluginDir}/state/${name}.json`;
  }

  async loadState(name: string): Promise<string | null> {
    const p = this.statePath(name);
    if (await this.adapter.exists(p)) return this.adapter.read(p);
    // A save interrupted between removing the old file and renaming the new one.
    if (await this.adapter.exists(`${p}.tmp`)) return this.adapter.read(`${p}.tmp`);
    return null;
  }

  /** Atomic: written aside, then renamed into place. */
  async saveState(name: string, data: string): Promise<void> {
    const p = this.statePath(name);
    await this.ensureDir(parentOf(p));
    await this.adapter.write(`${p}.tmp`, data);
    if (await this.adapter.exists(p)) await this.adapter.remove(p);
    await this.adapter.rename(`${p}.tmp`, p);
  }
}
