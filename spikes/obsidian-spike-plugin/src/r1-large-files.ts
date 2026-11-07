// R-1: large files on mobile. Measures readBinary / incremental SHA-256 /
// 4 MiB chunked upload / writeBinary on 50-200-500 MB files, and probes the
// alternatives that avoid holding the whole file in memory: ranged/streamed
// reads through the resource URL, and appendBinary for chunked writes.
import { sha256 } from "@noble/hashes/sha2.js";
import { normalizePath, requestUrl, type App } from "obsidian";
import { errorText, heapMb, Report } from "./report.ts";
import { HeapPeak, MiB, ms, pick, Progress, rate, toHex, yieldToUi } from "./util.ts";

export const R1_DIR = "kamino-spike-large";
const CHUNK = 4 * MiB;
export const R1_SIZES_MB = [50, 200, 500];

interface Ctx {
  app: App;
  serverUrl: string;
  device: string;
}

// ---------------------------------------------------------------------------
// Probe: which adapter APIs exist on this platform?
// ---------------------------------------------------------------------------

function methodNames(obj: object): string[] {
  const names = new Set<string>();
  for (
    let p: object | null = obj;
    p && p !== Object.prototype;
    p = Object.getPrototypeOf(p) as object | null
  ) {
    for (const n of Object.getOwnPropertyNames(p)) {
      if (n === "constructor") continue;
      try {
        if (typeof (obj as Record<string, unknown>)[n] === "function") names.add(n);
      } catch {
        /* getter threw: ignore */
      }
    }
  }
  return [...names].sort();
}

export async function probeAdapter(ctx: Ctx): Promise<void> {
  const { app } = ctx;
  const r = await Report.create(app, "R-1", ctx.device, "adapter API probe");
  const adapter = app.vault.adapter;
  await r.line(`## Adapter`);
  await r.line(`- adapter class: ${adapter.constructor.name}`);
  await r.line(`- methods: ${methodNames(adapter).join(", ")}`);
  for (const m of [
    "append",
    "appendBinary",
    "readBinary",
    "writeBinary",
    "process",
    "getResourcePath",
    "getFullPath",
  ]) {
    const fn = (adapter as unknown as Record<string, unknown>)[m];
    await r.line(
      `- ${m}: ${typeof fn === "function" ? `present (declared params: ${(fn as (...a: unknown[]) => unknown).length})` : "MISSING"}`,
    );
  }
  await r.line(`- has adapter.fs (Node fs, desktop only): ${"fs" in adapter}`);
  await r.line(
    `- globals: Response.body=${typeof Response !== "undefined" && "body" in Response.prototype}, ReadableStream=${typeof ReadableStream}, Blob.stream=${typeof Blob !== "undefined" && typeof Blob.prototype.stream}, FileReader=${typeof FileReader}`,
  );

  // Small sample file for the range / append experiments.
  const dir = R1_DIR;
  if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
  const sample = normalizePath(`${dir}/probe-2mb.bin`);
  const bytes = new Uint8Array(2 * MiB).map((_, i) => i % 251);
  await adapter.writeBinary(sample, bytes.buffer);
  const expected = toHex(sha256(bytes));

  await r.line(`\n## appendBinary`);
  try {
    const target = normalizePath(`${dir}/probe-append.bin`);
    await adapter.writeBinary(target, bytes.slice(0, MiB).buffer);
    await adapter.appendBinary(target, bytes.slice(MiB).buffer);
    const back = new Uint8Array(await adapter.readBinary(target));
    await r.line(
      `- appendBinary 1 MiB + 1 MiB -> size ${back.byteLength}, content ok: ${toHex(sha256(back)) === expected}`,
    );
    await adapter.remove(target);
  } catch (err) {
    await r.line(`- appendBinary FAILED: ${errorText(err)}`);
  }

  await r.line(`\n## Resource URL (partial / streamed read)`);
  const url = adapter.getResourcePath(sample);
  await r.line(`- getResourcePath scheme: ${url.split(":")[0] ?? "?"}`);
  try {
    const res = await fetch(url, { headers: { Range: "bytes=1048576-1114111" } });
    const body = new Uint8Array(await res.arrayBuffer());
    const partial = res.status === 206 && body.byteLength === 65536;
    const correct = partial && body.every((b, i) => b === (1048576 + i) % 251);
    await r.line(
      `- fetch with Range: status ${res.status}, content-range "${res.headers.get("content-range") ?? "-"}", bytes ${body.byteLength}, partial=${partial}, content ok=${correct}`,
    );
  } catch (err) {
    await r.line(`- fetch with Range FAILED: ${errorText(err)}`);
  }
  try {
    const res = await fetch(url);
    const reader = res.body?.getReader();
    if (!reader) {
      await r.line(`- streamed fetch: res.body is null (no streaming)`);
    } else {
      const h = sha256.create();
      let chunks = 0;
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        h.update(value);
        chunks++;
        total += value.byteLength;
      }
      await r.line(
        `- streamed fetch: status ${res.status}, ${chunks} chunks, ${total} bytes, sha ok=${toHex(h.digest()) === expected}`,
      );
    }
  } catch (err) {
    await r.line(`- streamed fetch FAILED: ${errorText(err)}`);
  }
  await adapter.remove(sample);
  await r.done();
}

