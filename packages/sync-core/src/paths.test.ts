import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CONFIG_PREFIX,
  collisionKey,
  conflictSiblingPath,
  isCanonical,
  isRepresentable,
  localPath,
  normalizePath,
  utf8Length,
} from "./paths.js";

const ok = (raw: string, cfg = ".obsidian") => {
  const r = normalizePath(raw, cfg);
  if (!r.ok) throw new Error(r.reason);
  return r.path;
};

describe("normalizePath", () => {
  it("separators, slashes, NFC, config prefix", () => {
    expect(ok("\\a\\b.md")).toBe("a/b.md");
    expect(ok("/a/b/")).toBe("a/b");
    expect(ok("é.md")).toBe("é.md");
    expect(ok(".obsidian/app.json")).toBe(`${CONFIG_PREFIX}/app.json`);
    expect(ok(".obsidian")).toBe(CONFIG_PREFIX);
    expect(ok("custom-cfg/app.json", "custom-cfg")).toBe(`${CONFIG_PREFIX}/app.json`);
    expect(localPath(`${CONFIG_PREFIX}/app.json`, ".obsidian")).toBe(".obsidian/app.json");
    expect(localPath("a/b.md", ".obsidian")).toBe("a/b.md");
  });

  it("rejects empty, dot and reserved segments", () => {
    expect(normalizePath("", ".obsidian")).toEqual({ ok: false, reason: "empty" });
    expect(normalizePath("a//b", ".obsidian")).toEqual({ ok: false, reason: "empty_segment" });
    expect(normalizePath("a/../b", ".obsidian")).toEqual({ ok: false, reason: "dot_segment" });
    expect(normalizePath("{config}/x", ".obsidian")).toEqual({ ok: false, reason: "reserved" });
  });

  it("canonical paths", () => {
    expect(isCanonical("a/b.md")).toBe(true);
    expect(isCanonical(`${CONFIG_PREFIX}/app.json`)).toBe(true);
    expect(isCanonical("é.md")).toBe(false);
    expect(isCanonical("a\\b")).toBe(false);
    expect(isCanonical("/a")).toBe(false);
  });

  it("normalizing twice changes nothing", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (raw) => {
        const r = normalizePath(raw, ".obsidian");
        if (r.ok) expect(normalizePath(localPath(r.path, ".obsidian"), ".obsidian")).toEqual(r);
      }),
    );
  });
});

describe("collisionKey", () => {
  it("case, NFC/NFD and sharp s collide", () => {
    expect(collisionKey("Nota.md")).toBe(collisionKey("nota.md"));
    expect(collisionKey("é.md")).toBe(collisionKey("é.md"));
    expect(collisionKey("Straße.md")).toBe(collisionKey("STRASSE.md"));
    expect(collisionKey("a.md")).not.toBe(collisionKey("b.md"));
  });

  it("idempotent, case- and normalization-insensitive", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (s) => {
        const k = collisionKey(s);
        expect(collisionKey(k)).toBe(k);
        expect(collisionKey(s.toUpperCase())).toBe(k);
        expect(collisionKey(s.toLowerCase())).toBe(k);
        expect(collisionKey(s.normalize("NFD"))).toBe(k);
      }),
      { numRuns: 500 },
    );
  });
});

describe("isRepresentable", () => {
  it("windows rules", () => {
    expect(isRepresentable("con.md", "windows")).toEqual({ ok: false, reason: "reserved_name" });
    expect(isRepresentable("a/COM1", "windows")).toEqual({ ok: false, reason: "reserved_name" });
    expect(isRepresentable("a?.md", "windows")).toEqual({ ok: false, reason: "forbidden_char" });
    expect(isRepresentable("a./b.md", "windows")).toEqual({
      ok: false,
      reason: "trailing_dot_or_space",
    });
    expect(isRepresentable("con.md", "linux")).toEqual({ ok: true });
    expect(isRepresentable("CONIN$", "windows")).toEqual({ ok: false, reason: "reserved_name" });
    expect(isRepresentable("CON .txt", "windows")).toEqual({ ok: false, reason: "reserved_name" });
    expect(isRepresentable("console.md", "windows")).toEqual({ ok: true });
  });

  it("apple, android, linux", () => {
    expect(isRepresentable("a:b.md", "macos")).toEqual({ ok: false, reason: "forbidden_char" });
    expect(isRepresentable("a:b.md", "ios")).toEqual({ ok: false, reason: "forbidden_char" });
    expect(isRepresentable("a|b.md", "android")).toEqual({ ok: false, reason: "forbidden_char" });
    expect(isRepresentable("a|b.md", "linux")).toEqual({ ok: true });
  });

  it("lengths in UTF-8 bytes", () => {
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length("😀")).toBe(4);
    expect(isRepresentable("é".repeat(128), "linux")).toEqual({
      ok: false,
      reason: "segment_too_long",
    });
    expect(isRepresentable("é".repeat(127), "linux")).toEqual({ ok: true });
  });
});

describe("conflictSiblingPath", () => {
  it("suffix before the extension, or at the end", () => {
    expect(conflictSiblingPath("a/Nota.md", 1)).toBe("a/Nota (1).md");
    expect(conflictSiblingPath("Nota.tar.gz", 2)).toBe("Nota.tar (2).gz");
    expect(conflictSiblingPath(".env", 1)).toBe(".env (1)");
    expect(conflictSiblingPath("Makefile", 3)).toBe("Makefile (3)");
  });
});
