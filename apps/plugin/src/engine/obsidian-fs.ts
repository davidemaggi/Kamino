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
async function* once(b: Uint8Array): AsyncIterable<Uint8Array> {
  yield b;
}
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
  /** M4: stream failures on existing files; streaming is given up after a few. */
  private streamFailures = 0;
  /** M4: files whose stream failed: read whole from now on. */
  private readonly noStream = new Set<string>();
  private recovered = false;
  private tmpN = 0;

  constructor(
    app: App,
    private readonly pluginDir: string,
    opts: { fetch?: FetchLike | undefined; stateDir?: string } = {},
  ) {
    this.adapter = app.vault.adapter as Adapter;
    this.app = app;
    this.fetchFn =
      "fetch" in opts
        ? opts.fetch
        : typeof fetch === "function"
          ? (u: string) => fetch(u)
          : undefined;
    this.stateDir = opts.stateDir ?? `${pluginDir}/state`;
  }

  private readonly stateDir: string;
  private readonly app: App;

  /** F5: a note open in the editor whose buffer differs from the disk has unsaved edits. */
  private async dirtyInEditor(path: string): Promise<boolean> {
    const open = this.app.workspace
      .getLeavesOfType("markdown")
      .map((l) => l.view as unknown as { file?: { path: string }; editor?: { getValue(): string } })
      .filter((v) => v.file?.path === path && v.editor);
    if (open.length === 0) return false;
    const disk = await this.adapter.read(path).catch(() => null);
    return open.some((v) => v.editor!.getValue() !== disk);
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

  /**
   * M1/M8: after a crash, a file set aside during a replacement goes back if its place is empty;
   * leftover downloads are removed.
   */
  private async recover(): Promise<void> {
    this.recovered = true;
    const tmpDir = `${this.pluginDir}/tmp`;
    if (!(await this.adapter.exists(tmpDir))) return;
    const { files } = await this.adapter.list(tmpDir);
    for (const f of files) {
      if (f.endsWith(".part")) {
        await this.adapter.remove(f).catch(() => {});
        continue;
      }
      if (!f.endsWith(".old")) continue;
      let original: string | null;
      try {
        original = (JSON.parse(await this.adapter.read(`${f}.json`)) as { path: string }).path;
      } catch {
        original = null;
      }
      if (original === null) continue; // no manifest: left alone, nothing is guessed
      if (!(await this.adapter.exists(original))) {
        await this.ensureDir(parentOf(original));
        await this.adapter.rename(f, original).catch(() => {});
      } else if ((await sha256Hex(this.read(f))) === (await sha256Hex(this.read(original)))) {
        await this.adapter.remove(f).catch(() => {});
      } else {
        // I9: something else took its place meanwhile: both kept, the old one next to it.
        await this.adapter.rename(f, await this.freeSibling(original, "recovered")).catch(() => {});
      }
      await this.adapter.remove(`${f}.json`).catch(() => {});
    }
  }

  /** "name (label).ext", or "name (label 2).ext"… not taken yet. */
  private async freeSibling(path: string, label: string): Promise<string> {
    const dot = path.lastIndexOf(".");
    const slash = path.lastIndexOf("/");
    const [base, ext] = dot > slash ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
    for (let n = 1; ; n++) {
      const p = `${base} (${label}${n > 1 ? ` ${n}` : ""})${ext}`;
      if (!(await this.adapter.exists(p))) return p;
    }
  }

  /** I9: recovers an interrupted replacement now (called when the engine is created). */
  async ready(): Promise<void> {
    if (!this.recovered) await this.recover();
  }
  async list(): Promise<FsEntry[]> {
    if (!this.recovered) await this.recover();
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
    if (this.fetchFn && this.readStreams !== false && !this.noStream.has(path)) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        const res = await this.fetchFn(this.adapter.getResourcePath(path));
        if (res.ok && res.body) reader = res.body.getReader();
      } catch {
        reader = null;
      }
      if (reader) {
        this.readStreams = true;
        const size = (await this.adapter.stat(path))?.size;
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            got += value.length;
            yield value;
          }
        }
        if (size === undefined || got === size) return;
        // M4: a short or long stream must never pass for the file: an error, then whole reads.
        this.streamFailed(path);
        throw new Error("stream_size_mismatch");
      }
      // M4: fall back for this file only; give streaming up after repeated failures.
      if (await this.adapter.exists(path)) this.streamFailed(path);
    }
    yield new Uint8Array(await this.adapter.readBinary(path));
  }

  private streamFailed(path: string): void {
    this.noStream.add(path);
    if (++this.streamFailures >= 3) this.readStreams = false;
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
    // F5: never under the user's unsaved edits; the next cycle starts from their content.
    if (expect !== null && (await this.dirtyInEditor(path))) return "changed";
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
        // `all` owns its whole buffer: no extra copy (I4).
        await this.adapter.writeBinary(tmp, all.buffer as ArrayBuffer);
      }
      if (h.digest() !== want) {
        await this.adapter.remove(tmp);
        return "corrupt";
      }
      // Checked again after the (long) download: the user may have changed the file meanwhile.
      if (
        (await this.hashOrNull(path)) !== expect ||
        (expect !== null && (await this.dirtyInEditor(path)))
      ) {
        await this.adapter.remove(tmp);
        return "changed";
      }
      await this.ensureDir(parentOf(path));
      if (expect === null) {
        await this.adapter.rename(tmp, path);
        return "ok";
      }
      // M1: the old file is set aside (never removed first), the new one takes its place, then
      // the old one goes; a crash in between is recovered by `recover()`.
      // I8: a short name (whole paths can exceed 255 characters), and a manifest written first.
      const aside = `${tmpDir}/${(await sha256Hex(once(new TextEncoder().encode(path)))).slice(0, 24)}.old`;
      if (await this.adapter.exists(aside)) await this.adapter.remove(aside);
      await this.adapter.write(`${aside}.json`, JSON.stringify({ path }));
      await this.adapter.rename(path, aside);
      try {
        await this.adapter.rename(tmp, path);
      } catch (e) {
        await this.adapter.rename(aside, path).catch(() => {});
        throw e;
      }
      await this.adapter.remove(aside).catch(() => {});
      await this.adapter.remove(`${aside}.json`).catch(() => {});
      return "ok";
    } catch (e) {
      if (await this.adapter.exists(tmp)) await this.adapter.remove(tmp).catch(() => {});
      throw e;
    }
  }

  async rename(from: string, to: string): Promise<boolean> {
    if (!(await this.adapter.exists(from))) return false;
    // M2: only the case changes. On Windows/macOS `to` "exists" (same file): via a temporary name.
    if (from !== to && from.toLowerCase() === to.toLowerCase()) {
      // I10: on a case-sensitive disk `to` may be another file: never replace it.
      const { files, folders } = await this.adapter.list(parentOf(to));
      if ([...files, ...folders].includes(to)) return false;
      const tmp = `${parentOf(from) ? `${parentOf(from)}/` : ""}.${Date.now()}-${++this.tmpN}.case`;
      await this.adapter.rename(from, tmp);
      await this.adapter.rename(tmp, to);
      return true;
    }
    if (await this.adapter.exists(to)) return false;
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
    return `${this.stateDir}/${name}.json`;
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
