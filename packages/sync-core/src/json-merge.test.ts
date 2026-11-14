import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mergeJson3 } from "./json-merge.js";

const j = (v: unknown) => JSON.stringify(v, null, 2);
const m = (base: unknown, ours: unknown, theirs: unknown) =>
  JSON.parse(mergeJson3(j(base), j(ours), j(theirs))!) as unknown;

describe("mergeJson3 (ADR-0020)", () => {
  it("a stale list of plugins keeps the one another device enabled", () => {
    expect(m(["kamino"], ["kamino"], ["kamino", "excalidraw"])).toEqual(["kamino", "excalidraw"]);
  });

  it("a plugin turned off here stays off, one turned on there arrives", () => {
    expect(m(["a", "b"], ["a"], ["a", "b", "c"])).toEqual(["a", "c"]);
  });

  it("both sides add and remove", () => {
    expect(m(["a", "b", "c"], ["a", "c", "d"], ["b", "c", "e"])).toEqual(["c", "d", "e"]);
  });

  it("objects merge key by key, deeply", () => {
    expect(
      m(
        { theme: "dark", editor: { spell: false, font: 14 }, old: 1 },
        { theme: "dark", editor: { spell: true, font: 14 }, old: 1 },
        { theme: "light", editor: { spell: false, font: 16 } },
      ),
    ).toEqual({ theme: "light", editor: { spell: true, font: 16 } });
  });

  it("core plugins as a map of switches", () => {
    expect(
      m(
        { canvas: true, graph: true },
        { canvas: true, graph: true, sync: false },
        { canvas: false, graph: true },
      ),
    ).toEqual({ canvas: false, graph: true, sync: false });
  });

  it("the same value changed on both sides: the local write wins", () => {
    expect(m({ font: 14 }, { font: 15 }, { font: 16 })).toEqual({ font: 15 });
  });

  it("arrays of objects are values: the local write wins when both changed", () => {
    const base = { keys: [{ key: "a" }] };
    expect(m(base, { keys: [{ key: "b" }] }, { keys: [{ key: "c" }] })).toEqual({
      keys: [{ key: "b" }],
    });
    expect(m(base, base, { keys: [{ key: "c" }] })).toEqual({ keys: [{ key: "c" }] });
  });

  it("invalid JSON on any side: no merge", () => {
    expect(mergeJson3("{", j({}), j({}))).toBeNull();
    expect(mergeJson3(j({}), "nope", j({}))).toBeNull();
    expect(mergeJson3(j({}), j({}), "")).toBeNull();
  });

  it("nothing to take from theirs: the local text as it is, byte for byte", () => {
    const ours = '{"a":1,  "b":2}';
    expect(mergeJson3('{"a":1}', ours, '{"a":1}')).toBe(ours);
  });

  it("nothing new of ours: theirs exactly, byte for byte", () => {
    const theirs = '["kamino","excalidraw"]';
    expect(mergeJson3('["kamino"]', '[\n  "kamino"\n]', theirs)).toBe(theirs);
  });

  it("output is indented like Obsidian writes it", () => {
    expect(mergeJson3(j(["a"]), j(["a", "b"]), '["a","x"]')).toBe(j(["a", "b", "x"]));
  });
});

const json: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    fc.constantFrom(true, false, null, 0, 1, "a", "b"),
    fc.uniqueArray(fc.constantFrom("p", "q", "r", "s", "t"), { maxLength: 4 }),
    fc.dictionary(fc.constantFrom("k1", "k2", "k3"), tie("value"), { maxKeys: 3 }),
  ),
})).value;

describe("mergeJson3 properties", () => {
  it("only theirs changed → theirs; only ours changed → ours; same change → it", () => {
    fc.assert(
      fc.property(json, json, (b, x) => {
        expect(m(b, b, x)).toEqual(x);
        expect(m(b, x, b)).toEqual(x);
        expect(m(b, x, x)).toEqual(x);
      }),
    );
  });

  it("lists of names: every addition stays, every removal holds", () => {
    const names = fc.uniqueArray(fc.constantFrom("a", "b", "c", "d", "e", "f"), { maxLength: 6 });
    fc.assert(
      fc.property(names, names, names, (b, o, t) => {
        const r = m(b, o, t) as string[];
        for (const x of [...o, ...t]) if (!b.includes(x)) expect(r).toContain(x);
        for (const x of b) if (!o.includes(x) || !t.includes(x)) expect(r).not.toContain(x);
        expect(new Set(r).size).toBe(r.length);
      }),
    );
  });
});
