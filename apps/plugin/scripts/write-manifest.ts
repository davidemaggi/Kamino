import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PLUGIN_ID, PRODUCT_NAME } from "@kamino/brand";
import { pluginVersion } from "./build-constants.js";

/** Lowest Obsidian version we support; recorded in versions.json too. */
export const MIN_APP_VERSION = "1.5.0";

export function buildManifest() {
  return {
    id: PLUGIN_ID,
    name: PRODUCT_NAME,
    version: pluginVersion(),
    minAppVersion: MIN_APP_VERSION,
    description: "Self-hosted sync for your vaults across desktop and mobile.",
    author: "Davide Maggi",
    isDesktopOnly: false,
  };
}

export function writeManifest(distDir: string): void {
  writeFileSync(resolve(distDir, "manifest.json"), `${JSON.stringify(buildManifest(), null, 2)}\n`);
}
