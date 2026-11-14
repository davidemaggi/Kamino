// Release helpers for the plugin (ADR 0011, M7c C3). Run through tsx:
//   tsx scripts/release.ts versions   → records the current version in versions.json and copies
//                                       manifest.json + versions.json to the repo root (store)
//   tsx scripts/release.ts info       → JSON { tag, title, prerelease } for the release workflow
//   tsx scripts/release.ts notes      → the current version's CHANGELOG section
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { codenameFor, PRODUCT_NAME, type Registry } from "@kamino/brand";
import { PLUGIN_ROOT } from "./build-constants.js";
import { buildManifest, MIN_APP_VERSION } from "./write-manifest.js";

export type Paths = { pluginRoot: string; repoRoot: string; registryFile: string };

const DEFAULT_PATHS: Paths = {
  pluginRoot: PLUGIN_ROOT,
  repoRoot: resolve(PLUGIN_ROOT, "../.."),
  registryFile: resolve(PLUGIN_ROOT, "../../release-names.json"),
};

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

function versionOf(p: Paths): string {
  return readJson<{ version: string }>(resolve(p.pluginRoot, "package.json")).version;
}

/** Adds `version → minAppVersion` to versions.json; false when it was already there. */
export function updateVersions(p: Paths = DEFAULT_PATHS, minApp = MIN_APP_VERSION): boolean {
  const file = resolve(p.pluginRoot, "versions.json");
  const versions = readJson<Record<string, string>>(file);
  const version = versionOf(p);
  if (versions[version] === minApp) return false;
  versions[version] = minApp;
  writeFileSync(file, `${JSON.stringify(versions, null, 2)}\n`);
  return true;
}

/**
 * The Obsidian community store reads manifest.json and versions.json from the root of the default
 * branch: copies of the plugin's, rewritten at every release so they never drift.
 */
export function writeRootFiles(p: Paths = DEFAULT_PATHS): void {
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  writeFileSync(resolve(p.repoRoot, "manifest.json"), json(buildManifest(versionOf(p))));
  const versions = readJson<Record<string, string>>(resolve(p.pluginRoot, "versions.json"));
  writeFileSync(resolve(p.repoRoot, "versions.json"), json(versions));
}

/** Tag (the bare version, as Obsidian and BRAT expect), title with the codename, pre-release flag. */
export function releaseInfo(
  p: Paths = DEFAULT_PATHS,
  minApp = MIN_APP_VERSION,
): { tag: string; title: string; prerelease: boolean } {
  const version = versionOf(p);
  const versions = readJson<Record<string, string>>(resolve(p.pluginRoot, "versions.json"));
  if (versions[version] !== minApp)
    throw new Error(`versions.json has no entry "${version}": "${minApp}" (run release:version)`);
  const codename = codenameFor(version, readJson<Registry>(p.registryFile));
  return {
    tag: version,
    title: `${PRODUCT_NAME} ${version} "${codename}"`,
    prerelease: version.startsWith("0.") || version.includes("-"),
  };
}

/** The body of `## <version>` in a changesets CHANGELOG, or "" when there is none. */
export function releaseNotes(changelog: string, version: string): string {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  if (cmd === "versions") {
    console.log(updateVersions() ? "versions.json updated" : "versions.json already current");
    writeRootFiles();
  } else if (cmd === "info") {
    console.log(JSON.stringify(releaseInfo()));
  } else if (cmd === "notes") {
    const file = resolve(PLUGIN_ROOT, "CHANGELOG.md");
    const v = versionOf(DEFAULT_PATHS);
    console.log(
      (existsSync(file) && releaseNotes(readFileSync(file, "utf8"), v)) || `Version ${v}.`,
    );
  } else {
    console.error("usage: release.ts versions|info|notes");
    process.exit(2);
  }
}
