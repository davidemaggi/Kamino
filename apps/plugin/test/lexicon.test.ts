import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Themed lexicon is forbidden in UI texts (docs/glossary.md).
const dir = join(import.meta.dirname, "../src/i18n");
const THEMED = /clone|jango|ordine 66|kaminoan|jedi/i;

function load(f: string): unknown {
  return JSON.parse(readFileSync(join(dir, f), "utf8"));
}

function values(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (node && typeof node === "object") return Object.values(node).flatMap(values);
  return [];
}

function keyPaths(node: unknown, prefix = ""): string[] {
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([k, v]) => keyPaths(v, `${prefix}${k}.`));
  }
  return [prefix];
}

describe("plugin translations", () => {
  for (const f of ["it.json", "en.json"]) {
    it(`${f} contains no themed lexicon`, () => {
      const all = values(load(f));
      expect(all.length).toBeGreaterThan(0);
      for (const v of all) expect(v).not.toMatch(THEMED);
    });
  }
  it("it and en have the same keys", () => {
    expect(keyPaths(load("it.json")).sort()).toEqual(keyPaths(load("en.json")).sort());
  });
});
