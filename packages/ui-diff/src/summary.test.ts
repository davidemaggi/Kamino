import { describe, expect, it } from "vitest";
import { diffSummary } from "./summary.js";

describe("diffSummary", () => {
  it.each([
    ["identical", "a\nb\nc", "a\nb\nc", 0],
    ["both empty", "", "", 0],
    ["one changed line", "a\nb\nc", "a\nB\nc", 1],
    ["lines appended", "a\nb", "a\nb\nc\nd", 1],
    ["two distant changes", "X\nb\nc\nd\ne\nf\ng\nh", "Y\nb\nc\nd\ne\nf\ng\nZ", 2],
  ])("%s", (_, mine, incoming, changes) => {
    expect(diffSummary(mine, incoming)).toEqual({ changes });
  });
});
