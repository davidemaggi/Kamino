import { Api, ApiError } from "./api.js";
import type { VaultFs } from "./ports.js";

/** Upload sessions in progress, by content hash: saved so an upload resumes after a restart. */
export type UploadSessions = Record<string, { uploadId: string; chunkSize: number; size: number }>;

/** The local file no longer matches the hash/size being uploaded: the next scan decides. */
export class SourceChanged extends Error {
  constructor() {
    super("source_changed");
    this.name = "SourceChanged";
  }
}

export const DOWNLOAD_PIECE = 4 * 1024 * 1024;

/** Chunked uploads with resume, and downloads in Range pieces (03 §5, C6, C7, E3). */
export class Transfers {
  /** Size of the Range requests of a download. */
  pieceSize = DOWNLOAD_PIECE;

  constructor(
    private readonly api: Api,
    private readonly fs: VaultFs,
    readonly sessions: UploadSessions,
    private readonly saveSessions: (s: UploadSessions) => Promise<void>,
  ) {}

  private async forget(hash: string): Promise<void> {
    if (!(hash in this.sessions)) return;
    delete this.sessions[hash];
    await this.saveSessions(this.sessions);
  }

  /**
   * Uploads `path` (expected to hash to `hash`, `size` bytes) and completes the blob. A saved
   * session is resumed: only the chunks the server hasn't received are sent. The file is read in
   * pieces and never held in memory beyond the current chunk.
   */
  async upload(
    vaultId: string,
    path: string,
    hash: string,
    size: number,
    onBytes: (n: number) => void,
  ): Promise<void> {
    let s = this.sessions[hash];
    let received = new Set<number>();
    if (s && s.size === size) {
      try {
        received = new Set((await this.api.uploadStatus(vaultId, s.uploadId)).received);
      } catch (e) {
        // Expired or unknown: start a new session.
        if (!(e instanceof ApiError && e.kind === "http" && e.status === 404)) throw e;
        s = undefined;
      }
    } else s = undefined;
    if (!s) {
      const c = await this.api.createUpload(vaultId, hash, size);
      s = { uploadId: c.uploadId, chunkSize: c.chunkSize, size };
      this.sessions[hash] = s;
      await this.saveSessions(this.sessions);
    }
    const { uploadId, chunkSize } = s;
    const count = Math.max(1, Math.ceil(size / chunkSize));
    const sizeOf = (i: number) => (i === count - 1 ? size - (count - 1) * chunkSize : chunkSize);

    let index = 0;
    let buf = new Uint8Array(sizeOf(0));
    let filled = 0;
    let total = 0;
    const flush = async () => {
      if (!received.has(index)) await this.api.putChunk(vaultId, uploadId, index, buf);
      onBytes(buf.length);
      index++;
      if (index < count) buf = new Uint8Array(sizeOf(index));
      filled = 0;
    };
    try {
      for await (const piece of this.fs.read(path)) {
        total += piece.length;
        if (total > size) throw new SourceChanged();
        let o = 0;
        while (o < piece.length) {
          const n = Math.min(buf.length - filled, piece.length - o);
          buf.set(piece.subarray(o, o + n), filled);
          filled += n;
          o += n;
          if (filled === buf.length) await flush();
        }
      }
      if (total !== size) throw new SourceChanged();
      // An empty file is one empty chunk.
      if (index < count) await flush();
    } catch (e) {
      if (e instanceof SourceChanged) await this.forget(hash);
      throw e;
    }
    try {
      await this.api.completeUpload(vaultId, uploadId);
    } catch (e) {
      // The server discarded the session: the file changed while it was being read.
      if (e instanceof ApiError && e.code === "hash_mismatch") {
        await this.forget(hash);
        throw new SourceChanged();
      }
      throw e;
    }
    await this.forget(hash);
  }

  /**
   * The plain content of a blob, in Range pieces of `pieceSize`. The size comes from the first
   * response (the write effect doesn't carry it).
   */
  async *download(
    vaultId: string,
    hash: string,
    onBytes: (n: number) => void,
    /** Called with the size once known, before any byte is yielded; may throw to stop. */
    onTotal?: (total: number) => void,
  ): AsyncIterable<Uint8Array> {
    let total = Infinity;
    for (let start = 0; start < total; start += this.pieceSize) {
      const r = await this.api.blobRange(vaultId, hash, start, start + this.pieceSize);
      if (start === 0) onTotal?.(r.total);
      total = r.total;
      if (r.body.length === 0) return;
      onBytes(r.body.length);
      yield r.body;
    }
  }
}
