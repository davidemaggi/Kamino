/** One entry of the vault, with a canonical path. */
export interface FsEntry {
  path: string;
  kind: "file" | "folder";
  size: number;
  mtime: number;
}

/** ok = written; changed = the current content was not `expect`; corrupt = data ≠ `want`. */
export type WriteOutcome = "ok" | "changed" | "corrupt";

/**
 * The vault as the engine sees it. Paths are canonical (forward slashes, NFC, relative to the
 * vault root). Implementations: Obsidian (plugin) and memory (tests).
 */
export interface VaultFs {
  /** Large files are read and written in pieces (E3); false = whole files in memory. */
  readonly streaming: boolean;
  list(): Promise<FsEntry[]>;
  stat(path: string): Promise<{ size: number; mtime: number; kind: "file" | "folder" } | null>;
  read(path: string): AsyncIterable<Uint8Array>;
  /**
   * Atomically replaces `path` with `parts` if its current content hash is `expect` (null = must
   * not exist), and only if the data hashes to `want`; never leaves a partial file in place.
   */
  write(
    path: string,
    parts: AsyncIterable<Uint8Array>,
    expect: string | null,
    want: string,
  ): Promise<WriteOutcome>;
  /** false if the source is missing or the target exists. */
  rename(from: string, to: string): Promise<boolean>;
  /** To the trash, never a permanent delete (03 §6.4). */
  trash(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  rmdirIfEmpty(path: string): Promise<boolean>;
  /** The engine's own state, outside the vault; saved atomically. */
  loadState(name: string): Promise<string | null>;
  saveState(name: string, data: string): Promise<void>;
}

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path under /api/v1, e.g. `/vaults/x/commits`. */
  path: string;
  json?: unknown;
  body?: Uint8Array;
  headers?: Record<string, string>;
}
export interface HttpResponse {
  status: number;
  json?: unknown;
  body?: Uint8Array;
  headers?: Record<string, string>;
}
/** Throws only when the server can't be reached; HTTP errors come back as a status. */
export interface Http {
  request(r: HttpRequest): Promise<HttpResponse>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** In [0, 1). */
  random(): number;
}
