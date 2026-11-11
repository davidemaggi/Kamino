import type { Op } from "@kamino/protocol";
import { MemoryStore } from "@kamino/sync-core";
import { sha256Hex } from "../hash.js";
import type { Http, HttpRequest, HttpResponse } from "../ports.js";

const err = (status: number, code: string): HttpResponse => ({
  status,
  json: { error: { code, message: code, retryable: false } },
});
async function* once(b: Uint8Array): AsyncIterable<Uint8Array> {
  yield b;
}
const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/**
 * The device routes of the server over `MemoryStore` (the arbiter's oracle), for engine tests.
 * One vault ("v"); the device token decides which device commits.
 */
export class FakeServer {
  readonly store = new MemoryStore();
  readonly content = new Map<string, Uint8Array>();
  readonly sessions = new Map<
    string,
    { hash: string; size: number; chunks: Map<number, Uint8Array> }
  >();
  readonly acks = new Map<string, number>();
  readonly statuses: unknown[] = [];
  chunkSize = 4;
  /** Unreachable: every request throws. */
  down = false;
  revoked = false;
  /** Compacted journal: pulls after an older position get 410 cursor_too_old. */
  floor = 0;
  requests = 0;
  private next = 1;

  /** An Http for the device with this id (the token is the device id). */
  http(deviceId: string): Http {
    return {
      request: async (r) => {
        this.requests++;
        if (this.down) throw new Error("unreachable");
        if (r.headers?.authorization !== `Bearer ${deviceId}`) return err(401, "unauthorized");
        if (this.revoked) return err(401, "device_revoked");
        return this.handle(r, deviceId);
      },
    };
  }

  /** Another device's put, straight into the store. */
  async remotePut(
    deviceId: string,
    op: Omit<Extract<Op, { type: "put" }>, "contentHash" | "size" | "type">,
    text: string,
  ) {
    const data = new TextEncoder().encode(text);
    const hash = await sha256Hex(once(data));
    this.content.set(hash, data);
    this.store.blobs.add(hash);
    return this.store.commit(
      [{ ...op, type: "put", contentHash: hash, size: data.length }],
      deviceId,
    );
  }

  private async handle(r: HttpRequest, deviceId: string): Promise<HttpResponse> {
    const [path, query] = r.path.split("?") as [string, string | undefined];
    const m = (re: RegExp) => re.exec(path);
    let g: RegExpExecArray | null;
    if (r.method === "POST" && path === "/vaults/v/blobs/check") {
      const { hashes } = r.json as { hashes: string[] };
      return { status: 200, json: { missing: hashes.filter((h) => !this.store.blobs.has(h)) } };
    }
    if (r.method === "POST" && path === "/vaults/v/uploads") {
      const b = r.json as { contentHash: string; size: number };
      const id = `u${this.next++}`;
      this.sessions.set(id, { hash: b.contentHash, size: b.size, chunks: new Map() });
      return {
        status: 200,
        json: { uploadId: id, chunkSize: this.chunkSize, expiresAt: "2099-01-01T00:00:00Z" },
      };
    }
    if (r.method === "PUT" && (g = m(/^\/vaults\/v\/uploads\/(\w+)\/chunks\/(\d+)$/))) {
      const s = this.sessions.get(g[1]!);
      if (!s) return err(404, "not_found");
      s.chunks.set(Number(g[2]), r.body!.slice());
      return { status: 200, json: { received: [...s.chunks.keys()].sort((a, b) => a - b) } };
    }
    if (r.method === "GET" && (g = m(/^\/vaults\/v\/uploads\/(\w+)$/))) {
      const s = this.sessions.get(g[1]!);
      if (!s) return err(404, "not_found");
      const received = [...s.chunks.keys()].sort((a, b) => a - b);
      return { status: 200, json: { received, expiresAt: "2099-01-01T00:00:00Z" } };
    }
    if (r.method === "POST" && (g = m(/^\/vaults\/v\/uploads\/(\w+)\/complete$/))) {
      const s = this.sessions.get(g[1]!);
      if (!s) return err(404, "not_found");
      const keys = [...s.chunks.keys()].sort((a, b) => a - b);
      const data = concat(keys.map((k) => s.chunks.get(k)!));
      this.sessions.delete(g[1]!);
      if (data.length !== s.size || (await sha256Hex(once(data))) !== s.hash)
        return err(422, "hash_mismatch");
      this.content.set(s.hash, data);
      this.store.blobs.add(s.hash);
      return { status: 200, json: { contentHash: s.hash, size: s.size } };
    }
    if (r.method === "GET" && (g = m(/^\/vaults\/v\/blobs\/(\w+)$/))) {
      const data = this.content.get(g[1]!);
      if (!data) return err(404, "not_found");
      const rm = /^bytes=(\d+)-(\d+)$/.exec(r.headers?.range ?? "");
      if (!rm || data.length === 0) return { status: 200, body: data };
      const start = Number(rm[1]);
      const end = Math.min(data.length, Number(rm[2]) + 1);
      return {
        status: 206,
        body: data.slice(start, end),
        headers: { "content-range": `bytes ${start}-${end - 1}/${data.length}` },
      };
    }
    if (r.method === "POST" && path === "/vaults/v/commits") {
      const { ops } = r.json as { ops: Op[] };
      return { status: 200, json: this.store.commit(ops, deviceId) };
    }
    if (r.method === "GET" && path === "/vaults/v/changes") {
      const after = Number(new URLSearchParams(query).get("after") ?? 0);
      if (after < this.floor) return err(410, "cursor_too_old");
      return { status: 200, json: this.store.changes(after, 50) };
    }
    if (r.method === "GET" && path === "/vaults/v/snapshot")
      return { status: 200, json: this.store.snapshot() };
    if (r.method === "POST" && path === "/vaults/v/ack") {
      this.acks.set(deviceId, (r.json as { seq: number }).seq);
      return { status: 204 };
    }
    if (r.method === "POST" && path === "/vaults/v/status") {
      this.statuses.push(r.json);
      return { status: 204 };
    }
    return err(404, "not_found");
  }

  /** Live files on the server: path → content text. */
  files(): Map<string, string> {
    const out = new Map<string, string>();
    for (const f of this.store.snapshot().files)
      if (f.kind === "file" && f.contentHash)
        out.set(f.path, new TextDecoder().decode(this.content.get(f.contentHash)));
    return out;
  }
}
