import { MemoryFs, type Engine } from "@kamino/sync-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deviceEngine, vaultFiles } from "./helpers/engine.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { linkDevice, user, type TestDevice } from "./helpers/sync.js";

/**
 * M7c C1: a 10,000-file vault (01 NF: performance). Opt-in (`KAMINO_PERF=1`), run in CI by the
 * perf job. The limits are deliberately wide (a slow CI runner must pass): they catch an
 * accidental quadratic step, not a 20% regression. Timings are printed for the record.
 */
const FILES = Number(process.env["KAMINO_PERF_FILES"] ?? 10_000);
const LIMITS = {
  firstLink: 1_200_000,
  secondDevice: 1_200_000,
  idleScan: 15_000,
  snapshot: 10_000,
  oneEdit: 15_000,
};

/** `syncNow()` ends with the cycle; downloads may still be in flight: wait for them too. */
async function drain(e: Engine): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await e.syncNow();
    if (!e.snapshot().syncing && e.snapshot().queued === 0) {
      await e.syncNow(); // the scan adopts the files written by the downloads
      if (!e.snapshot().syncing) return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the engine never settled");
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const out = await fn();
  const ms = Math.round(performance.now() - t0);
  console.log(`[perf] ${label}: ${ms} ms (${FILES} files)`);
  return [out, ms];
}

describe.skipIf(dockerUnavailable || !process.env["KAMINO_PERF"])(
  `performance with ${FILES} files (M7c C1)`,
  () => {
    let pg: TestPostgres;
    let t: TestApp;
    let a: TestDevice;
    let b: TestDevice;
    const fsA = new MemoryFs();
    const fsB = new MemoryFs();

    beforeAll(async () => {
      pg = await startPostgres();
      t = await testApp(await pg.createDatabase("perf"), { chunkSize: 64 * 1024 });
      const enroll = await user(t, "ada");
      a = await linkDevice(t, enroll, undefined, "Laptop");
      b = await linkDevice(t, enroll, a.vaultId, "Phone");
      // A realistic notes vault: folders, short and medium notes, a few attachments.
      for (let i = 0; i < FILES; i++) {
        const dir = `area-${i % 12}/topic-${i % 97}`;
        if (i % 250 === 0) fsA.put(`${dir}/img-${i}.png`, new Uint8Array(40_000).fill(i % 256));
        else
          fsA.put(
            `${dir}/note-${i}.md`,
            `# Note ${i}\n\n${"lorem ipsum ".repeat(20 + (i % 200))}\n`,
          );
      }
    });
    afterAll(async () => {
      await t?.close();
      await pg?.stop();
    });

    it("first link, second device, idle scan, snapshot, one edit", async () => {
      const ea = await deviceEngine(() => t.app, a, fsA);
      const [, first] = await timed("first link (upload all)", () => drain(ea));
      expect(ea.snapshot().queued).toBe(0);

      const eb = await deviceEngine(() => t.app, b, fsB);
      const [, second] = await timed("second device (download all)", () => drain(eb));
      expect(vaultFiles(fsB).size).toBe(vaultFiles(fsA).size);

      const [, idle] = await timed("idle cycle (scan, nothing changed)", () => ea.syncNow());
      expect(ea.snapshot().queued).toBe(0);

      const [snap, snapMs] = await timed("snapshot", () =>
        a.call("GET", `/vaults/${a.vaultId}/snapshot`),
      );
      expect(snap.statusCode).toBe(200);

      fsA.put("area-0/topic-12/note-12.md", "edited");
      const [, edit] = await timed("one edit, A to B", async () => {
        await drain(ea);
        await drain(eb);
      });
      expect(fsB.text("area-0/topic-12/note-12.md")).toBe("edited");

      expect(first).toBeLessThan(LIMITS.firstLink);
      expect(second).toBeLessThan(LIMITS.secondDevice);
      expect(idle).toBeLessThan(LIMITS.idleScan);
      expect(snapMs).toBeLessThan(LIMITS.snapshot);
      expect(edit).toBeLessThan(LIMITS.oneEdit);
    }, 3_000_000);
  },
);
