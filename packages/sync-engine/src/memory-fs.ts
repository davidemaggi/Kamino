import { sha256Hex, hashing } from "./hash.js";
import type { FsEntry, VaultFs, WriteOutcome } from "./ports.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
export const bytes = (s: string): Uint8Array => enc.encode(s);

async function* once(b: Uint8Array): AsyncIterable<Uint8Array> {
  yield b;
}

const parentsOf = (path: string): string[] => {
  const segs = path.split("/");
  return segs.slice(0, -1).map((_, i) => segs.slice(0, i + 1).join("/"));
};

/** A vault in memory: tests and the server integration tests. */
export class MemoryFs implements VaultFs {
  readonly streaming = true;
  readonly files = new Map<string, { data: Uint8Array; mtime: number }>();
  readonly folders = new Set<string>();
  readonly state = new Map<string, string>();
  readonly trashed: string[] = [];
  /** Size of the pieces `read` yields. */
  pieceSize = 1 << 20;
  private tick = 1;

  constructor(private readonly clock: () => number = () => this.tick++) {}

  put(path: string, text: string | Uint8Array): void {
    for (const p of parentsOf(path)) this.folders.add(p);
    this.files.set(path, {
      data: typeof text === "string" ? bytes(text) : text,
      mtime: this.clock(),
    });
  }
  text(path: string): string | undefined {
    const f = this.files.get(path);
    return f ? dec.decode(f.data) : undefined;
  }
  remove(path: string): void {
    this.files.delete(path);
  }

  async list(): Promise<FsEntry[]> {
    return [
      ...[...this.folders].map((path) => ({ path, kind: "folder" as const, size: 0, mtime: 0 })),
      ...[...this.files].map(([path, f]) => ({
        path,
        kind: "file" as const,
        size: f.data.length,
        mtime: f.mtime,
      })),
    ];
  }

  async stat(path: string) {
    const f = this.files.get(path);
    if (f) return { size: f.data.length, mtime: f.mtime, kind: "file" as const };
    return this.folders.has(path) ? { size: 0, mtime: 0, kind: "folder" as const } : null;
  }

  async *read(path: string): AsyncIterable<Uint8Array> {
    const f = this.files.get(path);
    if (!f) throw new Error("not found");
    for (let i = 0; i < f.data.length; i += this.pieceSize)
      yield f.data.subarray(i, i + this.pieceSize);
    if (f.data.length === 0) yield new Uint8Array(0);
  }

  async write(
    path: string,
    parts: AsyncIterable<Uint8Array>,
    expect: string | null,
    want: string,
  ): Promise<WriteOutcome> {
    const cur = this.files.get(path);
    const curHash = cur ? await sha256Hex(once(cur.data)) : null;
    if (curHash !== expect) return "changed";
    const h = hashing(parts);
    const chunks: Uint8Array[] = [];
    for await (const p of h.parts) chunks.push(p);
    if (h.digest() !== want) return "corrupt";
    // Checked again after the (async) download: the file may have changed meanwhile.
    const now = this.files.get(path);
    if ((now ? await sha256Hex(once(now.data)) : null) !== expect) return "changed";
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const data = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      data.set(c, o);
      o += c.length;
    }
    this.put(path, data);
    return "ok";
  }

  async rename(from: string, to: string): Promise<boolean> {
    if ((await this.stat(to)) !== null) return false;
    const f = this.files.get(from);
    if (f) {
      this.files.delete(from);
      for (const p of parentsOf(to)) this.folders.add(p);
      this.files.set(to, f);
      return true;
    }
    if (!this.folders.has(from)) return false;
    // A folder moves with everything under it.
    for (const [p, v] of [...this.files])
      if (p.startsWith(`${from}/`)) {
        this.files.delete(p);
        this.files.set(to + p.slice(from.length), v);
      }
    for (const d of [...this.folders])
      if (d === from || d.startsWith(`${from}/`)) {
        this.folders.delete(d);
        this.folders.add(to + d.slice(from.length));
      }
    for (const p of parentsOf(to)) this.folders.add(p);
    return true;
  }

  async trash(path: string): Promise<boolean> {
    if (!this.files.delete(path)) return false;
    this.trashed.push(path);
    return true;
  }

  async mkdir(path: string): Promise<void> {
    for (const p of [...parentsOf(path), path]) this.folders.add(p);
  }

  async rmdirIfEmpty(path: string): Promise<boolean> {
    const busy =
      [...this.files.keys()].some((p) => p.startsWith(`${path}/`)) ||
      [...this.folders].some((d) => d.startsWith(`${path}/`));
    if (busy || !this.folders.has(path)) return false;
    this.folders.delete(path);
    return true;
  }

  async loadState(name: string): Promise<string | null> {
    return this.state.get(name) ?? null;
  }
  async saveState(name: string, data: string): Promise<void> {
    this.state.set(name, data);
  }
}
