import type { Op } from "@kamino/protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkInvariants, MemoryStore } from "./store.js";

const HASHES = ["1", "2", "3"].map((c) => c.repeat(64));
const PATHS = ["a.md", "A.md", "b.md", "d/c.md", "D/c.md", "d"];

/** Random ops on a small universe: ids and paths collide on purpose. */
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

describe("MemoryStore", () => {
  it("invariants hold for any op sequence; replaying recorded ops changes nothing", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(opArb, { minLength: 1, maxLength: 5 }), { maxLength: 20 }),
        (batches) => {
          const s = new MemoryStore();
          for (const h of HASHES) s.blobs.add(h);
          const recorded: Op[] = [];
          for (const batch of batches) {
            const { results } = s.commit(batch, "d1");
            batch.forEach((op, i) => {
              if (results[i]!.status === "accepted" || results[i]!.status === "conflict")
                recorded.push(op);
            });
            expect(checkInvariants(s)).toEqual([]);
          }
          // Rejections are not recorded and may succeed later; recorded ops always come back as duplicates.
          const head = s.head;
          const snapshot = JSON.stringify(s.snapshot());
          for (const op of recorded)
            expect(s.commit([op], "d1").results[0]!.status).toBe("duplicate");
          expect(s.head).toBe(head);
          expect(JSON.stringify(s.snapshot())).toBe(snapshot);
        },
      ),
      { numRuns: 300 },
    );
  });
});
