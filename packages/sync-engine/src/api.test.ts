import { PRODUCT_SLUG } from "@kamino/brand";
import { PROTOCOL_VERSION } from "@kamino/protocol";
import { describe, expect, it } from "vitest";
import { Api, ApiError } from "./api.js";
import { sha256Hex } from "./hash.js";
import { bytes, MemoryFs } from "./memory-fs.js";
import type { Http, HttpRequest, HttpResponse } from "./ports.js";
import { Transfers, type UploadSessions } from "./transfers.js";

const HASH = "a".repeat(64);
const err = (status: number, code: string): HttpResponse => ({
  status,
  json: { error: { code, message: code, retryable: false } },
});

/** Records every request and answers with `handler`. */
class FakeHttp implements Http {
  readonly log: HttpRequest[] = [];
  constructor(public handler: (r: HttpRequest) => HttpResponse | Promise<HttpResponse>) {}
  async request(r: HttpRequest): Promise<HttpResponse> {
    this.log.push(r);
    return this.handler(r);
  }
}

async function* of(...parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const p of parts) yield p;
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
const collect = async (it: AsyncIterable<Uint8Array>) => {
  const parts: Uint8Array[] = [];
  for await (const p of it) parts.push(p);
  return concat(parts);
};

/** A blob server in memory: upload sessions with chunks, and Range downloads. */
class BlobServer {
  readonly sessions = new Map<
    string,
    { hash: string; size: number; chunks: Map<number, Uint8Array> }
  >();
  readonly blobs = new Map<string, Uint8Array>();
  next = 1;
  constructor(readonly chunkSize: number) {}
  handle = async (r: HttpRequest): Promise<HttpResponse> => {
    const m = (re: RegExp) => re.exec(r.path);
    let g: RegExpExecArray | null;
    if (r.method === "POST" && m(/^\/vaults\/v\/uploads$/)) {
      const b = r.json as { contentHash: string; size: number };
      const id = `u${this.next++}`;
      this.sessions.set(id, { hash: b.contentHash, size: b.size, chunks: new Map() });
      return {
        status: 200,
        json: { uploadId: id, chunkSize: this.chunkSize, expiresAt: "2026-11-11T00:00:00Z" },
      };
    }
    if (r.method === "PUT" && (g = m(/^\/vaults\/v\/uploads\/(\w+)\/chunks\/(\d+)$/))) {
      const s = this.sessions.get(g[1]!);
      if (!s) return err(404, "not_found");
      s.chunks.set(Number(g[2]), r.body!);
      return { status: 200, json: { received: [...s.chunks.keys()].sort() } };
    }
    if (r.method === "GET" && (g = m(/^\/vaults\/v\/uploads\/(\w+)$/))) {
      const s = this.sessions.get(g[1]!);
      if (!s) return err(404, "not_found");
      return {
        status: 200,
        json: { received: [...s.chunks.keys()].sort(), expiresAt: "2026-11-11T00:00:00Z" },
      };
    }
    if (r.method === "POST" && (g = m(/^\/vaults\/v\/uploads\/(\w+)\/complete$/))) {
      const s = this.sessions.get(g[1]!);
      if (!s) return err(404, "not_found");
      const keys = [...s.chunks.keys()].sort((a, b) => a - b);
      const data = concat(keys.map((k) => s.chunks.get(k)!));
      if ((await sha256Hex(of(data))) !== s.hash) return err(422, "hash_mismatch");
      this.blobs.set(s.hash, data);
      return { status: 200, json: { contentHash: s.hash, size: s.size } };
    }
    if (r.method === "GET" && (g = m(/^\/vaults\/v\/blobs\/(\w+)$/))) {
      const data = this.blobs.get(g[1]!);
      if (!data) return err(404, "not_found");
      const rm = /^bytes=(\d+)-(\d+)$/.exec(r.headers?.range ?? "");
      // Like the server: no Range, or an empty blob → the whole blob with 200.
      if (!rm || data.length === 0) return { status: 200, body: data };
      const start = Number(rm[1]);
      const end = Math.min(data.length, Number(rm[2]) + 1);
      return {
        status: 206,
        body: data.subarray(start, end),
        headers: { "Content-Range": `bytes ${start}-${end - 1}/${data.length}` },
      };
    }
    return err(404, "not_found");
  };
}

