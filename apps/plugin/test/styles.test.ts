import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEVELS } from "@kamino/status";
import { describe, expect, it } from "vitest";
import { levelClass, STATUS_CLASS } from "../src/ui/status-classes.js";

const css = readFileSync(join(import.meta.dirname, "../src/styles.css"), "utf8");

describe("styles.css", () => {
  it("defines a class per level using the brand prefix", () => {
    expect(css).toContain(`.${STATUS_CLASS} `);
    for (const l of LEVELS) expect(css).toContain(`.${levelClass(l)}`);
  });

  it("uses only Obsidian variables for colors", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  });
});
