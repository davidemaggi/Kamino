import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

it("has exactly one migration (tripwire for ruling R16)", () => {
  const journal = JSON.parse(
    readFileSync(join(import.meta.dirname, "../drizzle/meta/_journal.json"), "utf8"),
  ) as { entries: unknown[] };
  expect(
    journal.entries.length,
    "R16: a second migration was added. Reorder startup in src/main.ts (see the TODO there): " +
      "run the key_check migration, verify the master key, then apply the rest. " +
      "Then update this test.",
  ).toBe(1);
});
