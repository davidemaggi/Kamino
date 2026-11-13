import { describe, expect, it } from "vitest";
import { BRAND_ICON, BRAND_ICON_SVG } from "./brand-icon.js";

describe("brand icon", () => {
  it("is a one-color glyph sized for Obsidian's 100x100 icon box", () => {
    expect(BRAND_ICON).toBe("kamino-logo");
    expect(BRAND_ICON_SVG).toContain('fill="currentColor"');
    expect(BRAND_ICON_SVG).toContain("scale(0.195312)");
    // No hard-coded colors: it must follow the user's theme.
    expect(BRAND_ICON_SVG).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});
