// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY } from "./ThemeProvider.js";

const src = readFileSync(join(import.meta.dirname, "../../public/theme-init.js"), "utf8");
const run = () => new Function(src)();

function stubPrefersDark(dark: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: dark && q.includes("dark") }));
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  vi.unstubAllGlobals();
});

describe("theme-init.js", () => {
  it("uses the same storage key as ThemeProvider", () => {
    expect(src).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });

  it.each([
    ["dark", false, true],
    ["light", true, false],
    ["system", true, true],
    [null, true, true],
    [null, false, false],
  ] as const)("stored %s, prefers dark %s -> dark %s", (stored, prefersDark, expected) => {
    if (stored) localStorage.setItem(THEME_STORAGE_KEY, stored);
    stubPrefersDark(prefersDark);
    run();
    expect(document.documentElement.classList.contains("dark")).toBe(expected);
  });

  it("falls back to the system preference when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    stubPrefersDark(true);
    run();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
