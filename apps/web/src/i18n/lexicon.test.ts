import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(import.meta.dirname, "locales");
const THEMED = /clone|jango|ordine 66|kaminoan|jedi/i;

function keyPaths(node: unknown, prefix = ""): string[] {
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([k, v]) => keyPaths(v, `${prefix}${k}.`));
  }
  return [prefix];
}

function values(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (node && typeof node === "object") return Object.values(node).flatMap(values);
  return [];
}

describe("translations", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  it("has it and en", () => {
    expect(files.sort()).toEqual(["en.json", "it.json"]);
  });
  for (const f of files) {
    it(`${f} contains no themed lexicon`, () => {
      const all = values(JSON.parse(readFileSync(join(dir, f), "utf8")));
      expect(all.length).toBeGreaterThan(0);
      for (const v of all) expect(v).not.toMatch(THEMED);
    });
  }
  it("it and en have the same keys", () => {
    const keys = (f: string) =>
      keyPaths(JSON.parse(readFileSync(join(dir, f), "utf8"))).sort();
    expect(keys("it.json")).toEqual(keys("en.json"));
  });
});
