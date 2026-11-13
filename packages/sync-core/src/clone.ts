/**
 * Deep copy of plain JSON data, with the JSON round trip's semantics (undefined properties
 * dropped, undefined array slots become null) at a fraction of its cost: `step` copies the whole
 * durable state on every event, so with 10,000 files this is the client's hottest line (M7c C1).
 */
export function cloneJson<T>(v: T): T {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return null as T;
      if (Object.is(v, -0)) return 0 as T;
    }
    return v;
  }
  if (Array.isArray(v)) {
    const out = new Array<unknown>(v.length);
    for (let i = 0; i < v.length; i++) {
      const x: unknown = v[i];
      out[i] = x === undefined ? null : cloneJson(x);
    }
    return out as T;
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    const x = (v as Record<string, unknown>)[k];
    if (x === undefined) continue;
    // A "__proto__" key stays an own property, as with JSON.parse (never the prototype).
    if (k === "__proto__")
      Object.defineProperty(out, k, {
        value: cloneJson(x),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    else out[k] = cloneJson(x);
  }
  return out as T;
}
