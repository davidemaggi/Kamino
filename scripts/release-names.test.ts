import { describe, expect, it } from "vitest";
import { codenameFor, validateRegistry, type Registry } from "./release-names.js";

const base: Registry = {
  entries: [
    { range: "0.x", codename: "Ash", date: null },
    { range: "1.0", codename: "Ash", date: null },
  ],
};
const withAlison: Registry = {
  entries: [...base.entries, { range: "1.1", codename: "Alison", date: null }],
};

describe("codenameFor", () => {
  it("names every 0.x and 1.0 release Ash", () => {
    expect(codenameFor("0.3.7", base)).toBe("Ash");
    expect(codenameFor("1.0.4", base)).toBe("Ash");
  });
  it("resolves a MAJOR.MINOR entry", () => {
    expect(codenameFor("1.1.2", withAlison)).toBe("Alison");
  });
  it("throws naming the missing MAJOR.MINOR", () => {
    expect(() => codenameFor("1.2.0", withAlison)).toThrow(/1\.2/);
  });
});

describe("validateRegistry", () => {
  it("accepts the initial registry", () => {
    expect(validateRegistry(withAlison)).toEqual([]);
  });
  it("flags an initial that does not match the MAJOR", () => {
    const errors = validateRegistry({ entries: [{ range: "2.0", codename: "Cody", date: null }] });
    expect(errors.length).toBeGreaterThan(0);
  });
  it("flags a reused name case-insensitively", () => {
    const errors = validateRegistry({
      entries: [
        { range: "2.0", codename: "Rex", date: null },
        { range: "2.1", codename: "rex", date: null },
      ],
    });
    expect(errors.some((e) => /rex/i.test(e) && /reus|twice|duplic/i.test(e))).toBe(true);
  });
  it("flags Ash outside 0.x and 1.0", () => {
    const errors = validateRegistry({
      entries: [...base.entries, { range: "1.1", codename: "Ash", date: null }],
    });
    expect(errors.some((e) => /ash/i.test(e) && /1\.1/.test(e))).toBe(true);
  });
});
