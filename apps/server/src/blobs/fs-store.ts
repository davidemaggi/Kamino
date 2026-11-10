import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BlobStore } from "./store.js";

/** Write to a temp file, fsync, rename, fsync the directory (not on Windows): durable and atomic. */
export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    if (!/^[0-9a-f-]+\/[0-9a-f]+$/.test(key)) throw new Error("invalid blob key");
    return join(this.root, key);
  }

  async put(key: string, parts: AsyncIterable<Uint8Array>): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    const fh = await open(tmp, "w");
    try {
      for await (const p of parts) await fh.write(p);
      await fh.sync();
    } catch (e) {
      await fh.close();
      await rm(tmp, { force: true });
      throw e;
    }
    await fh.close();
    await rename(tmp, target);
    // Windows can't fsync a directory handle (EPERM); NTFS journals the rename itself.
    if (process.platform === "win32") return;
    const dir = await open(dirname(target), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }

  async *getRange(key: string, start: number, endExclusive: number): AsyncIterable<Uint8Array> {
    if (endExclusive <= start) return;
    yield* createReadStream(this.path(key), {
      start,
      end: endExclusive - 1,
    }) as AsyncIterable<Uint8Array>;
  }

  async size(key: string): Promise<number | null> {
    try {
      return (await stat(this.path(key))).size;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
