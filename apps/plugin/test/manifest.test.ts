import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PLUGIN_ID, PRODUCT_NAME } from "@kamino/brand";

const root = resolve(import.meta.dirname, "..");
const read = (p: string): string => readFileSync(resolve(root, p), "utf8");

interface Manifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description: string;
  author: string;
  isDesktopOnly: boolean;
}

describe("plugin build output", () => {
  let manifest: Manifest;
  beforeAll(() => {
    execFileSync(
      process.execPath,
      [resolve(root, "../../node_modules/tsx/dist/cli.mjs"), "esbuild.config.mjs"],
      {
        cwd: root,
        stdio: "ignore",
      },
    );
    manifest = JSON.parse(read("dist/manifest.json")) as Manifest;
  });

  it("takes id and name from brand", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.name).toBe(PRODUCT_NAME);
  });

  it("is mobile compatible and id has no 'obsidian'", () => {
    expect(manifest.isDesktopOnly).toBe(false);
    expect(manifest.id.toLowerCase()).not.toContain("obsidian");
    expect(manifest.description.toLowerCase()).not.toContain("obsidian");
  });

  it("version matches package.json", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(manifest.version).toBe(pkg.version);
  });

  it("versions.json maps version to minAppVersion", () => {
    const versions = JSON.parse(read("versions.json")) as Record<string, string>;
    expect(versions[manifest.version]).toBe(manifest.minAppVersion);
  });

  it("ships main.js and styles.css", () => {
    expect(read("dist/main.js").length).toBeGreaterThan(0);
    expect(read("dist/styles.css")).toBeDefined();
  });

  it("bundle uses no Node/Electron modules", () => {
    const bundle = read("dist/main.js");
    const forbidden =
      /require[(]\s*["'](?:node:)?(?:fs|path|crypto|os|net|http|https|child_process|electron)["']\s*[)]/;
    expect(bundle).not.toMatch(forbidden);
  });
});
