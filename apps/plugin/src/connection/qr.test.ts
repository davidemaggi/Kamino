import { describe, expect, it } from "vitest";
import { qrDataUrl } from "./qr.js";

describe("qrDataUrl", () => {
  it("returns an SVG data URL", () => {
    const url = qrDataUrl("obsidian://kamino?server=https%3A%2F%2Fsync.example&token=abc");
    expect(url.startsWith("data:image/svg+xml,")).toBe(true);
    expect(decodeURIComponent(url.slice("data:image/svg+xml,".length))).toContain("<svg");
  });
});