describe("api", () => {
  it("sends the protocol version and the device token", async () => {
    const http = new FakeHttp(() => ({ status: 204 }));
    await new Api(http, () => "tok").ack("v", 7);
    expect(http.log[0]).toMatchObject({
      method: "POST",
      path: "/vaults/v/ack",
      json: { seq: 7 },
      headers: {
        [`${PRODUCT_SLUG}-protocol`]: String(PROTOCOL_VERSION),
        authorization: "Bearer tok",
      },
    });
  });

  it("uses the enrollment token for enrollment routes and none for login", async () => {
    const http = new FakeHttp((r) =>
      r.path === "/devices/login"
        ? { status: 200, json: { status: "ok", enrollToken: "e", expiresAt: "x" } }
        : { status: 200, json: { vaults: [] } },
    );
    const api = new Api(http, () => "tok");
    expect(await api.login("u", "p", "123456")).toEqual({
      status: "ok",
      enrollToken: "e",
      expiresAt: "x",
    });
    expect(http.log[0]!.json).toEqual({ username: "u", password: "p", totp: "123456" });
    expect(http.log[0]!.headers?.authorization).toBeUndefined();
    expect(await api.enrollVaults("e")).toEqual({ vaults: [] });
    expect(http.log[1]!.headers?.authorization).toBe("Bearer e");
  });

  it.each([
    [err(401, "device_revoked"), "revoked"],
    [err(403, "user_blocked"), "blocked"],
    [err(426, "protocol_unsupported"), "protocol"],
    [err(410, "cursor_too_old"), "cursor_too_old"],
    [err(403, "totp_mandatory"), "http"],
    [{ status: 500 }, "http"],
    [{ status: 200, json: { nope: true } }, "http"],
  ] as const)("maps %j to %s", async (res, kind) => {
    const api = new Api(new FakeHttp(() => res), () => "tok");
    const e = await api.changes("v", 0).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).kind).toBe(kind);
    if (res.status >= 400) expect((e as ApiError).status).toBe(res.status);
  });

  it("keeps the code of other errors", async () => {
    const api = new Api(new FakeHttp(() => err(403, "totp_mandatory")), () => null);
    const e = (await api.login("u", "p").catch((x: unknown) => x)) as ApiError;
    expect(e.code).toBe("totp_mandatory");
  });

  it("a network failure is a network error", async () => {
    const api = new Api(
      new FakeHttp(() => {
        throw new Error("offline");
      }),
      () => "tok",
    );
    const e = (await api.snapshot("v").catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.kind).toBe("network");
  });

  it("checks missing blobs in batches of 1000", async () => {
    const http = new FakeHttp((r) => ({
      status: 200,
      json: { missing: (r.json as { hashes: string[] }).hashes.slice(0, 1) },
    }));
    const hashes = Array.from({ length: 1500 }, (_, i) => i.toString(16).padStart(64, "0"));
    const missing = await new Api(http, () => "tok").missing("v", hashes);
    expect(http.log).toHaveLength(2);
    expect(missing).toEqual([hashes[0], hashes[1000]]);
  });
});

