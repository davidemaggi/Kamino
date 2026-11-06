import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type RegistryEntry = {
  /** "0.x" or MAJOR.MINOR (e.g. "1.0", "1.1", "2.0"). */
  range: string;
  codename: string;
  date: string | null;
  notes?: string;
};
export type Registry = { entries: RegistryEntry[] };

const RANGE_RE = /^(?:0\.x|(?:[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const RESERVED = "ash";
const isAshRange = (range: string): boolean => range === "0.x" || range === "1.0";

function rangeOf(version: string): string {
  const m = /^(\d+)\.(\d+)\.\d+/.exec(version);
  if (!m) throw new Error(`Invalid version "${version}": expected MAJOR.MINOR.PATCH`);
  return m[1] === "0" ? "0.x" : `${m[1]}.${m[2]}`;
}

export function codenameFor(version: string, registry: Registry): string {
  const range = rangeOf(version);
  const entry = registry.entries.find((e) => e.range === range);
  if (!entry) {
    throw new Error(
      `No codename registered for ${range} (version ${version}) in release-names.json`,
    );
  }
  return entry.codename;
}

export function validateRegistry(registry: Registry): string[] {
  const errors: string[] = [];
  const seenRanges = new Set<string>();
  const nameOwners = new Map<string, string>();

  for (const { range, codename } of registry.entries) {
    if (!RANGE_RE.test(range)) {
      errors.push(`Invalid range "${range}": expected "0.x" or MAJOR.MINOR`);
      continue;
    }
    if (seenRanges.has(range)) errors.push(`Range ${range} is listed more than once`);
    seenRanges.add(range);

    const key = codename.trim().toLowerCase();
    if (key === "") {
      errors.push(`Range ${range} has an empty codename`);
      continue;
    }

    if (key === RESERVED) {
      if (!isAshRange(range)) {
        errors.push(`Ash is reserved for 0.x and 1.0, cannot be used for ${range}`);
      }
      continue; // Ash is intentionally shared by 0.x and 1.0
    }
    if (isAshRange(range)) {
      errors.push(`Range ${range} must be named Ash, found "${codename}"`);
      continue;
    }

    const major = Number(range.split(".")[0]);
    const expected = String.fromCharCode("A".charCodeAt(0) + major - 1);
    if (codename.trim().charAt(0).toUpperCase() !== expected) {
      errors.push(
        `Codename "${codename}" for ${range} must start with "${expected}" (MAJOR ${major})`,
      );
    }

    const owner = nameOwners.get(key);
    if (owner !== undefined) {
      errors.push(
        `Codename "${codename}" is reused: ${owner} and ${range} (names are never reused)`,
      );
    } else {
      nameOwners.set(key, range);
    }
  }
  return errors;
}

function readVersion(root: string): { version: string; source: string } {
  const server = resolve(root, "apps/server/package.json");
  const source = existsSync(server) ? server : resolve(root, "package.json");
  const pkg = JSON.parse(readFileSync(source, "utf8")) as { version?: string };
  if (!pkg.version) throw new Error(`${source} has no "version"`);
  return { version: pkg.version, source };
}

export function main(root = resolve(fileURLToPath(import.meta.url), "../..")): number {
  const registry = JSON.parse(
    readFileSync(resolve(root, "release-names.json"), "utf8"),
  ) as Registry;
  const errors = validateRegistry(registry);
  if (errors.length > 0) {
    for (const e of errors) console.error(`release-names: ${e}`);
    return 1;
  }
  const { version, source } = readVersion(root);
  try {
    console.log(`release-names: ${version} (${source}) -> ${codenameFor(version, registry)}`);
  } catch (e) {
    console.error(`release-names: ${(e as Error).message}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
