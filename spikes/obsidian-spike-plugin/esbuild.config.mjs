// Builds the spike plugin twice:
//   dist/          variant "external": @codemirror/state, view, language, @lezer/* come
//                  from Obsidian at runtime; only @codemirror/merge is bundled.
//   dist-bundled/  variant "bundled": everything but "obsidian" is bundled (own
//                  CodeMirror copy), the R-3 fallback if "external" fails.
// NOTE: the externals are an explicit list, NOT "@codemirror/*": a wildcard would
// externalize @codemirror/merge too, which Obsidian does not provide.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const spikesRoot = resolve(here, "..");
const mergePkg = JSON.parse(
  readFileSync(resolve(spikesRoot, "node_modules/@codemirror/merge/package.json"), "utf8"),
);

// Same list as the official obsidian-sample-plugin.
const OBSIDIAN_PROVIDED = [
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
];

const manifest = {
  id: "kamino-spike",
  name: "Kamino spike (M0, throwaway)",
  version: "0.0.1",
  minAppVersion: "1.12.3",
  description: "Throwaway measurements for Kamino M0 risks R-1..R-5. Not for real vaults.",
  author: "Davide Maggi",
  isDesktopOnly: false,
};

const variants = [
  { dir: "dist", name: "external", external: OBSIDIAN_PROVIDED },
  { dir: "dist-bundled", name: "bundled", external: ["obsidian", "electron"] },
];

for (const v of variants) {
  const out = resolve(here, v.dir);
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [resolve(here, "src/main.ts")],
    outfile: resolve(out, "main.js"),
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    external: v.external,
    define: {
      __SPIKE_VARIANT__: JSON.stringify(v.name),
      __CM_MERGE_VERSION__: JSON.stringify(mergePkg.version),
    },
    logLevel: "warning",
  });
  copyFileSync(resolve(here, "src/styles.css"), resolve(out, "styles.css"));
  writeFileSync(resolve(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`built ${v.dir}/ (variant ${v.name}, @codemirror/merge ${mergePkg.version})`);
}
