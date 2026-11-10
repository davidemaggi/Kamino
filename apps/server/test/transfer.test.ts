import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

  it("expired sessions are swept with their staging", async () => {
    const id = await upload(CONTENT, [0]);
    t.clock.now += 25 * 3_600_000;
    await t.uploads.sweep();
    expect(filesUnder(t.dirs.staging)).toEqual([]);
    expect((await d.call("GET", `${base()}/uploads/${id}`)).statusCode).toBe(404);
  });
});