describe("transfers", () => {
  const setup = async (content: string, chunkSize: number, sessions: UploadSessions = {}) => {
    const server = new BlobServer(chunkSize);
    const http = new FakeHttp(server.handle);
    const fs = new MemoryFs();
    fs.pieceSize = 3; // pieces never aligned with the chunks
    fs.put("a.md", content);
    const hash = await sha256Hex(of(bytes(content)));
    const saved: UploadSessions[] = [];
    const t = new Transfers(new Api(http, () => "tok"), fs, sessions, async (s) => {
      saved.push(structuredClone(s));
    });
    return { server, http, fs, hash, saved, t };
  };

  it("uploads in chunks of the server's size and forgets the session", async () => {
    const { server, http, hash, saved, t } = await setup("0123456789", 4);
    let n = 0;
    await t.upload("v", "a.md", hash, 10, (b) => (n += b));
    expect(new TextDecoder().decode(server.blobs.get(hash))).toBe("0123456789");
    const chunks = http.log.filter((r) => r.method === "PUT");
    expect(chunks.map((r) => new TextDecoder().decode(r.body))).toEqual(["0123", "4567", "89"]);
    expect(chunks[0]!.headers?.["content-type"]).toBe("application/octet-stream");
    expect(n).toBe(10);
    expect(saved[0]![hash]).toMatchObject({ uploadId: "u1", chunkSize: 4 });
    expect(saved.at(-1)).toEqual({});
  });

  it("resumes a saved session without resending received chunks", async () => {
    const { server, http, hash, fs } = await setup("0123456789", 4);
    server.sessions.set("u9", { hash, size: 10, chunks: new Map([[0, bytes("0123")]]) });
    const t2 = new Transfers(
      new Api(http, () => "tok"),
      fs,
      { [hash]: { uploadId: "u9", chunkSize: 4, size: 10 } },
      async () => {},
    );
    await t2.upload("v", "a.md", hash, 10, () => {});
    expect(http.log.some((r) => r.method === "POST" && r.path === "/vaults/v/uploads")).toBe(false);
    expect(http.log.filter((r) => r.method === "PUT").map((r) => r.path)).toEqual([
      "/vaults/v/uploads/u9/chunks/1",
      "/vaults/v/uploads/u9/chunks/2",
    ]);
    expect(server.blobs.has(hash)).toBe(true);
  });

  it("starts again when the saved session has expired", async () => {
    const { server, http, hash, fs } = await setup("0123456789", 4);
    const t = new Transfers(
      new Api(http, () => "tok"),
      fs,
      { [hash]: { uploadId: "gone", chunkSize: 4, size: 10 } },
      async () => {},
    );
    await t.upload("v", "a.md", hash, 10, () => {});
    expect(server.blobs.has(hash)).toBe(true);
    expect(http.log.filter((r) => r.method === "PUT")).toHaveLength(3);
  });

  it("an empty file is one empty chunk", async () => {
    const { server, http, hash, t } = await setup("", 4);
    await t.upload("v", "a.md", hash, 0, () => {});
    expect(http.log.filter((r) => r.method === "PUT").map((r) => r.body?.length)).toEqual([0]);
    expect(server.blobs.get(hash)?.length).toBe(0);
  });

  it("downloads with Range requests, piece by piece", async () => {
    const { server, http, hash, t } = await setup("0123456789", 4);
    server.blobs.set(hash, bytes("0123456789"));
    t.pieceSize = 4;
    let n = 0;
    const data = await collect(t.download("v", hash, (b) => (n += b)));
    expect(new TextDecoder().decode(data)).toBe("0123456789");
    // The size comes from the first Content-Range.
    expect(http.log.map((r) => r.headers?.range)).toEqual(["bytes=0-3", "bytes=4-7", "bytes=8-11"]);
    expect(n).toBe(10);
  });

  it("downloads an empty blob", async () => {
    const { server, hash, t } = await setup("", 4);
    server.blobs.set(hash, new Uint8Array(0));
    expect((await collect(t.download("v", hash, () => {}))).length).toBe(0);
  });

  it("a download error surfaces as an ApiError", async () => {
    const { t } = await setup("x", 4);
    await expect(collect(t.download("v", HASH, () => {}))).rejects.toBeInstanceOf(ApiError);
  });

  it("a truncated piece is an error", async () => {
    const { server, http, hash, t } = await setup("0123456789", 4);
    server.blobs.set(hash, bytes("0123456789"));
    const handle = server.handle;
    http.handler = async (r) => {
      const res = await handle(r);
      return res.body ? { ...res, body: res.body.subarray(1) } : res;
    };
    await expect(collect(t.download("v", hash, () => {}))).rejects.toBeInstanceOf(ApiError);
  });
});

describe("pairing calls", () => {
  it("the new device claims without a device token and polls with its claim secret", async () => {
    const http = new FakeHttp((r) =>
      r.path === "/pairings/claim"
        ? {
            status: 200,
            json: { claimId: "c", claimSecret: "s", verificationCode: "AB23", expiresAt: "x" },
          }
        : { status: 200, json: { status: "pending" } },
    );
    const api = new Api(http, () => "device-token");
    const r = await api.claim({
      token: "t",
      deviceName: "iPhone",
      platform: "ios",
      pluginVersion: "0.2.0",
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(r.verificationCode).toBe("AB23");
    expect((await api.claimState("c", "s")).status).toBe("pending");
    expect(http.log[0]!.headers?.authorization).toBeUndefined();
    expect(http.log[1]!.headers?.authorization).toBe("Claim s");
  });
});
