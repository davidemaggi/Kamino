import { PLUGIN_ID } from "@kamino/brand";
import { describe, expect, it, vi } from "vitest";
import { MemoryFs } from "./memory-fs.js";
import { Scanner } from "./scanner.js";

describe("scanner", () => {
  it("hashes new or changed files only, with canonical paths", async () => {
    const fs = new MemoryFs();
    fs.put("a.md", "one");
    fs.put(".obsidian/app.json", "{}");
    fs.put(`.obsidian/plugins/${PLUGIN_ID}/state.json`, "{}");
    fs.put(".obsidian/workspace.json", "{}");
    const s = new Scanner(fs, ".obsidian");
    const read = vi.spyOn(fs, "read");
    const first = await s.scan();
    expect(first.files.map((f) => f.path).sort()).toEqual(["a.md", "{config}/app.json"]);
    expect(first.folders).toEqual(expect.arrayContaining(["{config}"]));
    expect(read).toHaveBeenCalledTimes(2);

    read.mockClear();
    await s.scan();
    expect(read).not.toHaveBeenCalled();

    fs.put("a.md", "two"); // new mtime
    const third = await s.scan();
    expect(read).toHaveBeenCalledTimes(1);
    expect(third.files.find((f) => f.path === "a.md")?.hash).not.toBe(
      first.files.find((f) => f.path === "a.md")?.hash,
    );
  });

  it("forgets removed files and reports unreadable ones", async () => {
    const fs = new MemoryFs();
    fs.put("a.md", "x");
    fs.put("b.md", "y");
    const s = new Scanner(fs, ".obsidian");
    await s.scan();
    fs.remove("a.md");
    vi.spyOn(fs, "read").mockImplementation(() => {
      throw new Error("locked");
    });
    fs.put("b.md", "z");
    const r = await s.scan();
    expect(r.files).toEqual([]);
    expect(r.unreadable).toEqual(["b.md"]);
    expect(Object.keys(s.cache)).toEqual([]);
  });

  it("the cache survives a restart", async () => {
    const fs = new MemoryFs();
    fs.put("a.md", "x");
    const s = new Scanner(fs, ".obsidian");
    await s.scan();
    const again = new Scanner(fs, ".obsidian", JSON.parse(JSON.stringify(s.cache)));
    const read = vi.spyOn(fs, "read");
    await again.scan();
    expect(read).not.toHaveBeenCalled();
  });
  it("rehashes a file modified in the last 2 s even if size and mtime look unchanged (M3)", async () => {
    let now = 1_000_000;
    const fs = new MemoryFs(() => now);
    fs.put("a.md", "one");
    const s = new Scanner(fs, ".obsidian", {}, { now: () => now });
    await s.scan();
    // Same size, same (coarse) mtime: an edit the stat cache can't see.
    fs.files.set("a.md", { data: new TextEncoder().encode("two"), mtime: now });
    const read = vi.spyOn(fs, "read");
    await s.scan();
    expect(read).toHaveBeenCalledTimes(1);
    now += 5_000;
    read.mockClear();
    await s.scan();
    await s.scan();
    expect(read).not.toHaveBeenCalled(); // the rehash in the window already updated the cache
  });
});
