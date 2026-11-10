import { PLUGIN_ID } from "@kamino/brand";
import { sha256Hex } from "@kamino/sync-engine";
import { App, type MockAdapter } from "../__mocks__/obsidian.js";
import { beforeEach, describe, expect, it } from "vitest";
import { ObsidianFs } from "./obsidian-fs.js";

const PLUGIN_DIR = `.obsidian/plugins/${PLUGIN_ID}`;
const enc = (s: string) => new TextEncoder().encode(s);
async function* parts(...xs: string[]): AsyncIterable<Uint8Array> {
  for (const x of xs) yield enc(x);
}
const hashOf = (s: string) => sha256Hex(parts(s));
const text = (a: MockAdapter, p: string) => new TextDecoder().decode(a.files.get(p)?.data);

let app: App;
let adapter: MockAdapter;
let fs: ObsidianFs;
beforeEach(() => {
  app = new App();
  adapter = app.vault.adapter as unknown as MockAdapter;
  // No fetch on resource URLs in the tests: reads fall back to readBinary.
  fs = new ObsidianFs(app as never, PLUGIN_DIR, { fetch: undefined });
});

describe("ObsidianFs", () => {
  it("lists files with sizes and folders, without the plugin's own folder", async () => {
    await adapter.write("notes/a.md", "hello");
    await adapter.mkdir("empty");
    await adapter.write(`${PLUGIN_DIR}/state/durable.json`, "{}");
    await adapter.write(".obsidian/app.json", "{}");
    const list = await fs.list();
    const files = list.filter((e) => e.kind === "file").map((e) => [e.path, e.size]);
    expect(files.sort()).toEqual([
      [".obsidian/app.json", 2],
      ["notes/a.md", 5],
    ]);
    expect(list.filter((e) => e.kind === "folder").map((e) => e.path)).toEqual(
      expect.arrayContaining(["notes", "empty", ".obsidian"]),
    );
    expect(list.some((e) => e.path.startsWith(PLUGIN_DIR))).toBe(false);
  });

  it("writes through a temporary file, verifying the hash, with appendBinary", async () => {
    const out = await fs.write("d/new.md", parts("ab", "cd"), null, await hashOf("abcd"));
    expect(out).toBe("ok");
    expect(text(adapter, "d/new.md")).toBe("abcd");
    expect([...adapter.files.keys()].filter((p) => p.includes("/tmp/"))).toEqual([]);
    expect(fs.streaming).toBe(false); // no fetch on resource URLs here
    const withFetch = new ObsidianFs(app as never, PLUGIN_DIR, {
      fetch: async () => ({ ok: false, body: null }),
    });
    expect(withFetch.streaming).toBe(true);
  });

  it("falls back to writeBinary without appendBinary (Obsidian < 1.12.3)", async () => {
    adapter.appendBinary = undefined;
    const fallback = new ObsidianFs(app as never, PLUGIN_DIR, { fetch: undefined });
    expect(fallback.streaming).toBe(false);
    expect(await fallback.write("a.md", parts("x", "y"), null, await hashOf("xy"))).toBe("ok");
    expect(text(adapter, "a.md")).toBe("xy");
  });

  it("refuses to write over content it didn't expect, and never leaves a corrupt file", async () => {
    await adapter.write("a.md", "mine");
    expect(await fs.write("a.md", parts("theirs"), null, await hashOf("theirs"))).toBe("changed");
    expect(
      await fs.write("a.md", parts("theirs"), await hashOf("mine"), await hashOf("other")),
    ).toBe("corrupt");
    expect(text(adapter, "a.md")).toBe("mine");
    expect(
      await fs.write("a.md", parts("theirs"), await hashOf("mine"), await hashOf("theirs")),
    ).toBe("ok");
    expect(text(adapter, "a.md")).toBe("theirs");
    expect([...adapter.files.keys()].filter((p) => p.includes("/tmp/"))).toEqual([]);
  });

  it("reads a file in pieces that hash to the whole", async () => {
    await adapter.write("a.md", "content");
    expect(await sha256Hex(fs.read("a.md"))).toBe(await hashOf("content"));
  });

  it("renames only onto a free path, trashes to the system trash, removes empty folders", async () => {
    await adapter.write("a.md", "1");
    await adapter.write("b.md", "2");
    expect(await fs.rename("a.md", "b.md")).toBe(false);
    expect(await fs.rename("a.md", "x/c.md")).toBe(true);
    expect(text(adapter, "x/c.md")).toBe("1");
    expect(await fs.trash("b.md")).toBe(true);
    expect(adapter.trashed).toEqual(["b.md"]);
    await fs.mkdir("e/f");
    expect(await fs.rmdirIfEmpty("e")).toBe(false);
    expect(await fs.rmdirIfEmpty("e/f")).toBe(true);
  });

  it("saves state atomically and recovers a save interrupted after the old file was removed", async () => {
    await fs.saveState("durable", "one");
    await fs.saveState("durable", "two");
    expect(await fs.loadState("durable")).toBe("two");
    expect(await fs.loadState("missing")).toBeNull();
    // Crash between removing the old file and renaming the new one into place.
    await adapter.write(`${PLUGIN_DIR}/state/cache.json.tmp`, "three");
    expect(await fs.loadState("cache")).toBe("three");
  });
});
