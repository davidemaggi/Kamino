// Run through tsx (see package.json) so it can import the TypeScript helpers.
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { argv } from "node:process";
import { build } from "esbuild";
import { buildConstants, PLUGIN_ROOT } from "./scripts/build-constants.ts";
import { writeManifest } from "./scripts/write-manifest.ts";

const dev = argv.includes("--dev");
const dist = resolve(PLUGIN_ROOT, "dist");
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [resolve(PLUGIN_ROOT, "src/main.ts")],
  outfile: resolve(dist, "main.js"),
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  define: buildConstants({ dev }),
  // Drops `if (false) { ... }` branches, so dev-only code is not shipped.
  minifySyntax: !dev,
  logLevel: "warning",
});

copyFileSync(resolve(PLUGIN_ROOT, "src/styles.css"), resolve(dist, "styles.css"));
writeManifest(dist);
