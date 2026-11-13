import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Platform } from "../paths.js";
import { REGRESSIONS } from "./regressions.js";
import { World, type Action, type ClientSpec } from "./world.js";

const env =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Number(env["SIM_RUNS"] ?? 150);

const PATHS = [
  "a.md",
  "A.md",
  "b.md",
  "d/c.md",
  "D/c.md",
  "d/e.md",
  "é.md",
  "con.md",
  "x/y/z.md",
  ".obsidian/app.json",
  ".obsidian/workspace.json",
  ".trash/t.md",
];
/** Folders users create and move to (Z9): nested, case variants, excluded areas. */
const DIRS = ["d", "D", "n", "n/m", "x", "x/y", "q/r", ".trash"];
const HASHES = ["0", "1", "2", "3", "4"].map((c) => c.repeat(64));
const CHOICES = ["mine", "incoming", "both"] as const;
const PLATFORMS: Platform[] = ["linux", "windows", "macos", "android", "ios"];
const PATTERNS: string[][] = [[], [".trash/**"], ["d/**"], ["x/**", ".trash/**"], ["b.md"]];

const specArb: fc.Arbitrary<ClientSpec> = fc.record({
  platform: fc.constantFrom(...PLATFORMS),
  files: fc.array(fc.tuple(fc.constantFrom(...PATHS), fc.constantFrom(...HASHES)), {
    maxLength: 3,
  }),
  patterns: fc.constantFrom(...PATTERNS),
});

const actionArb = (clients: number): fc.Arbitrary<Action> => {
  const c = fc.nat(clients - 1);
  const path = fc.constantFrom(...PATHS);
  const dir = fc.constantFrom(...DIRS);
  const crashAt = fc.option(fc.nat(8), { freq: 4 });
  const hash = fc.constantFrom(...HASHES);
  const choice = fc.constantFrom(...CHOICES);
  return fc.oneof(
    { weight: 4, arbitrary: fc.record({ t: fc.constant("write" as const), c, path, hash }) },
    {
      weight: 3,
      arbitrary: fc.record({ t: fc.constant("edit" as const), c, pick: fc.nat(9), hash }),
    },
    { weight: 2, arbitrary: fc.record({ t: fc.constant("remove" as const), c, pick: fc.nat(9) }) },
    {
      weight: 3,
      arbitrary: fc.record({
        t: fc.constant("rename" as const),
        c,
        pick: fc.nat(9),
        to: path,
        watched: fc.boolean(),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        t: fc.constant("settings" as const),
        c,
        patterns: fc.constantFrom(...PATTERNS),
      }),
    },
    { weight: 5, arbitrary: fc.record({ t: fc.constant("cycle" as const), c }) },
    { weight: 4, arbitrary: fc.record({ t: fc.constant("sync" as const), c, crashAt }) },
    {
      weight: 4,
      arbitrary: fc.record({ t: fc.constant("fs" as const), c, k: fc.nat(5), crashAt }),
    },
    {
      weight: 6,
      arbitrary: fc.record({ t: fc.constant("deliver" as const), k: fc.nat(20), crashAt }),
    },
    { weight: 1, arbitrary: fc.record({ t: fc.constant("drop" as const), k: fc.nat(20) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant("timeout" as const), k: fc.nat(20) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant("dup" as const), k: fc.nat(20) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant("truncate" as const) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant("quota" as const), on: fc.boolean() }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant("crash" as const), c }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant("compact" as const) }) },
    {
      weight: 2,
      arbitrary: fc.record({ t: fc.constant("resolve" as const), c, pick: fc.nat(3), choice }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        t: fc.constant("webResolve" as const),
        pick: fc.nat(3),
        keep: fc.constantFrom("head" as const, "candidate" as const, "both" as const),
      }),
    },
    { weight: 2, arbitrary: fc.record({ t: fc.constant("mkdir" as const), c, path: dir }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant("rmdir" as const), c, pick: fc.nat(9) }) },
    {
      weight: 2,
      arbitrary: fc.record({
        t: fc.constant("moveDir" as const),
        c,
        pick: fc.nat(9),
        to: dir,
        watched: fc.boolean(),
      }),
    },
  );
};

const scenarioArb = fc
  .array(specArb, { minLength: 2, maxLength: 4 })
  .chain((specs) =>
    fc.tuple(
      fc.constant(specs),
      fc.array(actionArb(specs.length), { minLength: 20, maxLength: 150, size: "max" }),
      fc.array(fc.constantFrom(...CHOICES), { minLength: 8, maxLength: 8 }),
    ),
  );

/** Every device resolves its conflicts until none is left (a resolution may meet a newer edit). */
function resolveEverything(w: World, choices: readonly (typeof CHOICES)[number][]): void {
  for (let round = 0; round < 8 && w.conflicts().local > 0; round++) {
    w.clients.forEach((_, c) => {
      for (let k = 0; k < 4; k++)
        w.act({ t: "resolve", c, pick: k, choice: choices[(round + c + k) % choices.length]! });
    });
    expect(w.settle(), w.unsettled()).toBe(true);
  }
}

