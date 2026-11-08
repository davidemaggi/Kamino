import type { Scenario } from "./fake.js";
import type { BinaryInfo } from "./types.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

// Sample vault content (test data, not UI text).
const SHOPPING_MINE = "# Spesa\n\n- latte\n- pane\n- uova (6)\n- caffè\n";
const SHOPPING_INCOMING = "# Spesa\n\n- latte\n- pane\n- uova (12)\n- caffè\n- mele\n";

function longNote(variant: "mine" | "incoming"): string {
  const lines: string[] = ["# Piano", ""];
  for (let i = 1; i <= 220; i++) {
    let line = `- Punto ${i}: descrizione del passo ${i}.`;
    if (variant === "incoming" && (i === 12 || i === 97 || i === 180)) line += " (aggiornato)";
    lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}

function swatch(color: string): BinaryInfo {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="${color}"/></svg>`;
  return {
    size: 48_213,
    mime: "image/svg+xml",
    previewUrl: `data:image/svg+xml,${encodeURIComponent(svg)}`,
  };
}

/** Dev/test scenario: three conflicts (short text, long text, image), queue and a deferred file. */
export function conflictScenario(now: number): Scenario {
  return {
    snapshot: {
      queued: 3,
      oldestQueuedAt: now - 10 * MIN,
      lastConfirmedAt: now - 5 * MIN,
      unreachableSince: null,
      syncing: false,
      conflicts: 3,
      blocked: null,
      quotaRatio: 0.4,
    },
    conflicts: [
      {
        id: "c-shopping",
        path: "Spesa.md",
        kind: "concurrent_edit",
        binary: false,
        mine: { device: "Laptop", at: now - 20 * MIN },
        incoming: { device: "iPhone", at: now - 15 * MIN },
        mineText: SHOPPING_MINE,
        incomingText: SHOPPING_INCOMING,
      },
      {
        id: "c-plan",
        path: "Progetti/Piano.md",
        kind: "concurrent_edit",
        binary: false,
        mine: { device: "Laptop", at: now - 26 * HOUR },
        incoming: { device: "iPad", at: now - 25 * HOUR },
        mineText: longNote("mine"),
        incomingText: longNote("incoming"),
      },
      {
        id: "c-photo",
        path: "Foto/vacanza.svg",
        kind: "both_created",
        binary: true,
        mine: { device: "Laptop", at: now - 2 * HOUR },
        incoming: { device: "iPhone", at: now - HOUR },
        mineFile: swatch("teal"),
        incomingFile: swatch("orange"),
      },
    ],
    pending: [
      { path: "Idee.md", op: "modify", since: now - 10 * MIN },
      { path: "Note/riunione.md", op: "create", since: now - 8 * MIN },
      { path: "Vecchio.md", op: "delete", since: now - 2 * MIN },
    ],
    deferred: [{ path: "Video/demo.mp4", size: 180 * 1024 * 1024, direction: "upload" }],
  };
}
