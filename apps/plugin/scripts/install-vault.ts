// Copies the built plugin (dist/) into the local test vault:
// <repo>/vault/kamino/.obsidian/plugins/<PLUGIN_ID>/ (vault/ is gitignored).
// Override the vault folder with the first CLI argument.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { argv, exit } from "node:process";
import { PLUGIN_ID } from "@kamino/brand";
import { PLUGIN_ROOT } from "./build-constants.js";

const vault = resolve(argv[2] ?? resolve(PLUGIN_ROOT, "../../vault/kamino"));
if (!existsSync(resolve(vault, ".obsidian"))) {
  console.error(`Not an Obsidian vault (no .obsidian folder): ${vault}`);
  exit(1);
}
const target = resolve(vault, ".obsidian/plugins", PLUGIN_ID);
mkdirSync(target, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) {
  copyFileSync(resolve(PLUGIN_ROOT, "dist", f), resolve(target, f));
}
console.log(`Installed ${PLUGIN_ID} into ${target}`);
