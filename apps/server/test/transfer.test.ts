import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseRange } from "../src/routes/transfer.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { linkDevice, user, type TestDevice } from "./helpers/sync.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const CONTENT = Buffer.from("KAMINO-PLAINTEXT-0123456789-xyz"); // 31 bytes → 4 chunks of 8
const octet = { "content-type": "application/octet-stream" };

function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? filesUnder(p) : [p];
    });
  } catch {
    return [];
  }
}

describe("parseRange", () => {
  it("handles the three forms and rejects bad ranges", () => {
    expect(parseRange("bytes=5-20", 31)).toEqual({ start: 5, end: 21 });
    expect(parseRange("bytes=5-", 31)).toEqual({ start: 5, end: 31 });
    expect(parseRange("bytes=-4", 31)).toEqual({ start: 27, end: 31 });
    expect(parseRange("bytes=40-50", 31)).toBeNull();
    expect(parseRange(undefined, 31)).toBeNull();
  });
});

describe.skipIf(dockerUnavailable)("uploads and downloads", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let d: TestDevice;
  let n = 0;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => pg?.stop());
  beforeEach(async () => {
    await t?.close();
    t = await testApp(await pg.createDatabase(`transfer_${++n}`));
    d = await linkDevice(t, await user(t, "mario"));
  });

  const base = () => `/vaults/${d.vaultId}`;
  async function upload(content: Buffer, order: number[], hash = sha(content)) {
    const s = (
      await d.call("POST", `${base()}/uploads`, { contentHash: hash, size: content.length })
    ).json() as { uploadId: string; chunkSize: number };
    for (const i of order) {
      const r = await d.call(
        "PUT",
        `${base()}/uploads/${s.uploadId}/chunks/${i}`,
        content.subarray(i * s.chunkSize, (i + 1) * s.chunkSize),
        octet,
      );
      expect(r.statusCode, `chunk ${i}`).toBe(200);
    }
    return s.uploadId;
  }

  it("chunks out of order and repeated, then complete; blobs/check sees it", async () => {
    const hash = sha(CONTENT);
    expect((await d.call("POST", `${base()}/blobs/check`, { hashes: [hash] })).json()).toEqual({
      missing: [hash],
    });
    const id = await upload(CONTENT, [3, 0, 2, 2, 1]);
    expect((await d.call("GET", `${base()}/uploads/${id}`)).json().received).toEqual([0, 1, 2, 3]);
    expect((await d.call("POST", `${base()}/uploads/${id}/complete`)).json()).toEqual({
      contentHash: hash,
      size: 31,
    });
    expect((await d.call("POST", `${base()}/blobs/check`, { hashes: [hash] })).json()).toEqual({
      missing: [],
    });
  });

  // rc.5 on Android: requestUrl doesn't always send the content type the plugin asked for, and
  // every chunk got 415. A chunk is raw bytes whatever its declared type; a bodyless POST too.
  it("accepts chunks with any content type, and a bodyless POST with any type", async () => {
    const hash = sha(CONTENT);
    const s = (
      await d.call("POST", `${base()}/uploads`, { contentHash: hash, size: CONTENT.length })
    ).json() as { uploadId: string; chunkSize: number };
    const types = [
      "text/plain;charset=UTF-8",
      "application/x-www-form-urlencoded",
      "application/json",
      "application/x-binary",
    ];
    for (const [i, type] of types.entries()) {
      const r = await d.call(
        "PUT",
        `${base()}/uploads/${s.uploadId}/chunks/${i}`,
        CONTENT.subarray(i * s.chunkSize, (i + 1) * s.chunkSize),
        { "content-type": type },
      );
      expect(r.statusCode, type).toBe(200);
    }
    const done = await d.call("POST", `${base()}/uploads/${s.uploadId}/complete`, undefined, {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ contentHash: hash, size: 31 });
  });

  it("downloads whole and by range across segments", async () => {
    const id = await upload(CONTENT, [0, 1, 2, 3]);
    await d.call("POST", `${base()}/uploads/${id}/complete`);
    const whole = await d.call("GET", `${base()}/blobs/${sha(CONTENT)}`);
    expect(whole.statusCode).toBe(200);
    expect(whole.rawPayload.equals(CONTENT)).toBe(true);
    const part = await d.call("GET", `${base()}/blobs/${sha(CONTENT)}`, undefined, {
      range: "bytes=5-20",
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 5-20/31");
    expect(part.rawPayload.equals(CONTENT.subarray(5, 21))).toBe(true);
    expect(
      (await d.call("GET", `${base()}/blobs/${sha(CONTENT)}`, undefined, { range: "bytes=99-" }))
        .statusCode,
    ).toBe(416);
    expect((await d.call("GET", `${base()}/blobs/${"0".repeat(64)}`)).statusCode).toBe(404);
  });

  it("the plaintext never reaches staging or storage", async () => {
    const id = await upload(CONTENT, [0, 1, 2]);
    for (const f of filesUnder(t.dirs.staging))
      expect(readFileSync(f).includes("PLAINTEXT"), f).toBe(false);
    await d.call("PUT", `${base()}/uploads/${id}/chunks/3`, CONTENT.subarray(24), octet);
    await d.call("POST", `${base()}/uploads/${id}/complete`);
    const stored = filesUnder(t.dirs.blobs);
    expect(stored).toHaveLength(1);
    for (const f of stored) expect(readFileSync(f).includes("PLAINTEXT"), f).toBe(false);
  });

  it("hash mismatch discards the session; wrong chunk sizes and big files are refused", async () => {
    const id = await upload(CONTENT, [0, 1, 2, 3], sha(Buffer.from("something else")));
    expect((await d.call("POST", `${base()}/uploads/${id}/complete`)).json().error.code).toBe(
      "hash_mismatch",
    );
    expect((await d.call("GET", `${base()}/uploads/${id}`)).statusCode).toBe(404);
    const s = (
      await d.call("POST", `${base()}/uploads`, { contentHash: sha(CONTENT), size: 31 })
    ).json() as { uploadId: string };
    expect(
      (await d.call("PUT", `${base()}/uploads/${s.uploadId}/chunks/0`, Buffer.from("short"), octet))
        .statusCode,
    ).toBe(400);
    expect(
      (await d.call("PUT", `${base()}/uploads/${s.uploadId}/chunks/9`, Buffer.alloc(8), octet))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await d.call("POST", `${base()}/uploads`, { contentHash: sha(CONTENT), size: 2_000_000 })
      ).json().error.code,
    ).toBe("file_too_large");
  });

  it("complete is single-use: repeats return the result, chunks freeze, concurrent calls agree", async () => {
    const id = await upload(CONTENT, [0, 1, 2, 3]);
    const both = await Promise.all([
      d.call("POST", `${base()}/uploads/${id}/complete`),
      d.call("POST", `${base()}/uploads/${id}/complete`),
    ]);
    // One wins; the other either sees it done or is told to retry. Never a 500.
    for (const r of both) expect([200, 409]).toContain(r.statusCode);
    expect(both.some((r) => r.statusCode === 200)).toBe(true);
    const again = await d.call("POST", `${base()}/uploads/${id}/complete`);
    expect(again.json()).toEqual({ contentHash: sha(CONTENT), size: 31 });
    expect(
      (await d.call("PUT", `${base()}/uploads/${id}/chunks/0`, CONTENT.subarray(0, 8), octet))
        .statusCode,
    ).toBe(409);
    expect(
      (await d.call("GET", `${base()}/blobs/${sha(CONTENT)}`)).rawPayload.equals(CONTENT),
    ).toBe(true);
  });

  it("an existing blob is never rewritten by a second upload of the same content", async () => {
    const first = await upload(CONTENT, [0, 1, 2, 3]);
    await d.call("POST", `${base()}/uploads/${first}/complete`);
    const [file] = filesUnder(t.dirs.blobs);
    const before = readFileSync(file!);
    const second = await upload(CONTENT, [0, 1, 2, 3]);
    expect((await d.call("POST", `${base()}/uploads/${second}/complete`)).statusCode).toBe(200);
    expect(readFileSync(file!).equals(before)).toBe(true);
    expect(filesUnder(t.dirs.staging)).toEqual([]);
  });

  it("a chunk can be re-sent only with the same bytes; malformed ids are not found", async () => {
    const id = await upload(CONTENT, [0]);
    const url = `${base()}/uploads/${id}/chunks/0`;
    expect((await d.call("PUT", url, CONTENT.subarray(0, 8), octet)).statusCode).toBe(200);
    expect((await d.call("PUT", url, Buffer.from("XXXXXXXX"), octet)).statusCode).toBe(409);
    expect((await d.call("GET", `${base()}/uploads/not-a-uuid`)).statusCode).toBe(404);
    expect((await d.call("POST", `${base()}/uploads/../x/complete`)).statusCode).toBe(404);
  });

  it("expired sessions are swept with their staging", async () => {
    const id = await upload(CONTENT, [0]);
    t.clock.now += 25 * 3_600_000;
    await t.uploads.sweep();
    expect(filesUnder(t.dirs.staging)).toEqual([]);
    expect((await d.call("GET", `${base()}/uploads/${id}`)).statusCode).toBe(404);
  });

  it("staging left behind without a session is swept", async () => {
    const live = await upload(CONTENT, [0]);
    mkdirSync(join(t.dirs.staging, "00000000-0000-7000-8000-000000000000"), { recursive: true });
    await t.uploads.sweep();
    expect(readdirSync(t.dirs.staging)).toEqual([live]);
  });
});
