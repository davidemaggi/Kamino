import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codenameFor, validateRegistry, type Registry } from "@kamino/brand";

function readVersion(root: string): { version: string; source: string } {
  const server = resolve(root, "apps/server/package.json");
  const source = existsSync(server) ? server : resolve(root, "package.json");
  const pkg = JSON.parse(readFileSync(source, "utf8")) as { version?: string };
  if (!pkg.version) throw new Error(`${source} has no "version"`);
  return { version: pkg.version, source };
}

export function main(root = resolve(fileURLToPath(import.meta.url), "../..")): number {
  try {
    const registry = JSON.parse(
      readFileSync(resolve(root, "release-names.json"), "utf8"),
    ) as Registry;
    if (typeof registry !== "object" || registry === null || !Array.isArray(registry.entries))
      throw new Error('release-names.json must be an object with an "entries" array');
    const errors = validateRegistry(registry);
    if (errors.length > 0) {
      for (const e of errors) console.error(`release-names: ${e}`);
      return 1;
    }
    const { version, source } = readVersion(root);
    console.log(`release-names: ${version} (${source}) -> ${codenameFor(version, registry)}`);
    return 0;
  } catch (e) {
    console.error(`release-names: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
