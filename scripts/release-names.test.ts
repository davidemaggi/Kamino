import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "./release-names.js";

function fixture(version: string, entries: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), "release-names-"));
  mkdirSync(join(root, "apps/server"), { recursive: true });
  writeFileSync(join(root, "release-names.json"), JSON.stringify({ entries }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  return root;
}

describe("release-names CLI", () => {
  it("returns 0 for a valid registry and resolvable version", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = fixture("0.1.0", [{ range: "0.x", codename: "Ash", date: null }]);
    expect(main(root)).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Ash"));
    log.mockRestore();
  });
  it("returns 1 when the version has no registered codename", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const root = fixture("1.2.0", [{ range: "0.x", codename: "Ash", date: null }]);
    expect(main(root)).toBe(1);
    err.mockRestore();
  });
});
