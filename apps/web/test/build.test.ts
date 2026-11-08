// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
let out: string;
let files: string[];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "web-build-"));
  // Vitest sets NODE_ENV=test, which makes Vite treat the build as dev
  // (import.meta.env.DEV = true). Build exactly like `vite build` does.
  const prevEnv = process.env["NODE_ENV"];
  process.env["NODE_ENV"] = "production";
  try {
    await build({
      root,
      configFile: join(root, "vite.config.ts"),
      mode: "production",
      logLevel: "silent",
      build: { outDir: out, emptyOutDir: true },
    });
  } finally {
    if (prevEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = prevEnv;
  }
  files = walk(out);
}, 120_000);

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("production build", () => {
  it("does not ship the dev gallery", () => {
    for (const f of files.filter((x) => /\.(js|html)$/.test(x))) {
      expect(readFileSync(f, "utf8"), f).not.toContain("data-dev-gallery");
    }
  });

  it("does not load fonts from external hosts", () => {
    for (const f of files.filter((x) => x.endsWith(".css"))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/url\(\s*["']?https?:/);
    }
    expect(files.some((f) => f.endsWith(".woff2"))).toBe(true);
  });

  it("does not ship the fake API", () => {
    for (const f of files.filter((x) => /\.(js|html)$/.test(x))) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toContain("mockServiceWorker");
      expect(text, f).not.toContain("data-msw");
      expect(text, f).not.toContain("admin-password-1");
    }
    expect(files.some((f) => f.endsWith("mockServiceWorker.js"))).toBe(false);
  });

  it("keeps every chunk under 500 KB (heavy routes are lazy)", () => {
    for (const f of files.filter((x) => x.endsWith(".js"))) {
      expect(statSync(f).size, f).toBeLessThan(500 * 1024);
    }
  });

  it("injects the product name into the title", () => {
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toMatch(/<title>[^%<]+<\/title>/);
  });
});
