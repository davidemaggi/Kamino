// R-1 spike: in-memory bookkeeping of chunked uploads.
// The server never stores file bytes: it only hashes them incrementally, so a
// 500 MB upload costs a few KB of server memory.
import { createHash, randomUUID, type Hash } from "node:crypto";

export interface UploadSession {
  id: string;
  name: string;
  declaredSize: number | null;
  hash: Hash;
  nextIndex: number;
  bytes: number;
  startedAt: number;
}

export interface FinishedUpload {
  id: string;
  name: string;
  sha256: string;
  bytes: number;
  chunks: number;
  ms: number;
  sizeMatches: boolean | null;
}

export class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class UploadStore {
  readonly #sessions = new Map<string, UploadSession>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  start(name: string, declaredSize: number | null): UploadSession {
    const session: UploadSession = {
      id: randomUUID(),
      name,
      declaredSize,
      hash: createHash("sha256"),
      nextIndex: 0,
      bytes: 0,
      startedAt: this.now(),
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  /** Chunks must arrive in order (index 0, 1, 2, ...): the hash is incremental. */
  chunk(id: string, index: number, data: Uint8Array): UploadSession {
    const session = this.#get(id);
    if (index !== session.nextIndex) {
      throw new UploadError(409, `expected chunk ${session.nextIndex}, got ${index}`);
    }
    session.hash.update(data);
    session.bytes += data.byteLength;
    session.nextIndex += 1;
    return session;
  }

  finish(id: string): FinishedUpload {
    const session = this.#get(id);
    this.#sessions.delete(id);
    return {
      id: session.id,
      name: session.name,
      sha256: session.hash.digest("hex"),
      bytes: session.bytes,
      chunks: session.nextIndex,
      ms: this.now() - session.startedAt,
      sizeMatches: session.declaredSize === null ? null : session.declaredSize === session.bytes,
    };
  }

  get size(): number {
    return this.#sessions.size;
  }

  #get(id: string): UploadSession {
    const session = this.#sessions.get(id);
    if (!session) throw new UploadError(404, "unknown upload id");
    return session;
  }
}
