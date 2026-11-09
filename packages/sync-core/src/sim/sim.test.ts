import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Platform } from "../paths.js";
import { World, type Action, type ClientSpec } from "./world.js";

const env =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Number(env["SIM_RUNS"] ?? 150);

const PATHS = ["a.md", "A.md", "b.md", "d/c.md", "D/c.md", "é.md", "con.md", "x/y/z.md"];
const HASHES = ["0", "1", "2", "3", "4"].map((c) => c.repeat(64));
const PLATFORMS: Platform[] = ["linux", "windows", "macos", "android", "ios"];

const specArb: fc.Arbitrary<ClientSpec> = fc.record({
  platform: fc.constantFrom(...PLATFORMS),
  files: fc.array(fc.tuple(fc.constantFrom(...PATHS), fc.constantFrom(...HASHES)), {
    maxLength: 3,
  }),
});

const actionArb = (clients: number): fc.Arbitrary<Action> => {
  const c = fc.nat(clients - 1);
  const path = fc.constantFrom(...PATHS);
  const crashAt = fc.option(fc.nat(6), { freq: 4 });
  return fc.oneof(
    {
      weight: 4,
      arbitrary: fc.record({
        t: fc.constant("write" as const),
        c,
        path,
        hash: fc.constantFrom(...HASHES),
      }),
    },
    { weight: 1, arbitrary: fc.record({ t: fc.constant("remove" as const), c, path }) },
    {
      weight: 2,
      arbitrary: fc.record({
        t: fc.constant("rename" as const),
        c,
        from: path,
        to: path,
        watched: fc.boolean(),
      }),
    },
    { weight: 4, arbitrary: fc.record({ t: fc.constant("sync" as const), c, crashAt }) },
    {
      weight: 6,
      arbitrary: fc.record({ t: fc.constant("deliver" as const), k: fc.nat(20), crashAt }),
    },
    { weight: 1, arbitrary: fc.record({ t: fc.constant("drop" as const), k: fc.nat(20) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant("dup" as const), k: fc.nat(20) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant("crash" as const), c }) },
  );
};

const scenarioArb = fc
  .array(specArb, { minLength: 2, maxLength: 3 })
  .chain((specs) =>
    fc.tuple(fc.constant(specs), fc.array(actionArb(specs.length), { maxLength: 60 })),
  );

describe("simulator (02 §5)", () => {
  it("every client converges to the server and nothing is ever lost", () => {
    fc.assert(
      fc.property(scenarioArb, ([specs, actions]) => {
        const w = new World(specs);
        for (const a of actions) w.act(a);
        expect(w.settle()).toBe(true);
        expect(w.check()).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  }, 120_000);

  it("two devices create Nota.md and nota.md: both versions survive (03 §14)", () => {
    const w = new World([
      { platform: "linux", files: [] },
      { platform: "windows", files: [] },
    ]);
    w.act({ t: "sync", c: 0, crashAt: null });
    w.act({ t: "sync", c: 1, crashAt: null });
    while (w.net.length > 0) w.act({ t: "deliver", k: 0, crashAt: null });
    w.act({ t: "write", c: 0, path: "Nota.md", hash: "1".repeat(64) });
    w.act({ t: "write", c: 1, path: "nota.md", hash: "2".repeat(64) });
    expect(w.settle()).toBe(true);
    expect(w.check()).toEqual([]);
    expect(w.store.hasContent("1".repeat(64)) && w.store.hasContent("2".repeat(64))).toBe(true);
    expect(w.store.conflicts.size).toBe(1);
  });
  // fast-check counterexample: a device follows a remote rename onto a path where the user
  // just created an untracked file; the failed local rename must not be sent back as a move.
  it("following a remote rename onto a locally taken path never undoes it", () => {
    const h = (c: string) => c.repeat(64);
    const w = new World([
      {
        platform: "windows",
        files: [
          ["A.md", h("1")],
          ["D/c.md", h("2")],
        ],
      },
      { platform: "linux", files: [] },
    ]);
    for (const a of [
      { t: "sync", c: 0, crashAt: null },
      { t: "deliver", k: 0, crashAt: null },
      { t: "deliver", k: 0, crashAt: null },
      { t: "rename", c: 0, from: "a.md", to: "é.md", watched: true },
      { t: "sync", c: 1, crashAt: null },
      { t: "write", c: 1, path: "é.md", hash: h("0") },
    ] as const)
      w.act(a);
    expect(w.settle()).toBe(true);
    expect(w.check()).toEqual([]);
    expect([...w.store.files.values()].find((f) => f.headHash === h("1"))!.path).not.toBe("A.md");
  });
  // fast-check counterexample: two remote moves of the same file in one pull (a case-only
  // rename back and forth); the first local rename must not win over the second.
  it("successive remote moves are followed to the last one, without duplicates", () => {
    const h = (c: string) => c.repeat(64);
    const w = new World([
      {
        platform: "android",
        files: [
          ["A.md", h("2")],
          ["D/c.md", h("3")],
        ],
      },
      {
        platform: "macos",
        files: [
          ["b.md", h("0")],
          ["d/c.md", h("2")],
          ["D/c.md", h("3")],
        ],
      },
      {
        platform: "linux",
        files: [
          ["b.md", h("2")],
          ["é.md", h("2")],
        ],
      },
    ]);
    for (const a of [
      { t: "sync", c: 2, crashAt: null },
      { t: "deliver", k: 0, crashAt: null },
      { t: "deliver", k: 0, crashAt: null },
    ] as const)
      w.act(a);
    expect(w.settle()).toBe(true);
    expect(w.check()).toEqual([]);
    expect(
      [...w.store.files.values()].filter((f) => f.headHash === h("3") && !f.deleted),
    ).toHaveLength(1);
  });
});