// ---------------------------------------------------------------------------
// Test file generation (written in 4 MiB pieces so generation itself does not
// need the whole file in memory; falls back to a single writeBinary).
// ---------------------------------------------------------------------------

function randomChunk(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let off = 0; off < size; off += 65536)
    crypto.getRandomValues(out.subarray(off, off + 65536));
  return out;
}

export async function generateFile(ctx: Ctx): Promise<void> {
  const sizeMb = await pick(
    ctx.app,
    R1_SIZES_MB,
    (n) => `${n} MB`,
    "Size of the test file to generate",
  );
  if (sizeMb === null) return;
  const { app } = ctx;
  const adapter = app.vault.adapter;
  const r = await Report.create(app, "R-1", ctx.device, `generate ${sizeMb} MB`);
  if (!(await adapter.exists(R1_DIR))) await adapter.mkdir(R1_DIR);
  const path = normalizePath(`${R1_DIR}/test-${sizeMb}mb.bin`);
  const total = sizeMb * MiB;
  const progress = new Progress();
  const t0 = performance.now();
  try {
    await r.line(`- method: writeBinary first 4 MiB, then appendBinary per 4 MiB chunk`);
    for (let off = 0; off < total; off += CHUNK) {
      const chunk = randomChunk(Math.min(CHUNK, total - off));
      if (off === 0) await adapter.writeBinary(path, chunk.buffer as ArrayBuffer);
      else await adapter.appendBinary(path, chunk.buffer as ArrayBuffer);
      progress.set(
        `R-1 generating ${path}: ${Math.round(((off + chunk.byteLength) / total) * 100)}%`,
      );
      await yieldToUi();
    }
    const stat = await adapter.stat(path);
    await r.line(
      `- generated ${path}: ${stat?.size ?? "?"} bytes in ${ms(t0)} ms, heap ${heapMb()}`,
    );
  } catch (err) {
    await r.line(`- generation FAILED after ${ms(t0)} ms: ${errorText(err)}`);
    await r.line(
      `- fallback: copy test-${sizeMb}mb.bin into the vault folder "${R1_DIR}" from a computer (see docs/spikes/R-1.md)`,
    );
  } finally {
    progress.close();
  }
  await r.done();
}

interface TestFile {
  path: string;
  name: string;
  size: number;
}

/** Lists via the adapter (not the vault index) so files copied in from a computer show up too. */
async function pickTestFile(app: App): Promise<TestFile | null> {
  const adapter = app.vault.adapter;
  if (!(await adapter.exists(R1_DIR))) return null;
  const files: TestFile[] = [];
  for (const path of (await adapter.list(R1_DIR)).files) {
    if (path.endsWith(".copy.bin")) continue;
    const stat = await adapter.stat(path);
    if (stat) files.push({ path, name: path.split("/").pop() ?? path, size: stat.size });
  }
  files.sort((a, b) => a.size - b.size);
  return pick(
    app,
    files,
    (f) => `${f.path} (${(f.size / MiB).toFixed(0)} MB)`,
    `Pick a file in ${R1_DIR}/`,
  );
}

