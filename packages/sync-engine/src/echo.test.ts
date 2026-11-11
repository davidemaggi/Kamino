import { describe, expect, it } from "vitest";
import { ECHO_MS, EchoGuard } from "./echo.js";

describe("EchoGuard", () => {
  it("an event matching what the engine just wrote is an echo; a user edit is not", () => {
    let now = 0;
    const g = new EchoGuard(() => now);
    g.record("a.md", { size: 5, mtime: 100 });
    expect(g.isEcho("a.md", { size: 5, mtime: 100 })).toBe(true);
    // A user edit right after an engine write changes mtime or size.
    expect(g.isEcho("a.md", { size: 5, mtime: 101 })).toBe(false);
    expect(g.isEcho("a.md", { size: 6, mtime: 100 })).toBe(false);
    expect(g.isEcho("b.md", { size: 5, mtime: 100 })).toBe(false);
  });

  it("forgets after 10 s", () => {
    let now = 0;
    const g = new EchoGuard(() => now);
    g.record("a.md", { size: 1, mtime: 1 });
    now = ECHO_MS + 1;
    expect(g.isEcho("a.md", { size: 1, mtime: 1 })).toBe(false);
  });

  it("a path the engine removed is an echo while it stays gone", () => {
    const g = new EchoGuard(() => 0);
    g.record("old.md", null);
    expect(g.isEcho("old.md", null)).toBe(true);
    expect(g.isEcho("old.md", { size: 1, mtime: 1 })).toBe(false);
  });
});
