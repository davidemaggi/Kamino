import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "../src");
/** U-03: the admin module reads aggregates only; these modules decrypt vault data. */
const FORBIDDEN = [
  "vaults/vault-crypto.ts",
  "crypto/dek.ts",
  "crypto/field.ts",
  "sync/commit.ts",
  "blobs/uploads.ts",
];

/** Every local module reachable from `entry` at runtime (`import type` is erased, so skipped). */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(
      /^(import|export)\s+(type\s+)?[^;]*?from\s+["'](\.[^"']+)["']/gms,
    )) {
      if (m[2]) continue;
      const p = resolve(dirname(f), m[3]!.replace(/\.js$/, ".ts"));
      if (existsSync(p)) stack.push(p);
    }
  }
  return seen;
}

describe("admin module architecture", () => {
  it("nothing under src/admin reaches a module that decrypts vault data", () => {
    const dir = join(SRC, "admin");
    const files = existsSync(dir)
      ? readdirSync(dir, { recursive: true })
          .map(String)
          .filter((f) => f.endsWith(".ts"))
          .map((f) => join(dir, f))
      : [];
    const bad: string[] = [];
    for (const f of files)
      for (const r of reachable(f)) {
        const rel = relative(SRC, r);
        if (FORBIDDEN.includes(rel)) bad.push(`${relative(SRC, f)} → ${rel}`);
      }
    expect(bad).toEqual([]);
  });

  it("the check sees forbidden modules (self-test on a module that uses them)", () => {
    const hits = [...reachable(join(SRC, "history/service.ts"))].map((r) => relative(SRC, r));
    expect(hits.some((h) => FORBIDDEN.includes(h))).toBe(true);
  });
});