async function uploadStart(ctx: Ctx, name: string, size: number): Promise<string> {
  const res = await requestUrl({
    url: `${ctx.serverUrl}/upload/start`,
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({ name, size }),
  });
  return (res.json as { uploadId: string }).uploadId;
}

async function uploadChunk(ctx: Ctx, id: string, index: number, data: ArrayBuffer): Promise<void> {
  await requestUrl({
    url: `${ctx.serverUrl}/upload/${id}/chunk/${index}`,
    method: "PUT",
    contentType: "application/octet-stream",
    body: data,
  });
}

async function uploadFinish(ctx: Ctx, id: string): Promise<{ sha256: string; bytes: number }> {
  const res = await requestUrl({ url: `${ctx.serverUrl}/upload/${id}/finish`, method: "POST" });
  return res.json as { sha256: string; bytes: number };
}

// ---------------------------------------------------------------------------
// Pipeline A: what the obvious implementation does (whole file in memory).
// ---------------------------------------------------------------------------

export async function fullMemoryPipeline(ctx: Ctx): Promise<void> {
  const file = await pickTestFile(ctx.app);
  if (!file) return;
  const { app } = ctx;
  const adapter = app.vault.adapter;
  const r = await Report.create(app, "R-1", ctx.device, `full-memory pipeline on ${file.name}`);
  const progress = new Progress();
  const peak = new HeapPeak();
  await r.line(`- file: ${file.path}, ${file.size} bytes, heap before ${heapMb()}`);
  await r.line(`- (if the app crashes, the last line below is the last step that completed)`);
  try {
    progress.set("R-1 readBinary…");
    let t = performance.now();
    let buf: ArrayBuffer | null = await adapter.readBinary(file.path);
    peak.sample();
    await r.line(`- readBinary: ${ms(t)} ms (${rate(buf.byteLength, ms(t))}), heap ${heapMb()}`);

    progress.set("R-1 hashing…");
    t = performance.now();
    const h = sha256.create();
    for (let off = 0; off < buf.byteLength; off += CHUNK) {
      h.update(new Uint8Array(buf, off, Math.min(CHUNK, buf.byteLength - off)));
      peak.sample();
      await yieldToUi();
    }
    const local = toHex(h.digest());
    await r.line(
      `- sha256 incremental (4 MiB updates): ${ms(t)} ms (${rate(buf.byteLength, ms(t))}) = ${local}`,
    );

    t = performance.now();
    try {
      const id = await uploadStart(ctx, file.name, buf.byteLength);
      const chunks = Math.ceil(buf.byteLength / CHUNK);
      for (let i = 0; i < chunks; i++) {
        await uploadChunk(ctx, id, i, buf.slice(i * CHUNK, (i + 1) * CHUNK));
        peak.sample();
        progress.set(`R-1 upload chunk ${i + 1}/${chunks}`);
      }
      const done = await uploadFinish(ctx, id);
      await r.line(
        `- upload ${chunks} × 4 MiB via requestUrl: ${ms(t)} ms (${rate(buf.byteLength, ms(t))}), server sha matches: ${done.sha256 === local}`,
      );
    } catch (err) {
      await r.line(`- upload FAILED after ${ms(t)} ms: ${errorText(err)}`);
    }

    progress.set("R-1 writeBinary copy…");
    const copy = normalizePath(`${file.path}.copy.bin`);
    t = performance.now();
    await adapter.writeBinary(copy, buf);
    peak.sample();
    const stat = await adapter.stat(copy);
    await r.line(
      `- writeBinary copy: ${ms(t)} ms (${rate(buf.byteLength, ms(t))}), size ok: ${stat?.size === buf.byteLength}`,
    );
    await adapter.remove(copy);
    buf = null;
    await r.line(`- heap after release ${heapMb()}, peak used heap ${peak.toString()}`);
  } catch (err) {
    await r.line(`- FAILED: ${errorText(err)} (heap ${heapMb()})`);
  } finally {
    progress.close();
  }
  await r.done();
}

