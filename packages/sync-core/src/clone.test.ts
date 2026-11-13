import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cloneJson } from "./clone.js";

describe("cloneJson (M7c: replaces the JSON round trip in step)", () => {
  it("equals JSON.parse(JSON.stringify(v)) on any JSON value", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(cloneJson(v)).toEqual(JSON.parse(JSON.stringify(v)));
      }),
      { numRuns: 2000 },
    );
  });

  it("drops undefined properties and keeps null, like JSON", () => {
    expect(cloneJson({ a: undefined, b: null, c: [undefined, 1] })).toEqual({
      b: null,
      c: [null, 1],
    });
  });

  it("-0 becomes 0 and a __proto__ key stays data", () => {
    expect(Object.is(cloneJson(-0), 0)).toBe(true);
    const c = cloneJson(JSON.parse('{"__proto__":{"polluted":1}}') as Record<string, unknown>);
    expect(Object.getPrototypeOf(c)).toBe(Object.prototype);
    expect(Object.keys(c)).toEqual(["__proto__"]);
  });

  it("shares nothing with the input", () => {
    const v = {
      index: { f: { path: "a.md", pendingWrite: { hash: "h" } } },
      sent: [{ opId: "1" }],
    };
    const c = cloneJson(v);
    c.index.f.pendingWrite.hash = "changed";
    c.sent[0]!.opId = "2";
    expect(v.index.f.pendingWrite.hash).toBe("h");
    expect(v.sent[0]!.opId).toBe("1");
  });
});
