import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../index.css"), "utf8");

function block(selector: RegExp): Record<string, string> {
  const m = selector.exec(css);
  if (!m?.[1]) throw new Error(`block not found: ${selector}`);
  return Object.fromEntries(
    [...m[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((x) => [x[1], x[2]]),
  );
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

const PAIRS: Array<[string, string]> = [
  ["foreground", "background"],
  ["foreground", "card"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["muted-foreground", "muted"],
  ["primary-foreground", "primary"],
  ["link", "background"],
  ["link", "card"],
  ...["safe", "working", "attention", "decision", "blocked"].map(
    (l) => [`status-${l}`, `status-${l}-surface`] as [string, string],
  ),
];

const themes = {
  light: block(/:root,\s*\.light\s*\{([^}]*)\}/),
  dark: block(/\n\.dark\s*\{([^}]*)\}/),
};

describe.each(Object.entries(themes))("%s tokens", (_, tokens) => {
  it.each(PAIRS)("%s on %s ≥ 4.5:1", (fg, bg) => {
    const a = tokens[fg];
    const b = tokens[bg];
    expect(a, fg).toBeDefined();
    expect(b, bg).toBeDefined();
    expect(ratio(a!, b!)).toBeGreaterThanOrEqual(4.5);
  });
});
