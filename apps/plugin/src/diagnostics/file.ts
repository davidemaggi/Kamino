import type { DataAdapter } from "obsidian";

type Adapter = Pick<DataAdapter, "exists" | "read" | "write" | "rename" | "remove">;

/** The saved log, or the temporary copy left by an interrupted save, or "". */
export async function loadText(a: Adapter, path: string): Promise<string> {
  for (const p of [path, `${path}.tmp`]) {
    if (await a.exists(p)) return a.read(p).catch(() => "");
  }
  return "";
}

/** Writes beside the target, then swaps it in: the old log stays whole until the new one is. */
export async function saveText(a: Adapter, path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await a.write(tmp, text);
  if (await a.exists(path)) await a.remove(path);
  await a.rename(tmp, path);
}
