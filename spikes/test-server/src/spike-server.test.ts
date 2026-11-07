import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { EventFeed } from "./feed.ts";
import { UploadError, UploadStore } from "./uploads.ts";

test("chunked upload hash equals the hash of the whole payload", () => {
  const payload = new Uint8Array(10 * 1024 + 7).map((_, i) => (i * 31) % 256);
  const store = new UploadStore();
  const { id } = store.start("file.bin", payload.byteLength);
  const chunk = 4096;
  for (let i = 0; i * chunk < payload.byteLength; i++) {
    store.chunk(id, i, payload.subarray(i * chunk, (i + 1) * chunk));
  }
  const done = store.finish(id);
  assert.equal(done.sha256, createHash("sha256").update(payload).digest("hex"));
  assert.equal(done.bytes, payload.byteLength);
  assert.equal(done.chunks, 3);
  assert.equal(done.sizeMatches, true);
  assert.equal(store.size, 0);
});

test("out-of-order chunks are rejected with 409", () => {
  const store = new UploadStore();
  const { id } = store.start("x", null);
  assert.throws(
    () => store.chunk(id, 1, new Uint8Array(1)),
    (e: unknown) => e instanceof UploadError && e.status === 409,
  );
});

test("unknown upload id is rejected with 404", () => {
  const store = new UploadStore();
  assert.throws(
    () => store.finish("nope"),
    (e: unknown) => e instanceof UploadError && e.status === 404,
  );
});

test("feed catch-up returns events after the given seq", () => {
  const feed = new EventFeed(10);
  for (let i = 0; i < 5; i++) feed.next();
  const { events, truncated } = feed.since(2);
  assert.deepEqual(
    events.map((e) => e.seq),
    [3, 4, 5],
  );
  assert.equal(truncated, false);
});

test("feed catch-up flags truncation when history is exceeded", () => {
  const feed = new EventFeed(3);
  for (let i = 0; i < 10; i++) feed.next();
  const { events, truncated } = feed.since(2);
  assert.deepEqual(
    events.map((e) => e.seq),
    [8, 9, 10],
  );
  assert.equal(truncated, true);
  assert.equal(feed.since(7).truncated, false);
});
