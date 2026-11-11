import { describe, expect, it } from "vitest";
import { sha256Hex } from "./hash.js";
import { MemoryFs, bytes } from "./memory-fs.js";

async function* parts(...xs: string[]) {
  for (const x of xs) yield bytes(x);
}

describe("sha256Hex", () => {
  it("hashing in pieces equals hashing the whole", async () => {
    expect(await sha256Hex(parts("hel", "lo"))).toBe(await sha256Hex(parts("hello")));
    expect(await sha256Hex(parts("hello"))).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("MemoryFs", () => {
  it("writes only when the expected content matches, and verifies what it writes", async () => {
    const fs = new MemoryFs();
    const h = await sha256Hex(parts("one"));
    expect(await fs.write("a.md", parts("one"), null, h)).toBe("ok");
    expect(fs.text("a.md")).toBe("one");
    // Must not exist, but it does → nothing written.
    expect(await fs.write("a.md", parts("two"), null, await sha256Hex(parts("two")))).toBe(
      "changed",
    );
    expect(await fs.write("a.md", parts("two"), "wrong", await sha256Hex(parts("two")))).toBe(
      "changed",
    );
    // Content that doesn't match its hash is never put in place.
    expect(await fs.write("a.md", parts("two"), h, "deadbeef")).toBe("corrupt");
    expect(fs.text("a.md")).toBe("one");
    expect(await fs.write("a.md", parts("tw", "o"), h, await sha256Hex(parts("two")))).toBe("ok");
    expect(fs.text("a.md")).toBe("two");
  });

  it("lists, renames, trashes and removes empty folders", async () => {
    const fs = new MemoryFs();
    fs.put("d/a.md", "x");
    fs.put("b.md", "y");
    expect((await fs.list()).map((e) => [e.path, e.kind]).sort()).toEqual([
      ["b.md", "file"],
      ["d", "folder"],
      ["d/a.md", "file"],
    ]);
    expect(await fs.rename("b.md", "d/a.md")).toBe(false); // occupied
    expect(await fs.rename("b.md", "c.md")).toBe(true);
    expect(await fs.rmdirIfEmpty("d")).toBe(false);
    expect(await fs.trash("d/a.md")).toBe(true);
    expect(fs.trashed).toEqual(["d/a.md"]);
    expect(await fs.rmdirIfEmpty("d")).toBe(true);
    expect(await fs.stat("d")).toBeNull();
    await fs.mkdir("e/f");
    expect((await fs.stat("e/f"))?.kind).toBe("folder");
  });

  it("keeps plugin state apart from the vault", async () => {
    const fs = new MemoryFs();
    await fs.saveState("index", "{}");
    expect(await fs.loadState("index")).toBe("{}");
    expect(await fs.loadState("missing")).toBeNull();
    expect(await fs.list()).toEqual([]);
  });
});
