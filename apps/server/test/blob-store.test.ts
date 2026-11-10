import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsBlobStore } from "../src/blobs/fs-store.js";
import { S3BlobStore } from "../src/blobs/s3-store.js";
import { collect, type BlobStore } from "../src/blobs/store.js";
import { dockerUnavailable } from "./helpers/postgres.js";

async function* chunks(...parts: string[]) {
  for (const p of parts) yield Buffer.from(p);
}
const KEY = "0190a1b2-0000-7000-8000-000000000001/abcdef0123";

function contract(name: string, make: () => BlobStore) {
  describe(name, () => {
    it("put, size, ranges, overwrite, delete", async () => {
      const s = make();
      expect(await s.size(KEY)).toBeNull();
      await s.put(KEY, chunks("hello ", "world"));
      expect(await s.size(KEY)).toBe(11);
      expect((await collect(s.getRange(KEY, 0, 11))).toString()).toBe("hello world");
      expect((await collect(s.getRange(KEY, 3, 8))).toString()).toBe("lo wo");
      expect((await collect(s.getRange(KEY, 4, 4))).length).toBe(0);
      await s.put(KEY, chunks("again"));
      expect((await collect(s.getRange(KEY, 0, 5))).toString()).toBe("again");
      await s.delete(KEY);
      expect(await s.size(KEY)).toBeNull();
    });

    it("large blobs (multipart on S3) keep every byte in place", async () => {
      const s = make();
      const mb = 1024 * 1024;
      const big = Buffer.alloc(11 * mb);
      for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 16)) & 255;
      await s.put(
        KEY,
        (async function* () {
          for (let o = 0; o < big.length; o += mb) yield big.subarray(o, o + mb);
        })(),
      );
      expect(await s.size(KEY)).toBe(big.length);
      const from = 5 * mb - 7;
      const got = await collect(s.getRange(KEY, from, from + 2 * mb + 13));
      expect(got.equals(big.subarray(from, from + 2 * mb + 13))).toBe(true);
      await s.delete(KEY);
    }, 120_000);
  });
}

const dir = mkdtempSync(join(tmpdir(), "kamino-blobs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
contract("fs", () => new FsBlobStore(dir));

// S3 contract against SeaweedFS's S3 gateway: MinIO no longer publishes public images (2026).
describe.skipIf(dockerUnavailable)("s3 (SeaweedFS)", () => {
  let container: StartedTestContainer;
  let store: S3BlobStore;
  beforeAll(async () => {
    container = await new GenericContainer("chrislusf/seaweedfs:4.53")
      .withCommand(["server", "-s3", "-dir=/data", "-ip.bind=0.0.0.0"])
      .withExposedPorts(8333)
      .withWaitStrategy(Wait.forHttp("/", 8333).forStatusCodeMatching((c) => c < 500))
      .withStartupTimeout(120_000)
      .start();
    const endpoint = `http://${container.getHost()}:${container.getMappedPort(8333)}`;
    // No identities configured: the gateway accepts any credentials (test only).
    const creds = { accessKeyId: "test", secretAccessKey: "test" };
    await new S3Client({
      region: "us-east-1",
      endpoint,
      forcePathStyle: true,
      credentials: creds,
    }).send(new CreateBucketCommand({ Bucket: "kamino" }));
    store = new S3BlobStore({
      kind: "s3",
      endpoint,
      bucket: "kamino",
      region: "us-east-1",
      forcePathStyle: true,
      ...creds,
    });
  }, 180_000);
  afterAll(async () => container?.stop());
  contract("s3", () => store);
});