describe("simulator (02 §5)", () => {
  it("every client converges to the server and nothing is ever lost", () => {
    fc.assert(
      fc.property(scenarioArb, ([specs, actions, choices]) => {
        const w = new World(specs);
        for (const a of actions) w.act(a);
        expect(w.settle(), w.unsettled()).toBe(true);
        expect(w.check()).toEqual([]);
        // M3b: once every conflict is resolved on its device, all converge and nothing is lost.
        resolveEverything(w, choices);
        expect(w.conflicts().local, w.describeConflicts().join("\n")).toBe(0);
        expect(w.check()).toEqual([]);
      }),
      // SIM_NO_SHRINK=1: report the first failure as is (shrinking a non-settling run is slow).
      {
        numRuns: RUNS,
        endOnFailure: env["SIM_NO_SHRINK"] === "1",
        // SIM_SEED / SIM_PATH: replay a reported failure.
        ...(env["SIM_SEED"] ? { seed: Number(env["SIM_SEED"]), path: env["SIM_PATH"] ?? "0" } : {}),
      },
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
    expect(w.settle(), w.unsettled()).toBe(true);
    expect(w.check()).toEqual([]);
    // Both writes survive: one live, the other as a conflict candidate.
    expect(w.store.versions.size).toBe(2);
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
      { t: "rename", c: 0, pick: 0, to: "é.md", watched: true },
      { t: "sync", c: 1, crashAt: null },
      { t: "write", c: 1, path: "é.md", hash: h("0") },
    ] as const)
      w.act(a);
    expect(w.settle(), w.unsettled()).toBe(true);
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
    expect(w.settle(), w.unsettled()).toBe(true);
    expect(w.check()).toEqual([]);
    expect(
      [...w.store.files.values()].filter((f) => f.headHash === h("3") && !f.deleted),
    ).toHaveLength(1);
  });
  // fast-check counterexample: an old remote deletion arrives after this device's own edit
  // already resurrected the file; the stale deletion must not trash it.
  it("a stale remote deletion never trashes a file resurrected by a later edit", () => {
    const h = (c: string) => c.repeat(64);
    const w = new World([
      { platform: "windows", files: [] },
      {
        platform: "android",
        files: [
          ["b.md", h("3")],
          ["x/y/z.md", h("3")],
          ["d/c.md", h("0")],
        ],
      },
      { platform: "ios", files: [["d/c.md", h("4")]] },
    ]);
    for (const a of [
      { t: "cycle", c: 2 },
      { t: "cycle", c: 0 },
      { t: "write", c: 2, path: "d/c.md", hash: h("0") },
      { t: "rename", c: 0, pick: 0, to: "a.md", watched: false },
    ] as const)
      w.act(a);
    expect(w.settle(), w.unsettled()).toBe(true);
    expect(w.check()).toEqual([]);
  });
  // fast-check counterexample: two versions of a new file in one pull; the second arrived
  // while the first was being written and was never written afterwards.
  it("a newer version arriving during a write is written afterwards", () => {
    const h = (c: string) => c.repeat(64);
    const w = new World([
      { platform: "windows", files: [["D/c.md", h("2")]] },
      {
        platform: "android",
        files: [
          ["é.md", h("3")],
          ["x/y/z.md", h("4")],
          ["con.md", h("1")],
        ],
      },
      { platform: "windows", files: [] },
    ]);
    for (const a of [
      { t: "sync", c: 2, crashAt: null },
      { t: "cycle", c: 0 },
      { t: "edit", c: 0, pick: 0, hash: h("0") },
    ] as const)
      w.act(a);
    expect(w.settle(), w.unsettled()).toBe(true);
    expect(w.check()).toEqual([]);
  });
  // fast-check counterexample: a deletion and a resurrection of the same file in one pull;
  // the trash finished after the resurrection and dropped the file from the index.
  it("a file resurrected while being trashed comes back", () => {
    const h = (c: string) => c.repeat(64);
    const w = new World([
      {
        platform: "macos",
        files: [
          ["a.md", h("2")],
          ["b.md", h("2")],
          ["é.md", h("1")],
        ],
      },
      {
        platform: "macos",
        files: [
          ["D/c.md", h("1")],
          ["b.md", h("2")],
          ["A.md", h("2")],
        ],
      },
      { platform: "ios", files: [] },
    ]);
    for (const a of [
      { t: "cycle", c: 1 },
      { t: "cycle", c: 2 },
      { t: "write", c: 2, path: "a.md", hash: h("0") },
      { t: "remove", c: 1, pick: 2 },
    ] as const)
      w.act(a);
    expect(w.settle(), w.unsettled()).toBe(true);
    expect(w.check()).toEqual([]);
  });
  // fast-check counterexample: a file renamed elsewhere to a name Windows can't use stayed under
  // its old name and blocked a new file with that name (Z10).
  it("a file moved to a name this device can't use leaves its old name free", () => {
    const h = (c: string) => c.repeat(64);
    const w = new World([
      {
        platform: "windows",
        files: [
          ["a.md", h("2")],
          ["D/c.md", h("1")],
        ],
      },
      { platform: "macos", files: [["a.md", h("0")]] },
    ]);
    for (const a of [
      { t: "cycle", c: 1 },
      { t: "rename", c: 1, pick: 0, to: "d/c.md", watched: true },
      { t: "remove", c: 0, pick: 0 },
      { t: "write", c: 1, path: "a.md", hash: h("3") },
      { t: "rename", c: 1, pick: 0, to: "con.md", watched: true },
    ] as const)
      w.act(a);
    expect(w.settle(), w.unsettled()).toBe(true);
    expect(w.check()).toEqual([]);
  });
  // Exact counterexamples found once scenarios got long (size "max"), replayed as they were.
  it.each(REGRESSIONS.map((json, i) => [i, json] as const))("regression %i", (_, json) => {
    const [[specs, actions]] = JSON.parse(json) as [[ClientSpec[], Action[]]];
    const w = new World(specs);
    for (const a of actions) w.act(a);
    expect(w.settle(), w.unsettled()).toBe(true);
    expect(w.check()).toEqual([]);
  });
});
