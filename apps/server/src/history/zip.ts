import { localPath } from "@kamino/sync-core";
import { Readable } from "node:stream";
import { ZipFile } from "yazl";
import type { TreeEntry } from "./service.js";

/** The configuration folder name in exports: Obsidian's default, so the ZIP opens as a vault. */
export const EXPORT_CONFIG_DIR = ".obsidian";

export interface ZipPart {
  /** Folder of this tree inside the ZIP ("" = the root). */
  folder: string;
  tree: Map<string, TreeEntry>;
  open: (blobId: string, size: number) => AsyncIterable<Buffer>;
}

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
  return zipParts([{ folder: "", tree, open }]);
}

/** Several trees in one ZIP, each under its folder (the export of a user being deleted, F6). */
export function zipParts(parts: ZipPart[]): Readable {
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
  for (const { folder, tree, open } of parts) {
    const prefix = folder === "" ? "" : `${folder}/`;
    if (prefix !== "") zip.addEmptyDirectory(folder);
    for (const p of [...tree.keys()].sort()) {
      const e = tree.get(p)!;
      const name = prefix + localPath(p, EXPORT_CONFIG_DIR);
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
  }
  zip.end();
  return out;
}

/** A vault name usable as a folder on every OS; duplicates get " (2)", " (3)"… */
export function folderNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const base =
      [...raw]
        .map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? "_" : c))
        .join("")
        .replace(/^[.\s]+|[.\s]+$/g, "")
        .slice(0, 100) || "vault";
    const key = base.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

/** "vault-2026-11-11.zip": never the vault's name, which would end up in headers and logs. */
export function zipFileName(at: Date | null, now: Date): string {
  return `vault-${(at ?? now).toISOString().slice(0, 10)}.zip`;
}
