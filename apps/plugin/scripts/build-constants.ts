import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codenameFor, type Registry } from "@kamino/brand";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginRoot, "../..");

export const PLUGIN_ROOT = pluginRoot;

/** Plugin version, read from this package's package.json. */
export function pluginVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve(pluginRoot, "package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

/**
 * Compile-time constants (esbuild/Vitest `define`): version and release codename,
 * resolved from the root registry at build time, never read at runtime;
 * `__DEV__` enables development-only code (status gallery).
 */
export function buildConstants(opts: { dev: boolean } = { dev: false }): Record<string, string> {
  const version = pluginVersion();
  const registry = JSON.parse(
    readFileSync(resolve(repoRoot, "release-names.json"), "utf8"),
  ) as Registry;
  return {
    __APP_VERSION__: JSON.stringify(version),
    __APP_CODENAME__: JSON.stringify(codenameFor(version, registry)),
    __DEV__: JSON.stringify(opts.dev),
  };
}
