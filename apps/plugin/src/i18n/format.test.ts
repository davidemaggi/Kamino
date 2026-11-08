import { describe, expect, it } from "vitest";
import { basename, fmt, formatSize, formatWhen } from "./format.js";

describe("fmt", () => {
  it("replaces known params and keeps unknown ones", () => {
    expect(fmt("{a} e {b} ({c})", { a: 1, b: "due" })).toBe("1 e due ({c})");
  });
});

describe("formatWhen", () => {
  const now = Date.UTC(2026, 10, 8, 18, 0);
  it("same day: time only", () => {
    expect(formatWhen(Date.UTC(2026, 10, 8, 10, 45), now, "it", "UTC")).toBe("10:45");
  });
  it("other day: date and time", () => {
    expect(formatWhen(Date.UTC(2026, 10, 7, 10, 45), now, "it", "UTC")).toBe("7 nov, 10:45");
  });
});

describe("formatSize", () => {
  it.each([
    [500, "500 B"],
    [1536, "1,5 KB"],
    [180 * 1024 * 1024, "180 MB"],
  ])("%i", (bytes, text) => {
    expect(formatSize(bytes, "it")).toBe(text);
  });
});

describe("basename", () => {
  it("keeps the extension", () => {
    expect(basename("Progetti/Piano.md")).toBe("Piano.md");
    expect(basename("Spesa.md")).toBe("Spesa.md");
  });
});
