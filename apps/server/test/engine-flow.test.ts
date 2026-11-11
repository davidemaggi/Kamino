import { MemoryFs, sha256Hex } from "@kamino/sync-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compactJournal, INACTIVE_DEVICE_MS } from "../src/jobs/compact.js";
import { deviceEngine, vaultFiles } from "./helpers/engine.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { linkDevice, user, type TestDevice } from "./helpers/sync.js";

const FILES = Number(process.env["ENGINE_FILES"] ?? 2000);

async function* once(b: Uint8Array): AsyncIterable<Uint8Array> {
  yield b;
}

/** The server's live files (path → content hash), through the device API. */
async function serverHashes(d: TestDevice): Promise<Map<string, string>> {
  const r = await d.call("GET", `/vaults/${d.vaultId}/snapshot`);
  const snap = r.json() as { files: { kind: string; path: string; contentHash: string | null }[] };
  return new Map(
    snap.files
      .filter((f) => f.kind === "file" && f.contentHash)
      .map((f) => [f.path, f.contentHash!] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

async function localHashes(fs: MemoryFs): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const p of [...fs.files.keys()].filter((x) => !x.startsWith(".obsidian/")).sort())
    out.set(p, await sha256Hex(once(fs.files.get(p)!.data)));
  return out;
}

describe.skipIf(dockerUnavailable)("sync engine against the real server", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let app: FastifyInstance | null;
  let a: TestDevice;
  let b: TestDevice;
  const fsA = new MemoryFs();
  const fsB = new MemoryFs();

  beforeAll(async () => {
    pg = await startPostgres();
    t = await testApp(await pg.createDatabase("engine_flow"), { chunkSize: 64 * 1024 });
    app = t.app;
    const enroll = await user(t, "ada");
    a = await linkDevice(t, enroll, undefined, "Laptop");
    b = await linkDevice(t, enroll, a.vaultId, "Phone");
  });
  afterAll(async () => {
    await t?.close();
    await pg?.stop();
  });

  it(`onboards a vault of ${FILES} files: all confirmed, server = vault`, async () => {
    for (let i = 0; i < FILES; i++)
      fsA.put(`notes/${i % 40}/n${i}.md`, `note ${i}\n`.repeat(1 + (i % 7)));
    fsA.put(
      "big.bin",
      new Uint8Array(200_000).map((_, i) => i % 251),
    ); // several chunks
    const e = await deviceEngine(() => app, a, fsA);
    await e.syncNow();
    expect(e.snapshot().queued).toBe(0);
    expect(await serverHashes(a)).toEqual(await localHashes(fsA));
  }, 900_000);

  it("a second device with an empty vault receives everything, identical", async () => {
    const e = await deviceEngine(() => app, b, fsB);
    await e.syncNow();
    await e.syncNow(); // the scan adopts the written files
    expect(vaultFiles(fsB)).toEqual(vaultFiles(fsA));
    expect(e.snapshot().queued).toBe(0);
  }, 900_000);

  it("an edit on A arrives on B at the next pull", async () => {
    const ea = await deviceEngine(() => app, a, fsA);
    const eb = await deviceEngine(() => app, b, fsB);
    fsA.put("notes/0/n0.md", "edited on A");
    await ea.syncNow();
    await eb.syncNow();
    expect(fsB.text("notes/0/n0.md")).toBe("edited on A");
  }, 300_000);

  it("server down: shown as unreachable, then it resumes", async () => {
    const ea = await deviceEngine(() => app, a, fsA);
    await ea.syncNow();
    const saved = app;
    app = null;
    fsA.put("offline.md", "written offline");
    await ea.syncNow();
    expect(ea.snapshot().unreachableSince).not.toBeNull();
    expect(ea.snapshot().queued).toBeGreaterThan(0);
    app = saved;
    await ea.syncNow();
    expect(ea.snapshot().unreachableSince).toBeNull();
    expect(ea.snapshot().queued).toBe(0);
    expect((await serverHashes(a)).has("offline.md")).toBe(true);
  }, 300_000);

  it("cursor_too_old after compaction: B catches up from the snapshot", async () => {
    const ea = await deviceEngine(() => app, a, fsA);
    fsA.put("while-b-away.md", "news");
    fsA.remove("notes/1/n1.md");
    await ea.syncNow();
    // B is away long enough: only A's cursor holds the journal, then it is compacted.
    t.clock.now += INACTIVE_DEVICE_MS + 31 * 86_400_000;
    await ea.syncNow(); // A is seen again (last contact) and acknowledges the head
    const r = await compactJournal(t.db, t.clock.now);
    expect(r.deleted).toBeGreaterThan(0);
    const eb = await deviceEngine(() => app, b, fsB);
    await eb.syncNow();
    await eb.syncNow();
    expect(fsB.text("while-b-away.md")).toBe("news");
    expect(fsB.files.has("notes/1/n1.md")).toBe(false);
    expect(vaultFiles(fsB)).toEqual(vaultFiles(fsA));
  }, 300_000);
});
