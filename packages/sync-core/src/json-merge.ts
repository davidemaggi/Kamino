/**
 * Three-way merge of a JSON configuration file (ADR-0020). Obsidian and its plugins rewrite these
 * files from what they hold in memory: `base` is what the writer knew, `ours` what it wrote,
 * `theirs` what had arrived meanwhile. Objects merge key by key, lists of names as sets; a value
 * both sides changed keeps ours (the latest write, as before). null = some side isn't JSON.
 */
export function mergeJson3(base: string, ours: string, theirs: string): string | null {
  let b: unknown, o: unknown, t: unknown;
  try {
    b = JSON.parse(base);
    o = JSON.parse(ours);
    t = JSON.parse(theirs);
  } catch {
    return null;
  }
  const r = merge(b, o, t);
  // Byte for byte when nothing new comes out: nothing taken from theirs keeps the file as written;
  // nothing kept of ours restores theirs exactly (same hash: no new version to send).
  if (equal(r, o)) return ours;
  if (equal(r, t)) return theirs;
  return JSON.stringify(r, null, 2);
}

/** A key absent on one side. */
const MISSING = Symbol("missing");
type V = unknown;

function merge(b: V, o: V, t: V): V {
  if (equal(o, b)) return t;
  if (equal(t, b) || equal(o, t)) return o;
  if (isObject(o) && isObject(t)) {
    const base = isObject(b) ? b : {};
    const out: Record<string, V> = {};
    for (const k of new Set([...Object.keys(o), ...Object.keys(t)])) {
      const v = merge(at(base, k), at(o, k), at(t, k));
      if (v !== MISSING) out[k] = v;
    }
    return out;
  }
  if (isNames(o) && isNames(t) && (b === MISSING || isNames(b))) {
    const base = b === MISSING ? [] : b;
    const removed = (x: string | number | boolean) =>
      base.includes(x) && (!o.includes(x) || !t.includes(x));
    const out = o.filter((x) => !removed(x));
    for (const x of t) if (!base.includes(x) && !out.includes(x)) out.push(x);
    return [...new Set(out)];
  }
  return o;
}

function at(v: Record<string, V>, k: string): V {
  return Object.hasOwn(v, k) ? v[k] : MISSING;
}

function isObject(v: V): v is Record<string, V> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNames(v: V): v is (string | number | boolean)[] {
  return (
    Array.isArray(v) &&
    v.every((x) => typeof x === "string" || typeof x === "number" || typeof x === "boolean")
  );
}

function equal(a: V, b: V): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return (
      ka.length === Object.keys(b).length &&
      ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
    );
  }
  return false;
}
