import { describe, expect, it } from "vitest";
import { safeRedirect } from "./redirect.js";

describe("safeRedirect", () => {
  it.each([
    ["/account", "/account"],
    ["/vaults?x=1", "/vaults?x=1"],
    ["//evil.example", "/"],
    ["/\\evil.example", "/"],
    ["https://evil.example", "/"],
    ["account", "/"],
    [undefined, "/"],
    [42, "/"],
    ["/login", "/"],
  ])("%s -> %s", (value, expected) => {
    expect(safeRedirect(value)).toBe(expected);
  });
});