// ---------------------------------------------------------------------------
// Pipeline B: streaming (resource URL reader -> 4 MiB chunks -> hash, upload,
// appendBinary). Peak memory should stay around a few chunks.
// ---------------------------------------------------------------------------

export async function streamingPipeline(ctx: Ctx): Promise<void> {
  const file = await pickTestFile(ctx.app);
  if (!file) return;
  const { app } = ctx;
  const adapter = app.vault.adapter;
  const r = await Report.create(app, "R-1", ctx.device, `streaming pipeline on ${file.name}`);
  const progress = new Progress();
  const peak = new HeapPeak();
  const copy = normalizePath(`${file.path}.copy.bin`);
  await r.line(`- file: ${file.path}, ${file.size} bytes, heap before ${heapMb()}`);
  const t0 = performance.now();
  try {
    const res = await fetch(adapter.getResourcePath(file.path));
    const reader = res.body?.getReader();
    if (!reader) throw new Error(`no streaming body (status ${res.status})`);
    let uploadId: string | null = null;
    try {
      uploadId = await uploadStart(ctx, file.name, file.size);
    } catch (err) {
      await r.line(`- upload start FAILED (continuing without upload): ${errorText(err)}`);
    }
    const h = sha256.create();
    let pending = new Uint8Array(CHUNK);
    let filled = 0;
    let index = 0;
    let total = 0;
    let uploadMs = 0;
    let writeMs = 0;
    const flush = async (data: Uint8Array) => {
      h.update(data);
      const buf = data.slice().buffer;
      if (uploadId) {
        const t = performance.now();
        await uploadChunk(ctx, uploadId, index, buf);
        uploadMs += performance.now() - t;
      }
      const t = performance.now();
      if (index === 0) await adapter.writeBinary(copy, buf);
      else await adapter.appendBinary(copy, buf);
      writeMs += performance.now() - t;
      index++;
      peak.sample();
      progress.set(`R-1 streaming chunk ${index} (${(total / MiB).toFixed(0)} MB)`);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      let off = 0;
      while (off < value.byteLength) {
        const n = Math.min(CHUNK - filled, value.byteLength - off);
        pending.set(value.subarray(off, off + n), filled);
        filled += n;
        off += n;
        if (filled === CHUNK) {
          await flush(pending);
          pending = new Uint8Array(CHUNK);
          filled = 0;
        }
      }
    }
    if (filled > 0) await flush(pending.subarray(0, filled));
    const local = toHex(h.digest());
    const elapsed = ms(t0);
    await r.line(
      `- streamed ${total} bytes in ${index} chunks: total ${elapsed} ms (${rate(total, elapsed)}), sha256 ${local}`,
    );
    await r.line(
      `- of which upload ${Math.round(uploadMs)} ms, appendBinary ${Math.round(writeMs)} ms`,
    );
    if (uploadId) {
      const done = await uploadFinish(ctx, uploadId);
      await r.line(`- server sha matches: ${done.sha256 === local}`);
    }
    const stat = await adapter.stat(copy);
    await r.line(
      `- copy size ok: ${stat?.size === total}, peak used heap ${peak.toString()}, heap now ${heapMb()}`,
    );
  } catch (err) {
    await r.line(`- FAILED after ${ms(t0)} ms: ${errorText(err)} (heap ${heapMb()})`);
  } finally {
    progress.close();
    if (await adapter.exists(copy)) await adapter.remove(copy);
  }
  await r.done();
}

export async function cleanupLarge(app: App): Promise<void> {
  if (await app.vault.adapter.exists(R1_DIR)) await app.vault.adapter.rmdir(R1_DIR, true);
}
