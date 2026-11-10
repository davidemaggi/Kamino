import type { Op } from "@kamino/protocol";
import { MemoryStore } from "@kamino/sync-core";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blobs } from "../src/db/schema.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { linkDevice, user } from "./helpers/sync.js";

const HASHES = ["1", "2", "3"].map((c) => c.repeat(64));
const PATHS = ["a.md", "A.md", "b.md", "d/c.md", "D/c.md", "d"];

/** The same generator as sync-core's store test: small universes, colliding ids and paths. */
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    type: fc.constant("put" as const),
    opId: fc.constantFrom("o1", "o2", "o3", "o4", "o5", "o6", "o7", "o8"),
    fileId: fc.constantFrom("f1", "f2", "f3"),
    versionId: fc.constantFrom("v1", "v2", "v3", "v4"),
    path: fc.constantFrom(...PATHS),
    baseVersionId: fc.constantFrom(null, "v1", "v2", "v3", "v4"),
    contentHash: fc.constantFrom(...HASHES),
    size: fc.constant(1),
    mtime: fc.constant(0),
  }),
  fc.record({
    type: fc.constant("move" as const),
    opId: fc.constantFrom("m1", "m2", "m3", "m4"),
    fileId: fc.constantFrom("f1", "f2", "f3", "dd"),
    fromPath: fc.constantFrom(...PATHS),
    toPath: fc.constantFrom(...PATHS),
  }),
  fc.record({
    type: fc.constant("delete" as const),
    opId: fc.constantFrom("x1", "x2", "x3"),
    fileId: fc.constantFrom("f1", "f2", "f3", "dd"),
    baseVersionId: fc.constantFrom(null, "v1", "v2", "v3", "v4"),
  }),
  fc.record({
    type: fc.constant("mkdir" as const),
    opId: fc.constantFrom("k1", "k2"),
    fileId: fc.constantFrom("dd", "de"),
    path: fc.constantFrom(...PATHS),
  }),
);

/** Conflict ids differ by construction (uuid vs srv-n): rename them by order of appearance. */
function normalizer() {
  const ids = new Map<string, string>();
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => {
          if (k === "conflictId" && typeof x === "string") {
            if (!ids.has(x)) ids.set(x, `c${ids.size + 1}`);
            return [k, ids.get(x)];
          }
          return [k, norm(x)];
        }),
      );
    return v;
  };
  return norm;
}

describe.skipIf(dockerUnavailable)("server vs MemoryStore (C4 oracle)", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let enroll: string;
  beforeAll(async () => {
    pg = await startPostgres();
    t = await testApp(await pg.createDatabase("oracle"));
    enroll = await user(t, "mario");
  }, 120_000);
  afterAll(async () => {
    await t?.close();
    await pg?.stop();
  });

  it("same results, snapshot and head for any op sequence", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(opArb, { minLength: 1, maxLength: 5, size: "max" }), {
          minLength: 4,
          maxLength: 12,
          size: "max",
        }),
        async (batches) => {
          // A fresh vault per case: vaults isolate everything.
          const d = await linkDevice(t, enroll);
          const vault = (await t.vaults.byId(d.vaultId))!;
          const vc = t.vaults.cryptoOf(vault);
          await t.db.insert(blobs).values(
            HASHES.map((h) => ({
              vaultId: d.vaultId,
              blobId: vc.blobId(h),
              size: 1,
              storedSize: 1,
            })),
          );
          const mem = new MemoryStore();
          for (const h of HASHES) mem.blobs.add(h);
          const nServer = normalizer();
          const nMem = normalizer();
          for (const batch of batches) {
            const server = await t.sync.commit(vc, d.deviceId, batch);
            const oracle = mem.commit(batch, d.deviceId);
            expect(nServer(server.results)).toEqual(nMem(oracle.results));
            expect(server.head).toBe(oracle.head);
          }
          const snap = await t.sync.snapshot(vc);
          const sortFiles = <T extends { fileId: string }>(xs: T[]) =>
            [...xs].sort((a, b) => a.fileId.localeCompare(b.fileId));
          expect(nServer(sortFiles(snap.files))).toEqual(nMem(sortFiles(mem.snapshot().files)));
          expect(snap.openConflicts.length).toBe(mem.snapshot().openConflicts.length);
        },
      ),
      { numRuns: Number(process.env["ORACLE_RUNS"] ?? 25) },
    );
  }, 600_000);

  // Oracle counterexample: a resurrection next to a taken path made the file live at the taken
  // path for a moment (unique index violation). The arbiter now moves first, then revives.
  it("resurrection next to a taken path", async () => {
    const d = await linkDevice(t, enroll);
    const vc = t.vaults.cryptoOf((await t.vaults.byId(d.vaultId))!);
    await t.db
      .insert(blobs)
      .values({ vaultId: d.vaultId, blobId: vc.blobId(HASHES[0]!), size: 1, storedSize: 1 });
    const put = (
      opId: string,
      fileId: string,
      versionId: string,
      path: string,
      base: string | null,
    ): Op => ({
      type: "put",
      opId,
      fileId,
      versionId,
      path,
      baseVersionId: base,
      contentHash: HASHES[0]!,
      size: 1,
      mtime: 0,
    });
    await t.sync.commit(vc, d.deviceId, [put("o1", "f1", "v1", "a.md", null)]);
    await t.sync.commit(vc, d.deviceId, [
      { type: "delete", opId: "x1", fileId: "f1", baseVersionId: "v1" },
    ]);
    await t.sync.commit(vc, d.deviceId, [put("o2", "f2", "v2", "A.md", null)]);
    const r = await t.sync.commit(vc, d.deviceId, [put("o3", "f1", "v3", "a.md", "v1")]);
    expect(r.results[0]).toMatchObject({ status: "accepted", path: "a (1).md" });
  });
});
