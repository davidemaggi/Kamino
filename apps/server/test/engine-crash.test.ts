import {
  MemoryFs,
  sha256Hex,
  type FsEntry,
  type Http,
  type VaultFs,
  type WriteOutcome,
} from "@kamino/sync-engine";
import fc from "fast-check";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deviceEngine, injectHttp } from "./helpers/engine.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { linkDevice, raw, user, type TestDevice } from "./helpers/sync.js";

const RUNS = Number(process.env["ENGINE_CRASH_RUNS"] ?? 8);
const FILES = 200;

/** From call `at` on, nothing the doomed client does reaches the disk or the server. */
class ClientCrash {
  calls = 0;
  dead = false;
  private resolveDead!: () => void;
  readonly died = new Promise<void>((r) => (this.resolveDead = r));
  constructor(
    private readonly at: number,
    private readonly lands: boolean,
  ) {}
  async gate<T>(f: () => Promise<T>): Promise<T> {
    if (this.dead) return new Promise<T>(() => {});
    if (++this.calls < this.at) return f();
    this.dead = true;
    this.resolveDead();
    if (this.lands) await f().catch(() => {});
    return new Promise<T>(() => {});
  }
  fs(inner: MemoryFs): VaultFs {
    return {
      streaming: true,
      list: () => (this.dead ? new Promise<FsEntry[]>(() => {}) : inner.list()),
      stat: (p) => inner.stat(p),
      read: (p) => inner.read(p),
      write: (p, parts, e, w) => this.gate<WriteOutcome>(() => inner.write(p, parts, e, w)),
      rename: (a, b) => this.gate(() => inner.rename(a, b)),
      trash: (p) => this.gate(() => inner.trash(p)),
      mkdir: (p) => this.gate(() => inner.mkdir(p)),
      rmdirIfEmpty: (p) => this.gate(() => inner.rmdirIfEmpty(p)),
      loadState: (n) => inner.loadState(n),
      saveState: (n, d) => this.gate(() => inner.saveState(n, d)),
    };
  }
  http(inner: Http): Http {
    return { request: (r) => this.gate(() => inner.request(r)) };
  }
}

type Crash = { who: "client" | "server"; at: number; lands: boolean };
const crashArb: fc.Arbitrary<Crash> = fc.record({
  who: fc.constantFrom("client" as const, "server" as const),
  at: fc.integer({ min: 1, max: 600 }),
  lands: fc.boolean(),
});

async function* once(b: Uint8Array): AsyncIterable<Uint8Array> {
  yield b;
}

describe.skipIf(dockerUnavailable)("crashes during the initial upload (M1 exit criterion)", () => {
  let pg: TestPostgres;
  let run = 0;
  beforeAll(async () => {
    pg = await startPostgres();
  });
  afterAll(async () => {
    await pg?.stop();
  });

  it("client and server crashes: no file lost, server = vault, no duplicates", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(crashArb, { minLength: 1, maxLength: 4 }), async (crashes) => {
        const url = await pg.createDatabase(`crash_${++run}`);
        const root = mkdtempSync(join(tmpdir(), "kamino-crash-"));
        const dirs = { blobs: join(root, "blobs"), staging: join(root, "staging") };
        let t: TestApp = await testApp(url, { chunkSize: 64 * 1024, dirs });
        let app: FastifyInstance | null = t.app;
        try {
          const enroll = await user(t, "ada");
          const device: TestDevice = await linkDevice(t, enroll);
          const fs = new MemoryFs();
          for (let i = 0; i < FILES; i++) fs.put(`n/${i % 10}/f${i}.md`, `file ${i}`);
          fs.put(
            "big.bin",
            new Uint8Array(300_000).map((_, i) => (i * 7) % 256),
          );
          const original = new Map([...fs.files].map(([p, f]) => [p, f.data.slice()]));

          // Server restarts at a given request count: in-flight requests fail like a lost network.
          let requests = 0;
          const restartsAt = new Set(crashes.filter((c) => c.who === "server").map((c) => c.at));
          const serverHttp = injectHttp(() => app);
          const http: Http = {
            async request(r) {
              if (restartsAt.has(++requests)) {
                restartsAt.delete(requests);
                app = null;
                await t.close();
                t = await testApp(url, { chunkSize: 64 * 1024, dirs });
                app = t.app;
                throw new Error("server restarted");
              }
              return serverHttp.request(r);
            },
          };

          for (const c of crashes.filter((x) => x.who === "client")) {
            const crash = new ClientCrash(c.at, c.lands);
            const doomed = await deviceEngine(() => app, device, crash.fs(fs), crash.http(http));
            await Promise.race([doomed.syncNow(), crash.died]);
          }
          const engine = await deviceEngine(() => app, device, fs, http);
          for (let i = 0; i < 4; i++) await engine.syncNow();
          restartsAt.clear();
          await engine.syncNow();

          // Nothing lost on the device.
          for (const [p, data] of original) expect(fs.files.get(p)?.data).toEqual(data);
          // Server = vault, one live file per path.
          const snap = (
            await raw(t, "GET", `/vaults/${device.vaultId}/snapshot`, undefined, {
              authorization: `Bearer ${device.token}`,
            })
          ).json() as {
            files: { kind: string; path: string; contentHash: string | null }[];
          };
          const live = snap.files.filter((f) => f.kind === "file");
          expect(new Set(live.map((f) => f.path)).size).toBe(live.length);
          const want = new Map<string, string>();
          for (const [p, data] of original) want.set(p, await sha256Hex(once(data)));
          expect(new Map(live.map((f) => [f.path, f.contentHash!]))).toEqual(want);
          expect(engine.snapshot().queued).toBe(0);
        } finally {
          await t.close();
          rmSync(root, { recursive: true, force: true });
        }
      }),
      { numRuns: RUNS },
    );
  }, 1_800_000);
});
