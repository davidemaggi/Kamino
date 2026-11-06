import { describe, expect, it } from "vitest";
import { detectLanguage } from "./index.js";

describe("detectLanguage", () => {
  it.each([
    ["it", "it"],
    ["it-IT", "it"],
    ["IT-ch", "it"],
    ["en-US", "en"],
    ["de", "en"],
    [undefined, "en"],
  ] as const)("%s -> %s", (input, expected) => {
    expect(detectLanguage(input)).toBe(expected);
  });
});
