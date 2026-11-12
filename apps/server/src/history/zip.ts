import { localPath } from "@kamino/sync-core";
import { Readable } from "node:stream";
import { ZipFile } from "yazl";
import type { TreeEntry } from "./service.js";

/** The configuration folder name in exports: Obsidian's default, so the ZIP opens as a vault. */
export const EXPORT_CONFIG_DIR = ".obsidian";

/**
 * A ZIP of `tree`, built while it is read: entries are added one after the other and each one
 * pulls its plaintext from `open` only when yazl gets to it, so memory holds about one segment.
 * A read error in any entry (missing blob, storage, crypto, wrong size) destroys the output
 * stream with that error instead of escaping as an uncaught exception; once the consumer goes
 * away (download cancelled), no further blob is read.
 */
export function zipStream(
  tree: Map<string, TreeEntry>,
  open: (blobId: string, size: number) => AsyncIterable<Buffer>,
): Readable {
  const zip = new ZipFile();
  const out = zip.outputStream as Readable;
  let stopped = false;
  let current: Readable | null = null;
  const fail = (e: unknown) => {
    if (stopped) return;
    stopped = true;
    out.destroy(e instanceof Error ? e : new Error("zip entry failed"));
  };
  out.once("close", () => {
    stopped = true;
    current?.destroy();
  });
  zip.on("error", fail);
  const paths = [...tree.keys()].sort();
  for (const p of paths) {
    const e = tree.get(p)!;
    const name = localPath(p, EXPORT_CONFIG_DIR);
    if (e.kind === "folder") zip.addEmptyDirectory(name);
    else {
      const opts = { mtime: new Date(e.mtime > 0 ? e.mtime : Date.now()), size: e.size };
      // Lazy: the blob is opened when yazl starts this entry, not all at once.
      zip.addReadStreamLazy(name, opts, (cb) => {
        const lazy = Readable.from(
          (async function* () {
            if (stopped) return;
            for await (const piece of open(e.blobId, e.size)) {
              if (stopped) return;
              yield piece;
            }
          })(),
          { objectMode: false, highWaterMark: 0 },
        );
        lazy.on("error", fail);
        current = lazy;
        cb(null, lazy);
      });
    }
  }
  zip.end();
  return out;
}

/** "vault-2026-11-11.zip": never the vault's name, which would end up in headers and logs. */
export function zipFileName(at: Date | null, now: Date): string {
  return `vault-${(at ?? now).toISOString().slice(0, 10)}.zip`;
}
