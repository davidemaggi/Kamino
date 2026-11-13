import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "@kamino/brand";
import { releaseInfo, releaseNotes, updateVersions } from "../scripts/release.js";

const registry = {
  entries: [
    { range: "0.x", codename: "Ash", date: null, notes: "pre-release" },
    { range: "1.0", codename: "Ash", date: null, notes: "first" },
  ],
};

describe("plugin release helpers (M7c C3)", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  function fixture(version: string, versions: Record<string, string>) {
    dir = mkdtempSync(join(tmpdir(), "kamino-release-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
    writeFileSync(join(dir, "versions.json"), JSON.stringify(versions));
    writeFileSync(join(dir, "release-names.json"), JSON.stringify(registry));
    return {
      pluginRoot: dir,
      registryFile: join(dir, "release-names.json"),
    };
  }

  it("adds the current version to versions.json, keeping the old ones", () => {
    const p = fixture("0.2.0", { "0.1.0": "1.5.0" });
    expect(updateVersions(p, "1.5.0")).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "versions.json"), "utf8"))).toEqual({
      "0.1.0": "1.5.0",
      "0.2.0": "1.5.0",
    });
    expect(updateVersions(p, "1.5.0")).toBe(false);
  });

  it("release info: tag = version (no v), codename in the title, 0.x is a pre-release", () => {
    const p = fixture("0.2.0", { "0.2.0": "1.5.0" });
    expect(releaseInfo(p, "1.5.0")).toEqual({
      tag: "0.2.0",
      title: `${PRODUCT_NAME} 0.2.0 "Ash"`,
      prerelease: true,
    });
    const q = fixture("1.0.0", { "1.0.0": "1.5.0" });
    expect(releaseInfo(q, "1.5.0").prerelease).toBe(false);
  });

  it("refuses a release whose version is missing from versions.json", () => {
    const p = fixture("0.3.0", { "0.2.0": "1.5.0" });
    expect(() => releaseInfo(p, "1.5.0")).toThrow(/versions\.json/);
  });

  it("release notes: the version's section of the changelog", () => {
    const log = "# @kamino/plugin\n\n## 0.3.0\n\n### Minor Changes\n\n- new\n\n## 0.2.0\n\n- old\n";
    expect(releaseNotes(log, "0.3.0")).toBe("### Minor Changes\n\n- new");
    expect(releaseNotes(log, "0.9.0")).toBe("");
  });
});
