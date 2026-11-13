// Run through tsx (see package.json) so it can import the TypeScript helpers.
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { argv } from "node:process";
import { build } from "esbuild";
import { onlyEnglishZodLocale } from "./scripts/zod-locales.ts";
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
  // Provided by Obsidian at runtime. @codemirror/merge is NOT here: it is bundled.
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
  ],
  define: buildConstants({ dev }),
  plugins: [onlyEnglishZodLocale],
  // Production: minified (drops `if (false) { ... }` branches too, so dev-only code is not shipped).
  minify: !dev,
  logLevel: "warning",
});

copyFileSync(resolve(PLUGIN_ROOT, "src/styles.css"), resolve(dist, "styles.css"));
writeManifest(dist);
