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
});
