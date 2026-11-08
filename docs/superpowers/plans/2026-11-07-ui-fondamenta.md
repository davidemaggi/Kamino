# Fase UI, sotto-fase 1 — Fondamenta del design system: piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** lessico degli stati di sync condiviso (`packages/status`), design system della web app (token direzione C, font, componenti di base, `StatusBadge`, galleria di sviluppo) e indicatore di stato del plugin (barra di stato, ribbon, azione nell'intestazione su mobile, galleria di sviluppo).

**Architecture:** `@kamino/status` è TypeScript puro: tipi, `describeStatus()` (snapshot → livello + messaggi), testi it/en e formattazione. Web e plugin lo importano; ciascuno colora i livelli a modo suo: la web app con token CSS propri (Tailwind 4 + shadcn), il plugin con le variabili di Obsidian. Le gallerie esistono solo nelle build di sviluppo.

**Tech Stack:** TypeScript strict, Vitest 5, fast-check, React 19, Tailwind 4, shadcn/ui (new-york), `lucide-react`, `@fontsource-variable/inter`, `@fontsource/source-serif-4`, API DOM di Obsidian, esbuild.

**Spec:** `docs/superpowers/specs/2026-11-07-ui-fondamenta-design.md`.

## Global Constraints

- TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` (preset `@kamino/tsconfig`).
- Nessun testo UI scritto a mano nei componenti: web via i18n (`react-i18next`), plugin via `src/i18n/*.json`, testi di stato via `@kamino/status`.
- Lessico a tema vietato nei testi UI (regex dei test esistenti: `/clone|jango|ordine 66|kaminoan|jedi/i`).
- Nome prodotto e prefissi solo da `@kamino/brand`; dove impossibile (CSS statico), il punto va in `docs/renaming.md`.
- Plugin: niente API Node/Electron, `isDesktopOnly: false`; solo API di Obsidian e DOM standard.
- Nessuna richiesta a CDN esterni (font inclusi).
- Il colore non è mai l'unico segnale di stato: sempre icona + testo.
- Contrasto ≥ 4.5:1 per ogni coppia testo/sfondo dei token, in chiaro e in scuro.
- Niente bordo laterale colorato sulle card: lo stato del dispositivo è un pallino accanto al nome.
- Commit Conventional Commits in inglese; documentazione in italiano.
- Script cross-platform (niente bash-only).

## Review Focus

1. Snapshot con coda vuota, server irraggiungibile da 23 h, ultimo sync confermato → `safe` con nota "server non raggiungibile"; a 24 h → `attention`. → Task 1.
2. Snapshot mai sincronizzato (`lastConfirmedAt: null`), coda vuota → **mai** `safe`. → Task 1 (P1).
3. `count = 0` nei messaggi con parte "non salvate" (offline con coda vuota, quota piena senza coda) → nessun "0 modifiche non salvate". → Task 2.
4. La galleria web non deve finire nel bundle di produzione; il comando galleria non deve finire nel `main.js` di produzione del plugin. → Task 5, Task 7.
5. Tema scuro salvato: nessun flash chiaro al caricamento (classe `dark` applicata prima del primo paint). → Task 3.

## File Structure

```
packages/status/
  package.json, tsconfig.json, tsconfig.build.json
  src/levels.ts          livelli, gravità, chiavi messaggio, icone
  src/types.ts           SyncSnapshot, Thresholds, StatusMessage, StatusDescription
  src/describe.ts        describeStatus()
  src/examples.ts        exampleSnapshots(now)
  src/messages.ts        STATUS_MESSAGES, formatAge, formatStatusMessage, formatLastConfirmed
  src/index.ts           re-export
  src/*.test.ts
apps/web/
  index.html                         lang, title da brand, theme-init
  public/theme-init.js               anti-flash
  vite.config.ts                     plugin brand-html, include test/
  src/index.css                      token, font, @theme
  src/theme/tokens.test.ts           contrasto WCAG
  src/theme/theme-init.test.ts
  src/theme/ThemeSwitcher.tsx (+test)
  src/components/ui/*                shadcn (generati)
  src/components/status/StatusBadge.tsx (+test), status-icons.ts
  src/dev/GalleryPage.tsx
  src/main.tsx                       caricamento condizionale della galleria
  test/build.test.ts                 galleria assente, nessun font esterno
apps/plugin/
  scripts/build-constants.ts         __DEV__
  esbuild.config.mjs                 --dev
  src/globals.d.ts                   __DEV__
  src/__mocks__/obsidian.ts          setIcon, Notice, Platform, getIconIds, MarkdownView, ...
  src/styles.css                     classi di stato
  src/ui/status-classes.ts           prefisso classi
  src/ui/render-status.ts (+test)    renderStatusIndicator, resolveIcon, shouldShowHeaderAction, shouldNotify
  src/ui/StatusIndicator.ts (+test)  barra di stato, ribbon, azione intestazione, notice
  src/dev/status-gallery.ts          comando di sviluppo
  src/main.ts
docs/ui/design-system.md, docs/02-architecture.md, docs/renaming.md, docs/HANDOVER.md
```

---

### Task 1: `packages/status` — livelli, tipi e `describeStatus`

**Files:**
- Create: `packages/status/package.json`, `packages/status/tsconfig.json`, `packages/status/tsconfig.build.json`
- Create: `packages/status/src/levels.ts`, `src/types.ts`, `src/describe.ts`, `src/examples.ts`, `src/index.ts`
- Test: `packages/status/src/describe.test.ts`, `packages/status/src/describe.property.test.ts`
- Modify: `.changeset/config.json` (aggiungere `@kamino/status` a `ignore`)

**Interfaces:**
- Produces (usati da tutti i task successivi):
  - `LEVELS: readonly ["safe","working","attention","decision","blocked"]`, `type Level`, `severity(level: Level): number`
  - `type StatusKey` (12 chiavi + `note.unreachable`), `type IconName`, `MESSAGE_ICON: Record<StatusKey, IconName>`
  - `interface SyncSnapshot`, `interface Thresholds`, `DEFAULT_THRESHOLDS: Thresholds`, `interface StatusMessage { key: StatusKey; params: Record<string, number> }`, `interface StatusDescription { level; message; secondary; icon; lastConfirmedAt }`
  - `describeStatus(snapshot: SyncSnapshot, thresholds: Thresholds, now: number): StatusDescription`
  - `exampleSnapshots(now: number): ExampleSnapshot[]` con `interface ExampleSnapshot { id: string; snapshot: SyncSnapshot; expected: { level: Level; key: StatusKey } }`

- [ ] **Step 1: Scaffold del pacchetto** (stessa forma di `packages/brand`)

`packages/status/package.json`:

```json
{
  "name": "@kamino/status",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run"
  },
  "devDependencies": {
    "@kamino/tsconfig": "workspace:*"
  }
}
```

`packages/status/tsconfig.json` — preset DOM-free ma con `Intl` (lib ES2023 basta):

```json
{
  "extends": "@kamino/tsconfig/node.json",
  "compilerOptions": { "types": [] },
  "include": ["src"]
}
```

`packages/status/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true
  },
  "exclude": ["src/**/*.test.ts"]
}
```

Run: `pnpm --filter @kamino/status add -D fast-check vitest` poi `pnpm install`.
In `.changeset/config.json` aggiungere `"@kamino/status"` all'array `ignore`.

- [ ] **Step 2: Livelli e tipi**

`packages/status/src/levels.ts`:

```ts
/** Sync status levels, least to most severe. Order is the severity. */
export const LEVELS = ["safe", "working", "attention", "decision", "blocked"] as const;
export type Level = (typeof LEVELS)[number];

export function severity(level: Level): number {
  return LEVELS.indexOf(level);
}

export const STATUS_KEYS = [
  "safe",
  "working.syncing",
  "working.queued",
  "working.neverSynced",
  "attention.offline",
  "attention.stale",
  "attention.quota",
  "decision.conflicts",
  "blocked.quota",
  "blocked.revoked",
  "blocked.auth",
  "blocked.protocol",
  "note.unreachable",
] as const;
export type StatusKey = (typeof STATUS_KEYS)[number];

/** Lucide icon names (shared by lucide-react and Obsidian's setIcon). */
export type IconName =
  | "shield-check"
  | "refresh-cw"
  | "clock"
  | "cloud-off"
  | "triangle-alert"
  | "git-compare-arrows"
  | "octagon-alert";

export const MESSAGE_ICON: Record<StatusKey, IconName> = {
  safe: "shield-check",
  "working.syncing": "refresh-cw",
  "working.queued": "clock",
  "working.neverSynced": "clock",
  "attention.offline": "cloud-off",
  "attention.stale": "triangle-alert",
  "attention.quota": "triangle-alert",
  "decision.conflicts": "git-compare-arrows",
  "blocked.quota": "octagon-alert",
  "blocked.revoked": "octagon-alert",
  "blocked.auth": "octagon-alert",
  "blocked.protocol": "octagon-alert",
  "note.unreachable": "cloud-off",
};
```

`packages/status/src/types.ts`:

```ts
import type { IconName, Level, StatusKey } from "./levels.js";

export type BlockReason = "quota" | "revoked" | "auth" | "protocol";

/** Point-in-time sync state of one device. All times are epoch ms. */
export interface SyncSnapshot {
  queued: number;
  oldestQueuedAt: number | null;
  lastConfirmedAt: number | null;
  unreachableSince: number | null;
  syncing: boolean;
  conflicts: number;
  blocked: BlockReason | null;
  quotaRatio: number | null;
}

export interface Thresholds {
  staleQueueMs: number;
  unreachableMs: number;
  quotaWarnRatio: number;
}

const HOUR = 3_600_000;
export const DEFAULT_THRESHOLDS: Thresholds = {
  staleQueueMs: HOUR,
  unreachableMs: 24 * HOUR,
  quotaWarnRatio: 0.9,
};

export interface StatusMessage {
  key: StatusKey;
  params: Record<string, number>;
}

export interface StatusDescription {
  level: Level;
  message: StatusMessage;
  /** Other true conditions, most severe first. */
  secondary: StatusMessage[];
  icon: IconName;
  lastConfirmedAt: number | null;
}
```

- [ ] **Step 3: Snapshot di esempio** (servono ai test di esempio e alle gallerie)

`packages/status/src/examples.ts`:

```ts
import type { Level, StatusKey } from "./levels.js";
import type { SyncSnapshot } from "./types.js";

export interface ExampleSnapshot {
  id: string;
  snapshot: SyncSnapshot;
  expected: { level: Level; key: StatusKey };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const base: SyncSnapshot = {
  queued: 0,
  oldestQueuedAt: null,
  lastConfirmedAt: null,
  unreachableSince: null,
  syncing: false,
  conflicts: 0,
  blocked: null,
  quotaRatio: 0.4,
};

/** Named snapshots for galleries and example tests, relative to `now`. */
export function exampleSnapshots(now: number): ExampleSnapshot[] {
  const synced = { ...base, lastConfirmedAt: now - 2 * MIN };
  return [
    { id: "safe", snapshot: synced, expected: { level: "safe", key: "safe" } },
    { id: "never-synced", snapshot: base, expected: { level: "working", key: "working.neverSynced" } },
    {
      id: "queued",
      snapshot: { ...synced, queued: 3, oldestQueuedAt: now - 10_000 },
      expected: { level: "working", key: "working.queued" },
    },
    {
      id: "syncing",
      snapshot: { ...synced, queued: 3, oldestQueuedAt: now - 10_000, syncing: true },
      expected: { level: "working", key: "working.syncing" },
    },
    {
      id: "offline-below-threshold",
      snapshot: { ...synced, unreachableSince: now - 3 * HOUR },
      expected: { level: "safe", key: "safe" },
    },
    {
      id: "offline-2-days",
      snapshot: {
        ...synced,
        lastConfirmedAt: now - 2 * DAY,
        unreachableSince: now - 2 * DAY,
        queued: 14,
        oldestQueuedAt: now - 2 * DAY,
      },
      expected: { level: "attention", key: "attention.offline" },
    },
    {
      id: "stale-queue",
      snapshot: { ...synced, queued: 5, oldestQueuedAt: now - 2 * HOUR },
      expected: { level: "attention", key: "attention.stale" },
    },
    {
      id: "quota-95",
      snapshot: { ...synced, quotaRatio: 0.95 },
      expected: { level: "attention", key: "attention.quota" },
    },
    {
      id: "one-conflict",
      snapshot: { ...synced, conflicts: 1 },
      expected: { level: "decision", key: "decision.conflicts" },
    },
    {
      id: "conflicts-and-offline",
      snapshot: { ...synced, conflicts: 3, unreachableSince: now - 2 * DAY },
      expected: { level: "decision", key: "decision.conflicts" },
    },
    {
      id: "quota-full",
      snapshot: { ...synced, blocked: "quota", queued: 12, oldestQueuedAt: now - HOUR, quotaRatio: 1 },
      expected: { level: "blocked", key: "blocked.quota" },
    },
    {
      id: "revoked",
      snapshot: { ...synced, blocked: "revoked" },
      expected: { level: "blocked", key: "blocked.revoked" },
    },
    {
      id: "auth-expired",
      snapshot: { ...synced, blocked: "auth", queued: 2, oldestQueuedAt: now - 5 * MIN },
      expected: { level: "blocked", key: "blocked.auth" },
    },
    {
      id: "protocol-incompatible",
      snapshot: { ...synced, blocked: "protocol" },
      expected: { level: "blocked", key: "blocked.protocol" },
    },
  ];
}
```

- [ ] **Step 4: Test d'esempio (falliscono)**

`packages/status/src/describe.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describeStatus } from "./describe.js";
import { exampleSnapshots } from "./examples.js";
import { DEFAULT_THRESHOLDS, type SyncSnapshot } from "./types.js";

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const HOUR = 3_600_000;
const synced: SyncSnapshot = {
  queued: 0,
  oldestQueuedAt: null,
  lastConfirmedAt: NOW - 60_000,
  unreachableSince: null,
  syncing: false,
  conflicts: 0,
  blocked: null,
  quotaRatio: null,
};

describe("describeStatus examples", () => {
  for (const ex of exampleSnapshots(NOW)) {
    it(ex.id, () => {
      const d = describeStatus(ex.snapshot, DEFAULT_THRESHOLDS, NOW);
      expect(d.level).toBe(ex.expected.level);
      expect(d.message.key).toBe(ex.expected.key);
    });
  }
});

describe("describeStatus rules", () => {
  it("offline below threshold stays safe with a note", () => {
    const d = describeStatus({ ...synced, unreachableSince: NOW - 23 * HOUR }, DEFAULT_THRESHOLDS, NOW);
    expect(d.level).toBe("safe");
    expect(d.secondary).toEqual([{ key: "note.unreachable", params: { ageMs: 23 * HOUR } }]);
  });

  it("offline at threshold becomes attention", () => {
    const d = describeStatus({ ...synced, unreachableSince: NOW - 24 * HOUR }, DEFAULT_THRESHOLDS, NOW);
    expect(d.level).toBe("attention");
    expect(d.message).toEqual({ key: "attention.offline", params: { ageMs: 24 * HOUR, count: 0 } });
  });

  it("never synced with empty queue is not safe", () => {
    const d = describeStatus({ ...synced, lastConfirmedAt: null }, DEFAULT_THRESHOLDS, NOW);
    expect(d.level).toBe("working");
    expect(d.message.key).toBe("working.neverSynced");
  });

  it("blocked reports the queued count and lists other conditions as secondary", () => {
    const d = describeStatus(
      { ...synced, blocked: "quota", queued: 12, oldestQueuedAt: NOW - 2 * HOUR, conflicts: 1 },
      DEFAULT_THRESHOLDS,
      NOW,
    );
    expect(d.message).toEqual({ key: "blocked.quota", params: { count: 12 } });
    expect(d.secondary.map((m) => m.key)).toEqual([
      "decision.conflicts",
      "attention.stale",
      "working.queued",
    ]);
  });

  it("quota percent is rounded", () => {
    const d = describeStatus({ ...synced, quotaRatio: 0.926 }, DEFAULT_THRESHOLDS, NOW);
    expect(d.message).toEqual({ key: "attention.quota", params: { percent: 93 } });
  });

  it("carries icon and lastConfirmedAt", () => {
    const d = describeStatus(synced, DEFAULT_THRESHOLDS, NOW);
    expect(d.icon).toBe("shield-check");
    expect(d.lastConfirmedAt).toBe(NOW - 60_000);
  });
});
```

Run: `pnpm --filter @kamino/status test`
Expected: FAIL — `Cannot find module './describe.js'`.

- [ ] **Step 5: Implementazione**

`packages/status/src/describe.ts`:

```ts
import { MESSAGE_ICON, severity, type Level } from "./levels.js";
import type { StatusDescription, StatusMessage, SyncSnapshot, Thresholds } from "./types.js";

interface Finding {
  level: Level;
  message: StatusMessage;
  note?: true;
}

/**
 * Pure mapping snapshot -> status. Time enters only through `now`.
 * Rules: docs/superpowers/specs/2026-11-07-ui-fondamenta-design.md §3.3.
 */
export function describeStatus(
  s: SyncSnapshot,
  th: Thresholds,
  now: number,
): StatusDescription {
  const found: Finding[] = [];
  const add = (level: Level, key: StatusMessage["key"], params: Record<string, number> = {}) =>
    found.push({ level, message: { key, params } });

  if (s.blocked !== null) add("blocked", `blocked.${s.blocked}`, { count: s.queued });
  if (s.conflicts > 0) add("decision", "decision.conflicts", { count: s.conflicts });

  const unreachableMs = s.unreachableSince === null ? null : now - s.unreachableSince;
  if (unreachableMs !== null && unreachableMs >= th.unreachableMs) {
    add("attention", "attention.offline", { ageMs: unreachableMs, count: s.queued });
  }
  if (s.queued > 0 && s.oldestQueuedAt !== null && now - s.oldestQueuedAt >= th.staleQueueMs) {
    add("attention", "attention.stale", { count: s.queued, ageMs: now - s.oldestQueuedAt });
  }
  if (s.quotaRatio !== null && s.quotaRatio >= th.quotaWarnRatio) {
    add("attention", "attention.quota", { percent: Math.round(s.quotaRatio * 100) });
  }
  if (s.queued > 0) {
    add("working", s.syncing ? "working.syncing" : "working.queued", { count: s.queued });
  } else if (s.lastConfirmedAt === null) {
    add("working", "working.neverSynced");
  }
  if (unreachableMs !== null && unreachableMs < th.unreachableMs) {
    found.push({ level: "safe", message: { key: "note.unreachable", params: { ageMs: unreachableMs } }, note: true });
  }

  // Stable sort: within a level, insertion order above is the priority.
  found.sort((a, b) => severity(b.level) - severity(a.level));
  const primary = found.find((f) => !f.note);
  const message: StatusMessage = primary?.message ?? { key: "safe", params: {} };
  return {
    level: primary?.level ?? "safe",
    message,
    secondary: found.filter((f) => f !== primary).map((f) => f.message),
    icon: MESSAGE_ICON[message.key],
    lastConfirmedAt: s.lastConfirmedAt,
  };
}
```

`packages/status/src/index.ts`:

```ts
export * from "./levels.js";
export * from "./types.js";
export * from "./describe.js";
export * from "./examples.js";
```

Run: `pnpm --filter @kamino/status test`
Expected: PASS.

- [ ] **Step 6: Test di proprietà (P1–P4)**

`packages/status/src/describe.property.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { describeStatus } from "./describe.js";
import { severity } from "./levels.js";
import { DEFAULT_THRESHOLDS, type SyncSnapshot } from "./types.js";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const past = fc.integer({ min: 0, max: 30 * DAY }).map((d) => NOW - d);

const snapshotArb: fc.Arbitrary<SyncSnapshot> = fc
  .record({
    queued: fc.nat({ max: 500 }),
    oldestQueuedAt: past,
    lastConfirmedAt: fc.option(past, { nil: null }),
    unreachableSince: fc.option(past, { nil: null }),
    syncing: fc.boolean(),
    conflicts: fc.nat({ max: 20 }),
    blocked: fc.constantFrom(null, "quota", "revoked", "auth", "protocol"),
    quotaRatio: fc.option(fc.double({ min: 0, max: 2, noNaN: true }), { nil: null }),
  })
  .map((s) => ({ ...s, oldestQueuedAt: s.queued > 0 ? s.oldestQueuedAt : null }));

const describe_ = (s: SyncSnapshot) => describeStatus(s, DEFAULT_THRESHOLDS, NOW);
const sev = (s: SyncSnapshot) => severity(describe_(s).level);

describe("describeStatus properties", () => {
  it("P1: safe implies nothing pending", () => {
    fc.assert(
      fc.property(snapshotArb, (s) => {
        if (describe_(s).level !== "safe") return;
        expect(s.queued).toBe(0);
        expect(s.lastConfirmedAt).not.toBeNull();
        expect(s.conflicts).toBe(0);
        expect(s.blocked).toBeNull();
      }),
    );
  });

  it("P2: worsening a snapshot never lowers severity", () => {
    const worsen = fc.constantFrom<(s: SyncSnapshot) => SyncSnapshot>(
      (s) => ({ ...s, queued: s.queued + 1, oldestQueuedAt: s.oldestQueuedAt ?? NOW }),
      (s) => ({ ...s, conflicts: s.conflicts + 1 }),
      (s) => ({ ...s, blocked: "quota" }),
      (s) => ({ ...s, quotaRatio: (s.quotaRatio ?? 0) + 0.5 }),
      (s) => ({ ...s, unreachableSince: (s.unreachableSince ?? NOW) - DAY }),
      (s) => (s.oldestQueuedAt === null ? s : { ...s, oldestQueuedAt: s.oldestQueuedAt - DAY }),
    );
    fc.assert(fc.property(snapshotArb, worsen, (s, f) => sev(f(s)) >= sev(s)));
  });

  it("P3: deterministic", () => {
    fc.assert(
      fc.property(snapshotArb, (s) => {
        expect(describe_(s)).toEqual(describe_(s));
      }),
    );
  });

  it("P4: every true condition is reported", () => {
    fc.assert(
      fc.property(snapshotArb, (s) => {
        const d = describe_(s);
        const keys = [d.message.key, ...d.secondary.map((m) => m.key)];
        if (s.blocked) expect(keys).toContain(`blocked.${s.blocked}`);
        if (s.conflicts > 0) expect(keys).toContain("decision.conflicts");
        if (s.queued > 0) expect(keys.some((k) => k.startsWith("working."))).toBe(true);
        if (s.unreachableSince !== null) {
          expect(keys.some((k) => k === "attention.offline" || k === "note.unreachable")).toBe(true);
        }
      }),
    );
  });
});
```

Run: `pnpm --filter @kamino/status test`
Expected: PASS (se P2 fallisce, il controesempio di fast-check indica la regola da correggere in `describe.ts`, non il test).

- [ ] **Step 7: Verifica e commit**

Run: `pnpm --filter @kamino/status build && pnpm --filter @kamino/status typecheck && pnpm --filter @kamino/status lint`
Expected: nessun errore; `packages/status/dist/index.js` esiste.

```bash
git add packages/status .changeset/config.json pnpm-lock.yaml
git commit -m "feat(status): add shared sync status levels and describeStatus"
```

---

### Task 2: `packages/status` — testi e formattazione

**Files:**
- Create: `packages/status/src/messages.ts`
- Modify: `packages/status/src/index.ts`
- Test: `packages/status/src/messages.test.ts`

**Interfaces:**
- Consumes: `StatusKey`, `STATUS_KEYS`, `StatusMessage` (Task 1).
- Produces:
  - `type Lang = "it" | "en"`
  - `STATUS_MESSAGES: Record<Lang, Record<StatusKey, Template>>` con `type Template = string | { zero?: string; one: string; other: string }`
  - `formatAge(ms: number, lang: Lang): string`
  - `formatStatusMessage(message: StatusMessage, lang: Lang): string`
  - `formatLastConfirmed(lastConfirmedAt: number | null, now: number, lang: Lang): string`

- [ ] **Step 1: Test (falliscono)**

`packages/status/src/messages.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { STATUS_KEYS } from "./levels.js";
import {
  STATUS_MESSAGES,
  formatAge,
  formatLastConfirmed,
  formatStatusMessage,
} from "./messages.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const THEMED = /clone|jango|ordine 66|kaminoan|jedi/i;

describe("formatAge", () => {
  it.each([
    [30_000, "meno di 1 min", "under 1 min"],
    [2 * MIN + 59_000, "2 min", "2 min"],
    [3 * HOUR + 10 * MIN, "3 h", "3 h"],
    [2 * DAY + 5 * HOUR, "2 g", "2 d"],
  ])("%i ms", (ms, it_, en) => {
    expect(formatAge(ms, "it")).toBe(it_);
    expect(formatAge(ms, "en")).toBe(en);
  });
});

describe("formatStatusMessage", () => {
  it("pluralizes", () => {
    expect(formatStatusMessage({ key: "working.queued", params: { count: 1 } }, "it")).toBe(
      "1 modifica in attesa",
    );
    expect(formatStatusMessage({ key: "working.queued", params: { count: 3 } }, "en")).toBe(
      "3 changes waiting",
    );
  });

  it("interpolates age and count", () => {
    expect(
      formatStatusMessage({ key: "attention.offline", params: { ageMs: 2 * DAY, count: 14 } }, "it"),
    ).toBe("Server non raggiungibile da 2 g · 14 modifiche non salvate");
  });

  it("never says 0 unsaved changes", () => {
    expect(
      formatStatusMessage({ key: "attention.offline", params: { ageMs: 2 * DAY, count: 0 } }, "it"),
    ).toBe("Server non raggiungibile da 2 g");
    expect(formatStatusMessage({ key: "blocked.quota", params: { count: 0 } }, "en")).toBe(
      "Storage full",
    );
  });

  it("formats percent", () => {
    expect(formatStatusMessage({ key: "attention.quota", params: { percent: 95 } }, "it")).toBe(
      "Spazio quasi esaurito (95%)",
    );
  });
});

describe("formatLastConfirmed", () => {
  it("formats a past sync and the never case", () => {
    expect(formatLastConfirmed(1000 - 2 * MIN, 1000, "it")).toBe("Ultimo sync confermato: 2 min fa");
    expect(formatLastConfirmed(null, 1000, "en")).toBe("Never synced with the server");
  });
});

describe("STATUS_MESSAGES", () => {
  it("covers every key in both languages with the same shape", () => {
    for (const key of STATUS_KEYS) {
      const it_ = STATUS_MESSAGES.it[key];
      const en = STATUS_MESSAGES.en[key];
      expect(typeof it_).toBe(typeof en);
      if (typeof it_ === "object" && typeof en === "object") {
        expect(Object.keys(it_).sort()).toEqual(Object.keys(en).sort());
      }
    }
  });

  it("contains no themed lexicon", () => {
    const all = JSON.stringify(STATUS_MESSAGES);
    expect(all).not.toMatch(THEMED);
  });
});
```

Run: `pnpm --filter @kamino/status test`
Expected: FAIL — `Cannot find module './messages.js'`.

- [ ] **Step 2: Implementazione**

`packages/status/src/messages.ts`:

```ts
import type { StatusKey } from "./levels.js";
import type { StatusMessage } from "./types.js";

export type Lang = "it" | "en";
export type Template = string | { zero?: string; one: string; other: string };

export const STATUS_MESSAGES: Record<Lang, Record<StatusKey, Template>> = {
  it: {
    safe: "Tutto al sicuro",
    "working.syncing": { one: "Invio di 1 modifica…", other: "Invio di {count} modifiche…" },
    "working.queued": { one: "1 modifica in attesa", other: "{count} modifiche in attesa" },
    "working.neverSynced": "Mai sincronizzato",
    "attention.offline": {
      zero: "Server non raggiungibile da {age}",
      one: "Server non raggiungibile da {age} · 1 modifica non salvata",
      other: "Server non raggiungibile da {age} · {count} modifiche non salvate",
    },
    "attention.stale": {
      one: "1 modifica non salvata da {age}",
      other: "{count} modifiche non salvate da {age}",
    },
    "attention.quota": "Spazio quasi esaurito ({percent}%)",
    "decision.conflicts": { one: "1 conflitto da risolvere", other: "{count} conflitti da risolvere" },
    "blocked.quota": {
      zero: "Spazio esaurito",
      one: "Spazio esaurito · 1 modifica non salvata",
      other: "Spazio esaurito · {count} modifiche non salvate",
    },
    "blocked.revoked": "Dispositivo revocato: il sync è fermo",
    "blocked.auth": "Accesso scaduto: accedi di nuovo",
    "blocked.protocol": "Aggiorna il plugin: versione non compatibile con il server",
    "note.unreachable": "Server non raggiungibile da {age}",
  },
  en: {
    safe: "All safe",
    "working.syncing": { one: "Sending 1 change…", other: "Sending {count} changes…" },
    "working.queued": { one: "1 change waiting", other: "{count} changes waiting" },
    "working.neverSynced": "Never synced",
    "attention.offline": {
      zero: "Server unreachable for {age}",
      one: "Server unreachable for {age} · 1 unsaved change",
      other: "Server unreachable for {age} · {count} unsaved changes",
    },
    "attention.stale": {
      one: "1 change unsaved for {age}",
      other: "{count} changes unsaved for {age}",
    },
    "attention.quota": "Storage almost full ({percent}%)",
    "decision.conflicts": { one: "1 conflict to resolve", other: "{count} conflicts to resolve" },
    "blocked.quota": {
      zero: "Storage full",
      one: "Storage full · 1 unsaved change",
      other: "Storage full · {count} unsaved changes",
    },
    "blocked.revoked": "Device revoked: sync is stopped",
    "blocked.auth": "Session expired: sign in again",
    "blocked.protocol": "Update the plugin: version not compatible with the server",
    "note.unreachable": "Server unreachable for {age}",
  },
};

const UNITS: Record<Lang, { lessThanMin: string; min: string; h: string; d: string }> = {
  it: { lessThanMin: "meno di 1 min", min: "min", h: "h", d: "g" },
  en: { lessThanMin: "under 1 min", min: "min", h: "h", d: "d" },
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function formatAge(ms: number, lang: Lang): string {
  const u = UNITS[lang];
  const n = (v: number) => new Intl.NumberFormat(lang).format(Math.floor(v));
  if (ms < MIN) return u.lessThanMin;
  if (ms < HOUR) return `${n(ms / MIN)} ${u.min}`;
  if (ms < DAY) return `${n(ms / HOUR)} ${u.h}`;
  return `${n(ms / DAY)} ${u.d}`;
}

function pick(t: Template, count: number | undefined, lang: Lang): string {
  if (typeof t === "string") return t;
  if (count === 0 && t.zero !== undefined) return t.zero;
  return new Intl.PluralRules(lang).select(count ?? 0) === "one" ? t.one : t.other;
}

export function formatStatusMessage(message: StatusMessage, lang: Lang): string {
  const p = message.params;
  const text = pick(STATUS_MESSAGES[lang][message.key], p["count"], lang);
  return text.replace(/\{(count|age|percent)\}/g, (_, name: string) => {
    if (name === "age") return formatAge(p["ageMs"] ?? 0, lang);
    return new Intl.NumberFormat(lang).format(p[name] ?? 0);
  });
}

const LAST: Record<Lang, { ago: (age: string) => string; never: string }> = {
  it: { ago: (a) => `Ultimo sync confermato: ${a} fa`, never: "Mai sincronizzato con il server" },
  en: { ago: (a) => `Last confirmed sync: ${a} ago`, never: "Never synced with the server" },
};

export function formatLastConfirmed(lastConfirmedAt: number | null, now: number, lang: Lang): string {
  if (lastConfirmedAt === null) return LAST[lang].never;
  return LAST[lang].ago(formatAge(Math.max(0, now - lastConfirmedAt), lang));
}
```

In `packages/status/src/index.ts` aggiungere `export * from "./messages.js";`.

Run: `pnpm --filter @kamino/status test`
Expected: PASS.

- [ ] **Step 3: Verifica e commit**

Run: `pnpm --filter @kamino/status build && pnpm --filter @kamino/status typecheck && pnpm --filter @kamino/status lint`

```bash
git add packages/status
git commit -m "feat(status): add it/en status texts and formatting"
```

---

### Task 3: Web — token, font, tema senza flash

**Files:**
- Modify: `apps/web/src/index.css` (sostituzione completa)
- Create: `apps/web/public/theme-init.js`
- Modify: `apps/web/index.html`, `apps/web/vite.config.ts`
- Test: `apps/web/src/theme/tokens.test.ts`, `apps/web/src/theme/theme-init.test.ts`, `apps/web/src/theme/ThemeProvider.test.tsx` (aggiunta casi "system")

**Interfaces:**
- Produces: classi Tailwind `bg-background`, `text-foreground`, `bg-card`, `text-muted-foreground`, `border-border`, `bg-primary`, `text-primary-foreground`, `text-link`, `font-sans`, `font-serif`, `bg-status-<livello>-surface`, `text-status-<livello>` per i 5 livelli; selettori `.light` / `.dark` che impostano i token su un sottoalbero.

- [ ] **Step 1: Test di contrasto (fallisce)**

`apps/web/src/theme/tokens.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../index.css"), "utf8");

function block(selector: RegExp): Record<string, string> {
  const m = selector.exec(css);
  if (!m?.[1]) throw new Error(`block not found: ${selector}`);
  return Object.fromEntries([...m[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((x) => [x[1], x[2]]));
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
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
```

Run: `pnpm --filter @kamino/web test -- tokens`
Expected: FAIL — `block not found`.

- [ ] **Step 2: Token e font**

Run: `pnpm --filter @kamino/web add @fontsource-variable/inter @fontsource/source-serif-4`

`apps/web/src/index.css` (contenuto completo):

```css
@import "tailwindcss";
@import "@fontsource-variable/inter";
@import "@fontsource/source-serif-4/600.css";
@import "@fontsource/source-serif-4/700.css";

@custom-variant dark (&:where(.dark, .dark *));

/* Direction C ("hybrid"): docs/ui/design-system.md. Contrast enforced by src/theme/tokens.test.ts. */
:root,
.light {
  color-scheme: light;
  --background: #f7f9f9;
  --foreground: #132a36;
  --card: #ffffff;
  --card-foreground: #132a36;
  --popover: #ffffff;
  --popover-foreground: #132a36;
  --primary: #0d2230;
  --primary-foreground: #ffffff;
  --secondary: #eef1f2;
  --secondary-foreground: #132a36;
  --muted: #eef1f2;
  --muted-foreground: #5b6b73;
  --accent: #e6f3f5;
  --accent-foreground: #0d2230;
  --destructive: #a3261b;
  --border: #e3e9eb;
  --input: #d5dde0;
  --ring: #0b7685;
  --link: #0b7685;
  --status-safe: #0b6b52;
  --status-safe-surface: #e3f6ef;
  --status-working: #3f5059;
  --status-working-surface: #eef1f2;
  --status-attention: #8a5a00;
  --status-attention-surface: #fbf0d9;
  --status-decision: #5a3fb0;
  --status-decision-surface: #efeafd;
  --status-blocked: #a3261b;
  --status-blocked-surface: #fbe4e1;
  --radius: 10px;
}

.dark {
  color-scheme: dark;
  --background: #0b1820;
  --foreground: #e7eef0;
  --card: #13232c;
  --card-foreground: #e7eef0;
  --popover: #13232c;
  --popover-foreground: #e7eef0;
  --primary: #4fd6e3;
  --primary-foreground: #071118;
  --secondary: #1d3340;
  --secondary-foreground: #e7eef0;
  --muted: #1d3340;
  --muted-foreground: #8a9ba3;
  --accent: #16303d;
  --accent-foreground: #e7eef0;
  --destructive: #ff9c90;
  --border: #1d3340;
  --input: #27404d;
  --ring: #4fd6e3;
  --link: #4fd6e3;
  --status-safe: #7ff0c9;
  --status-safe-surface: #0e3b33;
  --status-working: #b4c3ca;
  --status-working-surface: #1d3340;
  --status-attention: #ffd166;
  --status-attention-surface: #3a2e0c;
  --status-decision: #c4b2ff;
  --status-decision-surface: #2c2250;
  --status-blocked: #ff9c90;
  --status-blocked-surface: #401a17;
}

@theme inline {
  --font-sans: "Inter Variable", ui-sans-serif, system-ui, sans-serif;
  --font-serif: "Source Serif 4", ui-serif, Georgia, serif;
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-link: var(--link);
  --color-status-safe: var(--status-safe);
  --color-status-safe-surface: var(--status-safe-surface);
  --color-status-working: var(--status-working);
  --color-status-working-surface: var(--status-working-surface);
  --color-status-attention: var(--status-attention);
  --color-status-attention-surface: var(--status-attention-surface);
  --color-status-decision: var(--status-decision);
  --color-status-decision-surface: var(--status-decision-surface);
  --color-status-blocked: var(--status-blocked);
  --color-status-blocked-surface: var(--status-blocked-surface);
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground font-sans antialiased;
  }
}
```

Run: `pnpm --filter @kamino/web test -- tokens`
Expected: PASS (36 coppie). Se una coppia fallisce, si corregge il **valore** del token (mantenendo la tinta), mai la soglia.

- [ ] **Step 3: Test di `theme-init.js` (fallisce)**

`apps/web/src/theme/theme-init.test.ts`:

```ts
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY } from "./ThemeProvider.js";

const src = readFileSync(join(import.meta.dirname, "../../public/theme-init.js"), "utf8");
const run = () => new Function(src)();

function stubPrefersDark(dark: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: dark && q.includes("dark") }));
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  vi.unstubAllGlobals();
});

describe("theme-init.js", () => {
  it("uses the same storage key as ThemeProvider", () => {
    expect(src).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });

  it.each([
    ["dark", false, true],
    ["light", true, false],
    ["system", true, true],
    [null, true, true],
    [null, false, false],
  ] as const)("stored %s, prefers dark %s -> dark %s", (stored, prefersDark, expected) => {
    if (stored) localStorage.setItem(THEME_STORAGE_KEY, stored);
    stubPrefersDark(prefersDark);
    run();
    expect(document.documentElement.classList.contains("dark")).toBe(expected);
  });

  it("falls back to the system preference when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    stubPrefersDark(true);
    run();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
```

Run: `pnpm --filter @kamino/web test -- theme-init`
Expected: FAIL — `ENOENT ... theme-init.js`.

- [ ] **Step 4: `theme-init.js`, `index.html`, `vite.config.ts`**

`apps/web/public/theme-init.js`:

```js
// Applies the dark class before first paint (no theme flash).
// External file, not inline, so a strict CSP without 'unsafe-inline' still works.
// Storage key must match THEME_STORAGE_KEY in src/theme/ThemeProvider.tsx (tested).
(function () {
  var stored = null;
  try {
    stored = window.localStorage.getItem("theme");
  } catch (e) {
    stored = null;
  }
  var prefersDark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  var dark = stored === "dark" || (stored !== "light" && prefersDark);
  if (dark) document.documentElement.classList.add("dark");
})();
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>%PRODUCT_NAME%</title>
    <script src="/theme-init.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/vite.config.ts`: aggiungere il plugin che sostituisce `%PRODUCT_NAME%` e includere `test/` nei test:

```ts
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { PRODUCT_NAME } from "@kamino/brand";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const SERVER = "http://localhost:8080";

/** Injects the product name from @kamino/brand into index.html. */
function brandHtml(): Plugin {
  return {
    name: "brand-html",
    transformIndexHtml: (html) => html.replaceAll("%PRODUCT_NAME%", PRODUCT_NAME),
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), brandHtml()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    proxy: { "/api": SERVER, "/health": SERVER, "/version": SERVER },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
```

Run: `pnpm --filter @kamino/web test -- theme-init`
Expected: PASS.

- [ ] **Step 5: Test della modalità "sistema" nel `ThemeProvider`**

Aggiungere in `apps/web/src/theme/ThemeProvider.test.tsx` (stesso file, nuovo `describe`; importare anche `vi` da `vitest`):

```tsx
describe("ThemeProvider system mode", () => {
  function stubMatchMedia(initial: boolean) {
    const listeners = new Set<() => void>();
    const mq = {
      matches: initial,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    };
    vi.stubGlobal("matchMedia", () => mq);
    return {
      set(dark: boolean) {
        mq.matches = dark;
        for (const l of listeners) l();
      },
      listeners,
    };
  }

  afterEach(() => vi.unstubAllGlobals());

  it("follows the system preference and its changes", () => {
    const media = stubMatchMedia(false);
    mount();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    act(() => media.set(true));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    act(() => media.set(false));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("stops listening when leaving system mode", () => {
    const media = stubMatchMedia(false);
    mount();
    act(() => api.setTheme("light"));
    expect(media.listeners.size).toBe(0);
    act(() => media.set(true));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
```

Run: `pnpm --filter @kamino/web test -- ThemeProvider`
Expected: PASS (il comportamento esiste già; il test lo fissa).

- [ ] **Step 6: Verifica e commit**

Run: `pnpm --filter @kamino/web build && pnpm --filter @kamino/web lint`
Expected: build ok; `apps/web/dist/index.html` contiene `<title>Kamino</title>` e `<script src="/theme-init.js">`; `dist/theme-init.js` esiste.

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): add design tokens, bundled fonts and flash-free theme init"
```

---

### Task 4: Web — componenti di base, `StatusBadge`, `ThemeSwitcher`

**Files:**
- Create (generati): `apps/web/src/components/ui/button.tsx`, `badge.tsx`, `card.tsx`, `tooltip.tsx`
- Create: `apps/web/src/components/status/status-icons.ts`, `apps/web/src/components/status/StatusBadge.tsx`, `apps/web/src/theme/ThemeSwitcher.tsx`
- Modify: `apps/web/package.json` (dipendenze `@kamino/status`, `lucide-react`, quelle di shadcn)
- Test: `apps/web/src/components/status/StatusBadge.test.tsx`, `apps/web/src/theme/ThemeSwitcher.test.tsx`

**Interfaces:**
- Consumes: `describeStatus`, `exampleSnapshots`, `DEFAULT_THRESHOLDS`, `formatStatusMessage`, `formatLastConfirmed`, `type StatusDescription`, `type Level`, `type IconName`, `type Lang` da `@kamino/status`; token del Task 3.
- Produces:
  - `StatusBadge(props: { status: StatusDescription; now: number }): JSX.Element`
  - `STATUS_ICONS: Record<IconName, LucideIcon>`, `LEVEL_CLASSES: Record<Level, string>` (in `status-icons.ts`)
  - `StatusDot(props: { level: Level }): JSX.Element` (pallino accanto al nome del dispositivo; esportato da `StatusBadge.tsx`)
  - `ThemeSwitcher(): JSX.Element`
  - `useLang(): Lang` (in `StatusBadge.tsx`, legge `i18n.language`)

- [ ] **Step 1: Componenti shadcn**

Run (dentro `apps/web`): `pnpm dlx shadcn@latest add button badge card tooltip`
Poi: `pnpm --filter @kamino/web add @kamino/status@workspace:* lucide-react`

Controlli dopo la generazione:
- se il CLI ha modificato `src/index.css`, ripristinarlo (`git checkout apps/web/src/index.css`): i token sono quelli del Task 3;
- in `card.tsx`, aggiungere `font-serif` alla classe di `CardTitle` (titoli delle card in serif, spec §4.2);
- `pnpm --filter @kamino/web typecheck` deve passare con `exactOptionalPropertyTypes` (se un componente generato non compila, correggere il tipo nel componente, non il tsconfig).

- [ ] **Step 2: Test di `StatusBadge` (falliscono)**

`apps/web/src/components/status/StatusBadge.test.tsx`:

```tsx
// @vitest-environment jsdom
import { DEFAULT_THRESHOLDS, describeStatus, exampleSnapshots } from "@kamino/status";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n } from "../../i18n/index.js";
import { StatusBadge } from "./StatusBadge.js";

const NOW = Date.UTC(2026, 10, 7, 12);
afterEach(cleanup);

function renderBadge(id: string, lang: "it" | "en" = "it") {
  const ex = exampleSnapshots(NOW).find((e) => e.id === id)!;
  const status = describeStatus(ex.snapshot, DEFAULT_THRESHOLDS, NOW);
  render(
    <I18nextProvider i18n={createI18n(lang)}>
      <StatusBadge status={status} now={NOW} />
    </I18nextProvider>,
  );
  return screen.getByRole("status");
}

describe("StatusBadge", () => {
  it.each([
    ["safe", "Tutto al sicuro", "safe"],
    ["queued", "3 modifiche in attesa", "working"],
    ["offline-2-days", "Server non raggiungibile da 2 g · 14 modifiche non salvate", "attention"],
    ["one-conflict", "1 conflitto da risolvere", "decision"],
    ["revoked", "Dispositivo revocato: il sync è fermo", "blocked"],
  ])("%s shows text and level", (id, text, level) => {
    const el = renderBadge(id);
    expect(el.textContent).toBe(text);
    expect(el.dataset["level"]).toBe(level);
    expect(el.querySelector("svg")).not.toBeNull();
  });

  it("describes the last confirmed sync for assistive tech", () => {
    const el = renderBadge("safe", "en");
    const id = el.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)?.textContent).toBe("Last confirmed sync: 2 min ago");
  });
});
```

Run: `pnpm --filter @kamino/web test -- StatusBadge`
Expected: FAIL — `Cannot find module './StatusBadge.js'`.

- [ ] **Step 3: Implementazione**

`apps/web/src/components/status/status-icons.ts`:

```ts
import type { IconName, Level } from "@kamino/status";
import {
  Clock,
  CloudOff,
  GitCompareArrows,
  OctagonAlert,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

/** Record over IconName: a name missing from lucide-react is a compile error. */
export const STATUS_ICONS: Record<IconName, LucideIcon> = {
  "shield-check": ShieldCheck,
  "refresh-cw": RefreshCw,
  clock: Clock,
  "cloud-off": CloudOff,
  "triangle-alert": TriangleAlert,
  "git-compare-arrows": GitCompareArrows,
  "octagon-alert": OctagonAlert,
};

/** Literal class strings so Tailwind can see them. */
export const LEVEL_CLASSES: Record<Level, string> = {
  safe: "bg-status-safe-surface text-status-safe",
  working: "bg-status-working-surface text-status-working",
  attention: "bg-status-attention-surface text-status-attention",
  decision: "bg-status-decision-surface text-status-decision",
  blocked: "bg-status-blocked-surface text-status-blocked",
};

export const LEVEL_DOT_CLASSES: Record<Level, string> = {
  safe: "bg-status-safe",
  working: "bg-status-working",
  attention: "bg-status-attention",
  decision: "bg-status-decision",
  blocked: "bg-status-blocked",
};
```

`apps/web/src/components/status/StatusBadge.tsx`:

```tsx
import {
  formatLastConfirmed,
  formatStatusMessage,
  type Lang,
  type Level,
  type StatusDescription,
} from "@kamino/status";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { LEVEL_CLASSES, LEVEL_DOT_CLASSES, STATUS_ICONS } from "./status-icons.js";

export function useLang(): Lang {
  const { i18n } = useTranslation();
  return i18n.language.startsWith("it") ? "it" : "en";
}

export function StatusBadge({ status, now }: { status: StatusDescription; now: number }) {
  const lang = useLang();
  const Icon = STATUS_ICONS[status.icon];
  const last = formatLastConfirmed(status.lastConfirmedAt, now, lang);
  const lastId = useId();
  return (
    <>
    <span id={lastId} hidden>
      {last}
    </span>
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          data-level={status.level}
          aria-describedby={lastId}
          tabIndex={0}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
            LEVEL_CLASSES[status.level],
          )}
        >
          <Icon aria-hidden="true" className="size-3.5 shrink-0" />
          {formatStatusMessage(status.message, lang)}
        </span>
      </TooltipTrigger>
      <TooltipContent>{last}</TooltipContent>
    </Tooltip>
    </>
  );
}

/** Status dot next to a device name (never a colored side border). */
export function StatusDot({ level }: { level: Level }) {
  return <span aria-hidden="true" className={cn("inline-block size-2.5 rounded-full", LEVEL_DOT_CLASSES[level])} />;
}
```

Se il `Tooltip` generato richiede un `TooltipProvider` esterno, avvolgere il contenuto di `StatusBadge` in `<TooltipProvider>` (il test deve passare senza provider esterno).

Run: `pnpm --filter @kamino/web test -- StatusBadge`
Expected: PASS.

- [ ] **Step 4: `ThemeSwitcher` (test, poi implementazione)**

`apps/web/src/theme/ThemeSwitcher.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n } from "../i18n/index.js";
import { ThemeProvider } from "./ThemeProvider.js";
import { ThemeSwitcher } from "./ThemeSwitcher.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("ThemeSwitcher", () => {
  it("shows the three options and marks the current one", () => {
    render(
      <I18nextProvider i18n={createI18n("it")}>
        <ThemeProvider>
          <ThemeSwitcher />
        </ThemeProvider>
      </I18nextProvider>,
    );
    expect(screen.getByRole("group", { name: "Tema" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Sistema" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Scuro" }));
    expect(screen.getByRole("button", { name: "Scuro" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
```

`apps/web/src/theme/ThemeSwitcher.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useTheme, type Theme } from "./ThemeProvider.js";

const OPTIONS: Theme[] = ["light", "dark", "system"];

export function ThemeSwitcher() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  return (
    <div role="group" aria-label={t("theme.label")} className="inline-flex gap-1">
      {OPTIONS.map((o) => (
        <Button
          key={o}
          size="sm"
          variant={theme === o ? "default" : "outline"}
          aria-pressed={theme === o}
          onClick={() => setTheme(o)}
        >
          {t(`theme.${o}`)}
        </Button>
      ))}
    </div>
  );
}
```

Run: `pnpm --filter @kamino/web test`
Expected: PASS (tutti i test web).

- [ ] **Step 5: Verifica e commit**

Run: `pnpm --filter @kamino/web typecheck && pnpm --filter @kamino/web lint`

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): add base ui components, StatusBadge and ThemeSwitcher"
```

---

### Task 5: Web — galleria `/dev/gallery` solo in sviluppo

**Files:**
- Create: `apps/web/src/dev/GalleryPage.tsx`
- Modify: `apps/web/src/main.tsx`, `apps/web/src/i18n/locales/it.json`, `apps/web/src/i18n/locales/en.json`
- Test: `apps/web/test/build.test.ts`, `apps/web/src/dev/GalleryPage.test.tsx`

**Interfaces:**
- Consumes: `StatusBadge`, `StatusDot`, `useLang`, `ThemeSwitcher`, `Button`, `Badge`, `Card*`, `exampleSnapshots`, `describeStatus`, `DEFAULT_THRESHOLDS`.
- Produces: `GalleryPage` (default export) con l'attributo marcatore `data-dev-gallery="true"` sulla radice; costante `GALLERY_MARKER = "data-dev-gallery"` usata dal test di build.

- [ ] **Step 1: Test di build (fallisce)**

`apps/web/test/build.test.ts`:

```ts
// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
let out: string;
let files: string[];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "web-build-"));
  await build({ root, configFile: join(root, "vite.config.ts"), logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
  files = walk(out);
}, 120_000);

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("production build", () => {
  it("does not ship the dev gallery", () => {
    for (const f of files.filter((x) => /\.(js|html)$/.test(x))) {
      expect(readFileSync(f, "utf8"), f).not.toContain("data-dev-gallery");
    }
  });

  it("does not load fonts from external hosts", () => {
    for (const f of files.filter((x) => x.endsWith(".css"))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/url\(\s*["']?https?:/);
    }
    expect(files.some((f) => f.endsWith(".woff2"))).toBe(true);
  });

  it("injects the product name into the title", () => {
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toMatch(/<title>[^%<]+<\/title>/);
  });
});
```

Prima di creare la galleria il test **passa** sul primo caso (la galleria non esiste): per vederlo fallire, creare temporaneamente in `main.tsx` un riferimento statico `console.log("data-dev-gallery")`, verificare il FAIL, poi rimuoverlo. Run: `pnpm --filter @kamino/web test -- build` → FAIL con il riferimento, PASS senza.

- [ ] **Step 2: Testi della galleria**

Aggiungere a `apps/web/src/i18n/locales/it.json`:

```json
"gallery": {
  "title": "Galleria del design system",
  "palette": "Palette",
  "typography": "Tipografia",
  "components": "Componenti",
  "statuses": "Stati di sync",
  "device": "Card dispositivo",
  "language": "Lingua",
  "sampleHeading": "Titolo di pagina",
  "sampleBody": "Testo dell'interfaccia: chiaro, leggibile, senza gergo tecnico.",
  "sampleDevice": "Portatile di esempio",
  "syncNow": "Sincronizza ora",
  "secondary": "Altro"
}
```

e a `en.json`:

```json
"gallery": {
  "title": "Design system gallery",
  "palette": "Palette",
  "typography": "Typography",
  "components": "Components",
  "statuses": "Sync statuses",
  "device": "Device card",
  "language": "Language",
  "sampleHeading": "Page title",
  "sampleBody": "Interface text: clear, readable, no technical jargon.",
  "sampleDevice": "Sample laptop",
  "syncNow": "Sync now",
  "secondary": "Secondary"
}
```

- [ ] **Step 3: `GalleryPage` (con test di rendering)**

`apps/web/src/dev/GalleryPage.test.tsx`:

```tsx
// @vitest-environment jsdom
import { exampleSnapshots } from "@kamino/status";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n } from "../i18n/index.js";
import { ThemeProvider } from "../theme/ThemeProvider.js";
import GalleryPage from "./GalleryPage.js";

afterEach(cleanup);

describe("GalleryPage", () => {
  it("renders one badge per example snapshot in each theme pane", () => {
    render(
      <I18nextProvider i18n={createI18n("it")}>
        <ThemeProvider>
          <GalleryPage />
        </ThemeProvider>
      </I18nextProvider>,
    );
    const n = exampleSnapshots(0).length;
    expect(screen.getAllByRole("status")).toHaveLength(n * 2 + 2);
  });
});
```

(`n * 2` badge degli esempi nei due pannelli chiaro/scuro + 2 badge nelle card dispositivo.)

`apps/web/src/dev/GalleryPage.tsx`:

```tsx
import { DEFAULT_THRESHOLDS, describeStatus, exampleSnapshots, formatStatusMessage } from "@kamino/status";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { StatusBadge, StatusDot, useLang } from "@/components/status/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ThemeSwitcher } from "@/theme/ThemeSwitcher";

const TOKENS = [
  "background", "card", "foreground", "muted", "muted-foreground", "primary", "link", "border",
  "status-safe", "status-working", "status-attention", "status-decision", "status-blocked",
];

function Pane({ theme, now }: { theme: "light" | "dark"; now: number }) {
  const { t } = useTranslation();
  const lang = useLang();
  const examples = useMemo(() => exampleSnapshots(now), [now]);
  const device = describeStatus(examples[0]!.snapshot, DEFAULT_THRESHOLDS, now);
  return (
    <section className={`${theme} bg-background text-foreground space-y-6 rounded-xl p-6`}>
      <h2 className="font-serif text-xl font-semibold">{theme}</h2>

      <div>
        <h3 className="mb-2 text-sm font-semibold">{t("gallery.palette")}</h3>
        <ul className="grid grid-cols-4 gap-2 text-xs">
          {TOKENS.map((tok) => (
            <li key={tok} className="flex items-center gap-2">
              <span className="size-6 rounded-md border" style={{ background: `var(--${tok})` }} />
              <code>{tok}</code>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t("gallery.typography")}</h3>
        <p className="font-serif text-2xl font-semibold">{t("gallery.sampleHeading")}</p>
        <p>{t("gallery.sampleBody")}</p>
        <p className="text-muted-foreground text-sm">{t("gallery.sampleBody")}</p>
        <a className="text-link underline" href="#gallery">{t("gallery.syncNow")}</a>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{t("gallery.components")}</h3>
        <div className="flex flex-wrap gap-2">
          <Button>{t("gallery.syncNow")}</Button>
          <Button variant="outline">{t("gallery.syncNow")}</Button>
          <Badge variant="secondary">{t("gallery.secondary")}</Badge>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{t("gallery.statuses")}</h3>
        <ul className="space-y-2">
          {examples.map((ex) => {
            const s = describeStatus(ex.snapshot, DEFAULT_THRESHOLDS, now);
            return (
              <li key={ex.id} className="flex flex-wrap items-center gap-2 text-sm">
                <code className="text-muted-foreground w-44">{ex.id}</code>
                <StatusBadge status={s} now={now} />
                {s.secondary.length > 0 && (
                  <span className="text-muted-foreground text-xs">
                    {s.secondary.map((m) => formatStatusMessage(m, lang)).join(" · ")}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{t("gallery.device")}</h3>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <StatusDot level={device.level} />
              {t("gallery.sampleDevice")}
            </CardTitle>
            <CardDescription>
              <StatusBadge status={device} now={now} />
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button size="sm">{t("gallery.syncNow")}</Button>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

export default function GalleryPage() {
  const { t, i18n } = useTranslation();
  const now = useMemo(() => Date.now(), []);
  return (
    <main data-dev-gallery="true" className="mx-auto max-w-7xl space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-serif text-3xl font-semibold">{t("gallery.title")}</h1>
        <div className="flex items-center gap-4">
          <ThemeSwitcher />
          <div role="group" aria-label={t("gallery.language")} className="inline-flex gap-1">
            {(["it", "en"] as const).map((l) => (
              <Button
                key={l}
                size="sm"
                variant={i18n.language === l ? "default" : "outline"}
                aria-pressed={i18n.language === l}
                onClick={() => {
                  void i18n.changeLanguage(l);
                  document.documentElement.lang = l;
                }}
              >
                {l.toUpperCase()}
              </Button>
            ))}
          </div>
        </div>
      </header>
      <div className="grid gap-6 lg:grid-cols-2">
        <Pane theme="light" now={now} />
        <Pane theme="dark" now={now} />
      </div>
    </main>
  );
}
```

Nota: `.light` reimposta i token chiari anche dentro una radice `.dark` (selettore `:root, .light` del Task 3), così i due pannelli restano affiancati indipendentemente dal tema scelto. Il `ThemeSwitcher` cambia lo sfondo della pagina intorno ai pannelli.

Run: `pnpm --filter @kamino/web test -- GalleryPage`
Expected: PASS.

- [ ] **Step 4: Caricamento solo in sviluppo**

`apps/web/src/main.tsx`:

```tsx
import { PRODUCT_NAME } from "@kamino/brand";
import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { createI18n, detectLanguage } from "./i18n/index.js";
import { AboutPage } from "./pages/AboutPage.js";
import { ThemeProvider } from "./theme/ThemeProvider.js";
import "./index.css";

const i18n = createI18n(detectLanguage(navigator.language));
document.documentElement.lang = i18n.language;
document.title = PRODUCT_NAME;

// Dev-only: `import.meta.env.DEV` is a build-time constant, so the gallery chunk is
// dropped from production builds (checked by test/build.test.ts).
const Page =
  import.meta.env.DEV && location.pathname.startsWith("/dev/gallery")
    ? lazy(() => import("./dev/GalleryPage.js"))
    : AboutPage;

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <Suspense>
          <Page />
        </Suspense>
      </ThemeProvider>
    </I18nextProvider>
  </StrictMode>,
);
```

Run: `pnpm --filter @kamino/web test`
Expected: PASS, compreso `test/build.test.ts`.

- [ ] **Step 5: Verifica manuale e commit**

Run: `pnpm --filter @kamino/web dev`, aprire `http://localhost:5173/dev/gallery`: due pannelli (chiaro e scuro), 14 badge per pannello, card dispositivo con pallino; il selettore lingua cambia tutti i testi; ricaricando in tema scuro non c'è flash chiaro.

```bash
git add apps/web
git commit -m "feat(web): add dev-only design system gallery"
```

---

### Task 6: Plugin — CSS degli stati e rendering dell'indicatore

**Files:**
- Modify: `apps/plugin/package.json` (dipendenza `@kamino/status`)
- Modify: `apps/plugin/src/__mocks__/obsidian.ts`
- Modify: `apps/plugin/src/styles.css`
- Create: `apps/plugin/src/ui/status-classes.ts`, `apps/plugin/src/ui/render-status.ts`
- Test: `apps/plugin/src/ui/render-status.test.ts`, `apps/plugin/test/styles.test.ts`

**Interfaces:**
- Consumes: `StatusDescription`, `Level`, `LEVELS`, `severity`, `IconName`, `Lang`, `formatStatusMessage`, `formatLastConfirmed` da `@kamino/status`.
- Produces:
  - `STATUS_CLASS: string` (= `${PRODUCT_SLUG}-status`), `levelClass(level: Level): string`
  - `FALLBACK_ICON: Record<Level, string>`
  - `resolveIcon(status: StatusDescription, available: ReadonlySet<string> | null): string`
  - `statusLabel(status: StatusDescription, now: number, lang: Lang): string` (messaggio + secondari + ultimo sync, separati da " · ")
  - `renderStatusIndicator(el: HTMLElement, status: StatusDescription, opts: { lang: Lang; now: number; available: ReadonlySet<string> | null }): void`
  - `shouldShowHeaderAction(level: Level, isMobile: boolean): boolean`
  - `shouldNotify(prev: Level | null, next: Level): boolean`
- Mock `obsidian` produce: `setIcon`, `getIconIds`, `Notice` (con `Notice.shown: string[]`), `Platform` (`isMobile` modificabile), `MarkdownView` (con `addAction`), `Plugin.addStatusBarItem/addRibbonIcon/addCommand/registerEvent`, `App.workspace` (`on`, `getActiveViewOfType`, `trigger`).

- [ ] **Step 1: Estendere il mock di `obsidian`**

Sostituire `apps/plugin/src/__mocks__/obsidian.ts` con (mantiene `App`, `Plugin`, `PluginSettingTab`, `Setting`, `moment` esistenti e aggiunge il resto):

```ts
// Minimal runtime stand-in for the `obsidian` package (types only upstream).
// Aliased in vitest.config.ts.

interface ObsidianElement extends HTMLElement {
  empty(): void;
}

function makeEl(): ObsidianElement {
  const el = document.createElement("div") as ObsidianElement;
  el.empty = () => {
    el.replaceChildren();
  };
  return el;
}

/** Icons known to the mock; tests may replace the set. */
export const mockIcons = { ids: new Set<string>(["lucide-shield-check", "lucide-clock", "lucide-cloud-off", "lucide-refresh-cw", "lucide-triangle-alert", "lucide-git-compare-arrows", "lucide-octagon-alert"]) };

export function getIconIds(): string[] {
  return [...mockIcons.ids];
}

export function setIcon(parent: HTMLElement, iconId: string): void {
  parent.replaceChildren();
  parent.dataset["icon"] = iconId;
  parent.append(document.createElementNS("http://www.w3.org/2000/svg", "svg"));
}

export class Notice {
  static shown: string[] = [];
  constructor(message: string) {
    Notice.shown.push(message);
  }
}

export const Platform = { isMobile: false, isDesktop: true };

type Handler = (...args: unknown[]) => void;

export class MarkdownView {
  actions: HTMLElement[] = [];
  addAction(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
    const el = document.createElement("a");
    el.dataset["icon"] = icon;
    el.setAttribute("aria-label", title);
    el.addEventListener("click", (e) => callback(e as MouseEvent));
    this.actions.push(el);
    return el;
  }
}

export class Workspace {
  private handlers = new Map<string, Handler[]>();
  activeView: MarkdownView | null = null;
  on(name: string, cb: Handler): { name: string } {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), cb]);
    return { name };
  }
  trigger(name: string, ...args: unknown[]): void {
    for (const h of this.handlers.get(name) ?? []) h(...args);
  }
  getActiveViewOfType<T>(_type: unknown): T | null {
    return this.activeView as T | null;
  }
}

export class App {
  workspace = new Workspace();
}

export interface Command {
  id: string;
  name: string;
  callback?: () => unknown;
}

export class Plugin {
  app = new App();
  tabs: PluginSettingTab[] = [];
  statusBarItems: ObsidianElement[] = [];
  ribbonIcons: HTMLElement[] = [];
  commands: Command[] = [];
  addSettingTab(tab: PluginSettingTab): void {
    this.tabs.push(tab);
  }
  addStatusBarItem(): HTMLElement {
    const el = makeEl();
    this.statusBarItems.push(el);
    return el;
  }
  addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
    const el = document.createElement("div");
    setIcon(el, icon);
    el.setAttribute("aria-label", title);
    el.addEventListener("click", (e) => callback(e as MouseEvent));
    this.ribbonIcons.push(el);
    return el;
  }
  addCommand(command: Command): Command {
    this.commands.push(command);
    return command;
  }
  registerEvent(_ref: unknown): void {}
}

export class PluginSettingTab {
  containerEl: ObsidianElement = makeEl();
  constructor(
    public app: App,
    public plugin: Plugin,
  ) {}
}

export class Setting {
  private nameEl = document.createElement("div");
  private descEl = document.createElement("div");
  constructor(containerEl: HTMLElement) {
    const item = document.createElement("div");
    item.append(this.nameEl, this.descEl);
    containerEl.append(item);
  }
  setName(name: string): this {
    this.nameEl.textContent = name;
    return this;
  }
  setDesc(desc: string): this {
    this.descEl.textContent = desc;
    return this;
  }
  setHeading(): this {
    return this;
  }
}

let currentLocale = "en";
export const moment = {
  locale(next?: string): string {
    if (next !== undefined) currentLocale = next;
    return currentLocale;
  },
};
```

Run: `pnpm --filter @kamino/plugin add @kamino/status@workspace:*` poi `pnpm --filter @kamino/plugin test`
Expected: PASS (i test esistenti non cambiano).

- [ ] **Step 2: Test del rendering (falliscono)**

`apps/plugin/src/ui/render-status.test.ts`:

```ts
import { DEFAULT_THRESHOLDS, describeStatus, exampleSnapshots, LEVELS, type Level } from "@kamino/status";
import { describe, expect, it } from "vitest";
import {
  FALLBACK_ICON,
  levelClass,
  renderStatusIndicator,
  resolveIcon,
  shouldNotify,
  shouldShowHeaderAction,
  STATUS_CLASS,
  statusLabel,
} from "./render-status.js";

const NOW = Date.UTC(2026, 10, 7, 12);
const status = (id: string) =>
  describeStatus(exampleSnapshots(NOW).find((e) => e.id === id)!.snapshot, DEFAULT_THRESHOLDS, NOW);

describe("renderStatusIndicator", () => {
  it("renders icon, text, level class and aria-label", () => {
    const el = document.createElement("div");
    renderStatusIndicator(el, status("offline-2-days"), { lang: "it", now: NOW, available: null });
    expect(el.classList.contains(STATUS_CLASS)).toBe(true);
    expect(el.classList.contains(levelClass("attention"))).toBe(true);
    expect(el.textContent).toBe("Server non raggiungibile da 2 g · 14 modifiche non salvate");
    expect(el.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("cloud-off");
    expect(el.getAttribute("aria-label")).toContain("Ultimo sync confermato: 2 g fa");
  });

  it("replaces the previous level class on re-render", () => {
    const el = document.createElement("div");
    renderStatusIndicator(el, status("one-conflict"), { lang: "en", now: NOW, available: null });
    renderStatusIndicator(el, status("safe"), { lang: "en", now: NOW, available: null });
    expect(el.classList.contains(levelClass("decision"))).toBe(false);
    expect(el.classList.contains(levelClass("safe"))).toBe(true);
    expect(el.querySelectorAll("[data-icon]")).toHaveLength(1);
  });
});

describe("resolveIcon", () => {
  it("keeps the name when available (bare or lucide- prefixed)", () => {
    expect(resolveIcon(status("safe"), new Set(["lucide-shield-check"]))).toBe("shield-check");
    expect(resolveIcon(status("safe"), new Set(["shield-check"]))).toBe("shield-check");
    expect(resolveIcon(status("safe"), null)).toBe("shield-check");
  });

  it("falls back per level when missing", () => {
    expect(resolveIcon(status("revoked"), new Set())).toBe(FALLBACK_ICON.blocked);
  });
});

describe("statusLabel", () => {
  it("joins message, secondary and last sync", () => {
    expect(statusLabel(status("conflicts-and-offline"), NOW, "en")).toBe(
      "3 conflicts to resolve · Server unreachable for 2 d · Last confirmed sync: 2 min ago",
    );
  });
});

describe("shouldShowHeaderAction", () => {
  it.each(LEVELS.map((l) => [l]))("%s", (level: Level) => {
    const expected = level === "attention" || level === "decision" || level === "blocked";
    expect(shouldShowHeaderAction(level, true)).toBe(expected);
    expect(shouldShowHeaderAction(level, false)).toBe(false);
  });
});

describe("shouldNotify", () => {
  it("notifies when entering or changing among attention+ levels", () => {
    expect(shouldNotify("safe", "attention")).toBe(true);
    expect(shouldNotify("attention", "blocked")).toBe(true);
    expect(shouldNotify(null, "decision")).toBe(true);
    expect(shouldNotify("attention", "attention")).toBe(false);
    expect(shouldNotify("blocked", "safe")).toBe(false);
    expect(shouldNotify(null, "working")).toBe(false);
  });
});
```

Run: `pnpm --filter @kamino/plugin test -- render-status`
Expected: FAIL — `Cannot find module './render-status.js'`.

- [ ] **Step 3: Implementazione**

`apps/plugin/src/ui/status-classes.ts`:

```ts
import { PRODUCT_SLUG } from "@kamino/brand";
import type { Level } from "@kamino/status";

// styles.css cannot import brand: test/styles.test.ts checks it uses these names.
export const STATUS_CLASS = `${PRODUCT_SLUG}-status`;

export function levelClass(level: Level): string {
  return `${STATUS_CLASS}--${level}`;
}
```

`apps/plugin/src/ui/render-status.ts`:

```ts
import { setIcon } from "obsidian";
import {
  formatLastConfirmed,
  formatStatusMessage,
  LEVELS,
  severity,
  type Lang,
  type Level,
  type StatusDescription,
} from "@kamino/status";
import { levelClass, STATUS_CLASS } from "./status-classes.js";

export { levelClass, STATUS_CLASS };

/** Older Lucide names, present in older Obsidian builds. */
export const FALLBACK_ICON: Record<Level, string> = {
  safe: "check",
  working: "clock",
  attention: "alert-triangle",
  decision: "git-compare",
  blocked: "x-octagon",
};

export function resolveIcon(status: StatusDescription, available: ReadonlySet<string> | null): string {
  if (available === null) return status.icon;
  if (available.has(status.icon) || available.has(`lucide-${status.icon}`)) return status.icon;
  console.warn(`status icon "${status.icon}" not available, using fallback`);
  return FALLBACK_ICON[status.level];
}

export function statusLabel(status: StatusDescription, now: number, lang: Lang): string {
  return [status.message, ...status.secondary]
    .map((m) => formatStatusMessage(m, lang))
    .concat(formatLastConfirmed(status.lastConfirmedAt, now, lang))
    .join(" · ");
}

export function renderStatusIndicator(
  el: HTMLElement,
  status: StatusDescription,
  opts: { lang: Lang; now: number; available: ReadonlySet<string> | null },
): void {
  const doc = el.ownerDocument;
  el.replaceChildren();
  el.classList.add(STATUS_CLASS);
  for (const l of LEVELS) el.classList.toggle(levelClass(l), l === status.level);
  const icon = doc.createElement("span");
  icon.className = `${STATUS_CLASS}__icon`;
  setIcon(icon, resolveIcon(status, opts.available));
  const text = doc.createElement("span");
  text.className = `${STATUS_CLASS}__text`;
  text.textContent = formatStatusMessage(status.message, opts.lang);
  el.append(icon, text);
  el.setAttribute("aria-label", statusLabel(status, opts.now, opts.lang));
}

const ATTENTION = severity("attention");

export function shouldShowHeaderAction(level: Level, isMobile: boolean): boolean {
  return isMobile && severity(level) >= ATTENTION;
}

export function shouldNotify(prev: Level | null, next: Level): boolean {
  return severity(next) >= ATTENTION && next !== prev;
}
```

Run: `pnpm --filter @kamino/plugin test -- render-status`
Expected: PASS.

- [ ] **Step 4: CSS e test di coerenza dei nomi**

`apps/plugin/test/styles.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEVELS } from "@kamino/status";
import { describe, expect, it } from "vitest";
import { levelClass, STATUS_CLASS } from "../src/ui/status-classes.js";

const css = readFileSync(join(import.meta.dirname, "../src/styles.css"), "utf8");

describe("styles.css", () => {
  it("defines a class per level using the brand prefix", () => {
    expect(css).toContain(`.${STATUS_CLASS} `);
    for (const l of LEVELS) expect(css).toContain(`.${levelClass(l)}`);
  });

  it("uses only Obsidian variables for colors", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  });
});
```

Aggiungere a `apps/plugin/src/styles.css`:

```css
/* Sync status indicator. Prefix = PRODUCT_SLUG (see docs/renaming.md); checked by test/styles.test.ts.
   Colors come only from Obsidian variables, so every theme stays consistent. */
.kamino-status {
  display: inline-flex;
  align-items: center;
  gap: var(--size-4-1);
}
.kamino-status__icon {
  display: inline-flex;
}
.kamino-status__icon svg {
  width: var(--icon-s);
  height: var(--icon-s);
}
.kamino-status--safe .kamino-status__icon {
  color: var(--color-green);
}
.kamino-status--working .kamino-status__icon {
  color: var(--text-muted);
}
.kamino-status--attention .kamino-status__icon {
  color: var(--color-yellow);
}
.kamino-status--decision .kamino-status__icon {
  color: var(--color-purple);
}
.kamino-status--blocked .kamino-status__icon {
  color: var(--color-red);
}
.kamino-status-action--attention {
  color: var(--color-yellow);
}
.kamino-status-action--decision {
  color: var(--color-purple);
}
.kamino-status-action--blocked {
  color: var(--color-red);
}
```

Il testo resta in `--text-normal`/colore della barra di stato (ereditato): solo l'icona è colorata, così il contrasto del testo è quello del tema.

Run: `pnpm --filter @kamino/plugin test`
Expected: PASS.

- [ ] **Step 5: Verifica e commit**

Run: `pnpm --filter @kamino/plugin typecheck && pnpm --filter @kamino/plugin lint`

```bash
git add apps/plugin pnpm-lock.yaml
git commit -m "feat(plugin): add status classes and indicator rendering"
```

---

### Task 7: Plugin — `StatusIndicator`, collegamento in `main.ts`, galleria di sviluppo

**Files:**
- Create: `apps/plugin/src/ui/StatusIndicator.ts`, `apps/plugin/src/dev/status-gallery.ts`
- Modify: `apps/plugin/src/main.ts`, `apps/plugin/src/globals.d.ts`, `apps/plugin/scripts/build-constants.ts`, `apps/plugin/esbuild.config.mjs`, `apps/plugin/vitest.config.ts`, `apps/plugin/package.json` (script `build:dev`), `apps/plugin/src/i18n/it.json`, `apps/plugin/src/i18n/en.json`
- Test: `apps/plugin/src/ui/StatusIndicator.test.ts`, `apps/plugin/test/manifest.test.ts` (asserzione sul bundle)

**Interfaces:**
- Consumes: tutto il Task 6; `describeStatus`, `DEFAULT_THRESHOLDS`, `exampleSnapshots`, `type SyncSnapshot` da `@kamino/status`; `detectLanguage` da `src/i18n/index.ts`.
- Produces:
  - `class StatusIndicator { constructor(plugin: Plugin, deps: IndicatorDeps); mount(): void; update(status: StatusDescription): void; readonly level: Level | null }`
  - `interface IndicatorDeps { isMobile: boolean; lang: Lang; now: () => number; available: ReadonlySet<string> | null }`
  - `INITIAL_SNAPSHOT: SyncSnapshot` (mai sincronizzato, in `StatusIndicator.ts`)
  - `registerStatusGallery(plugin: Plugin, indicator: StatusIndicator, deps: { now: () => number; lang: Lang }): void`, comando con id `dev-status-gallery`
  - costante di build `__DEV__: boolean`

- [ ] **Step 1: Test di `StatusIndicator` (falliscono)**

`apps/plugin/src/ui/StatusIndicator.test.ts`:

```ts
import { DEFAULT_THRESHOLDS, describeStatus, exampleSnapshots } from "@kamino/status";
import { MarkdownView, Notice, Plugin } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";
import { levelClass } from "./status-classes.js";
import { StatusIndicator } from "./StatusIndicator.js";

const NOW = Date.UTC(2026, 10, 7, 12);
const status = (id: string) =>
  describeStatus(exampleSnapshots(NOW).find((e) => e.id === id)!.snapshot, DEFAULT_THRESHOLDS, NOW);

function setup(isMobile: boolean) {
  const plugin = new Plugin();
  const view = new MarkdownView();
  plugin.app.workspace.activeView = view;
  const indicator = new StatusIndicator(plugin as never, { isMobile, lang: "it", now: () => NOW, available: null });
  indicator.mount();
  return { plugin, view, indicator };
}

beforeEach(() => {
  Notice.shown = [];
});

describe("StatusIndicator on desktop", () => {
  it("adds a status bar item and a ribbon icon, both updated", () => {
    const { plugin, indicator } = setup(false);
    indicator.update(status("one-conflict"));
    expect(plugin.statusBarItems).toHaveLength(1);
    expect(plugin.statusBarItems[0]!.textContent).toBe("1 conflitto da risolvere");
    expect(plugin.statusBarItems[0]!.classList.contains(levelClass("decision"))).toBe(true);
    expect(plugin.ribbonIcons[0]!.dataset["icon"]).toBe("git-compare-arrows");
  });

  it("never adds a header action", () => {
    const { view, indicator } = setup(false);
    indicator.update(status("revoked"));
    expect(view.actions).toHaveLength(0);
  });
});

describe("StatusIndicator on mobile", () => {
  it("has no status bar item", () => {
    const { plugin } = setup(true);
    expect(plugin.statusBarItems).toHaveLength(0);
  });

  it("shows the header action only from attention up, and removes it", () => {
    const { view, indicator } = setup(true);
    indicator.update(status("queued"));
    expect(view.actions).toHaveLength(0);
    indicator.update(status("offline-2-days"));
    expect(view.actions).toHaveLength(1);
    expect(view.actions[0]!.dataset["icon"]).toBe("cloud-off");
    indicator.update(status("safe"));
    expect(view.actions[0]!.dataset["removed"]).toBe("true");
  });

  it("moves the header action to the new active note", () => {
    const { plugin, view, indicator } = setup(true);
    indicator.update(status("one-conflict"));
    const other = new MarkdownView();
    plugin.app.workspace.activeView = other;
    plugin.app.workspace.trigger("active-leaf-change");
    expect(view.actions[0]!.dataset["removed"]).toBe("true");
    expect(other.actions).toHaveLength(1);
  });
});

describe("StatusIndicator notices", () => {
  it("notifies once per change into attention+ levels", () => {
    const { indicator } = setup(false);
    indicator.update(status("safe"));
    indicator.update(status("stale-queue"));
    indicator.update(status("stale-queue"));
    indicator.update(status("revoked"));
    expect(Notice.shown).toEqual([
      "5 modifiche non salvate da 2 h",
      "Dispositivo revocato: il sync è fermo",
    ]);
  });

  it("clicking the ribbon shows the full label", () => {
    const { plugin, indicator } = setup(false);
    indicator.update(status("safe"));
    plugin.ribbonIcons[0]!.click();
    expect(Notice.shown.at(-1)).toBe("Tutto al sicuro · Ultimo sync confermato: 2 min fa");
  });
});
```

Nota: per poter verificare la rimozione senza un DOM reale di Obsidian, `StatusIndicator` rimuove l'azione con `el.remove()` e imposta `el.dataset.removed = "true"`.

Run: `pnpm --filter @kamino/plugin test -- StatusIndicator`
Expected: FAIL — `Cannot find module './StatusIndicator.js'`.

- [ ] **Step 2: Implementazione di `StatusIndicator`**

`apps/plugin/src/ui/StatusIndicator.ts`:

```ts
import { MarkdownView, Notice, setIcon, type Plugin } from "obsidian";
import { formatStatusMessage, type Lang, type Level, type StatusDescription, type SyncSnapshot } from "@kamino/status";
import {
  renderStatusIndicator,
  resolveIcon,
  shouldNotify,
  shouldShowHeaderAction,
  statusLabel,
  STATUS_CLASS,
} from "./render-status.js";

export interface IndicatorDeps {
  isMobile: boolean;
  lang: Lang;
  now: () => number;
  available: ReadonlySet<string> | null;
}

/** State before the sync engine exists (M1): honest "never synced". */
export const INITIAL_SNAPSHOT: SyncSnapshot = {
  queued: 0,
  oldestQueuedAt: null,
  lastConfirmedAt: null,
  unreachableSince: null,
  syncing: false,
  conflicts: 0,
  blocked: null,
  quotaRatio: null,
};

/** "Never silent" indicator (S-05): status bar, ribbon, mobile header action, notices. */
export class StatusIndicator {
  private statusBarEl: HTMLElement | null = null;
  private ribbonEl: HTMLElement | null = null;
  private headerActionEl: HTMLElement | null = null;
  private status: StatusDescription | null = null;
  private current: Level | null = null;

  constructor(
    private readonly plugin: Plugin,
    private readonly deps: IndicatorDeps,
  ) {}

  get level(): Level | null {
    return this.current;
  }

  mount(): void {
    if (!this.deps.isMobile) {
      this.statusBarEl = this.plugin.addStatusBarItem();
      this.statusBarEl.addEventListener("click", () => this.showDetails());
    }
    this.ribbonEl = this.plugin.addRibbonIcon("clock", "", () => this.showDetails());
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("active-leaf-change", () => this.syncHeaderAction(true)),
    );
  }

  update(status: StatusDescription): void {
    const prev = this.current;
    this.status = status;
    this.current = status.level;
    const now = this.deps.now();
    const opts = { lang: this.deps.lang, now, available: this.deps.available };
    if (this.statusBarEl) renderStatusIndicator(this.statusBarEl, status, opts);
    if (this.ribbonEl) {
      setIcon(this.ribbonEl, resolveIcon(status, this.deps.available));
      this.ribbonEl.setAttribute("aria-label", statusLabel(status, now, this.deps.lang));
    }
    this.syncHeaderAction(prev !== status.level);
    if (shouldNotify(prev, status.level)) {
      new Notice(formatStatusMessage(status.message, this.deps.lang));
    }
  }

  private syncHeaderAction(rebuild: boolean): void {
    const status = this.status;
    const show = status !== null && shouldShowHeaderAction(status.level, this.deps.isMobile);
    if (this.headerActionEl && (rebuild || !show)) {
      this.headerActionEl.remove();
      this.headerActionEl.dataset["removed"] = "true";
      this.headerActionEl = null;
    }
    if (!show || this.headerActionEl) return;
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const now = this.deps.now();
    this.headerActionEl = view.addAction(
      resolveIcon(status, this.deps.available),
      statusLabel(status, now, this.deps.lang),
      () => this.showDetails(),
    );
    this.headerActionEl.classList.add(`${STATUS_CLASS}-action--${status.level}`);
  }

  private showDetails(): void {
    if (!this.status) return;
    new Notice(statusLabel(this.status, this.deps.now(), this.deps.lang));
  }
}
```

Run: `pnpm --filter @kamino/plugin test -- StatusIndicator`
Expected: PASS.

- [ ] **Step 3: Costante `__DEV__` e build di sviluppo**

`apps/plugin/scripts/build-constants.ts`: cambiare la firma in `buildConstants(opts: { dev: boolean } = { dev: false })` e aggiungere al risultato:

```ts
    __DEV__: JSON.stringify(opts.dev),
```

`apps/plugin/src/globals.d.ts`: aggiungere

```ts
declare const __DEV__: boolean;
```

`apps/plugin/esbuild.config.mjs`: 

```js
const dev = process.argv.includes("--dev");
// ...
  define: buildConstants({ dev }),
  minifySyntax: !dev, // drops `if (false) { ... }` branches in production
```

`apps/plugin/package.json` script: `"build:dev": "tsx esbuild.config.mjs --dev"`.

`apps/plugin/vitest.config.ts`: `define: buildConstants({ dev: true })`.

- [ ] **Step 4: Galleria di sviluppo e `main.ts`**

Aggiungere ai JSON del plugin (stessa chiave in entrambi):

`src/i18n/it.json` → `"dev": { "statusGallery": "Mostra galleria stati (sviluppo)" }`
`src/i18n/en.json` → `"dev": { "statusGallery": "Show status gallery (development)" }`

`apps/plugin/src/dev/status-gallery.ts`:

```ts
import { DEFAULT_THRESHOLDS, describeStatus, exampleSnapshots, type Lang } from "@kamino/status";
import { Notice, type Plugin } from "obsidian";
import { t } from "../i18n/index.js";
import type { StatusIndicator } from "../ui/StatusIndicator.js";

/** Dev-only: cycles the indicator through the shared example snapshots. */
export function registerStatusGallery(
  plugin: Plugin,
  indicator: StatusIndicator,
  deps: { now: () => number; lang: Lang },
): void {
  let i = 0;
  plugin.addCommand({
    id: "dev-status-gallery",
    name: t(deps.lang).dev.statusGallery,
    callback: () => {
      const now = deps.now();
      const examples = exampleSnapshots(now);
      const ex = examples[i % examples.length]!;
      i += 1;
      new Notice(`${i}/${examples.length} · ${ex.id}`);
      indicator.update(describeStatus(ex.snapshot, DEFAULT_THRESHOLDS, now));
    },
  });
}
```

`apps/plugin/src/main.ts`:

```ts
import { DEFAULT_THRESHOLDS, describeStatus } from "@kamino/status";
import { getIconIds, Platform, Plugin } from "obsidian";
import { registerStatusGallery } from "./dev/status-gallery.js";
import { detectLanguage } from "./i18n/index.js";
import { SettingsTab } from "./settings/SettingsTab.js";
import { INITIAL_SNAPSHOT, StatusIndicator } from "./ui/StatusIndicator.js";

export default class SyncPlugin extends Plugin {
  override onload(): void {
    this.addSettingTab(new SettingsTab(this.app, this));

    const lang = detectLanguage();
    const now = () => Date.now();
    const indicator = new StatusIndicator(this, {
      isMobile: Platform.isMobile,
      lang,
      now,
      available: new Set(getIconIds()),
    });
    indicator.mount();
    // Until the sync engine lands (M1) the honest state is "never synced".
    indicator.update(describeStatus(INITIAL_SNAPSHOT, DEFAULT_THRESHOLDS, now()));

    if (__DEV__) registerStatusGallery(this, indicator, { now, lang });
  }
}
```

- [ ] **Step 5: Il comando galleria non è nella build di produzione**

In `apps/plugin/test/manifest.test.ts`, nel `describe` che legge `dist/main.js`, aggiungere:

```ts
  it("production bundle has no dev gallery", () => {
    expect(read("dist/main.js")).not.toContain("dev-status-gallery");
  });
```

Run: `pnpm --filter @kamino/plugin test`
Expected: PASS. Per vedere il test fallire una volta: impostare temporaneamente `minifySyntax: false` e `define: buildConstants({ dev: true })` in `esbuild.config.mjs`, eseguire, verificare il FAIL, ripristinare.

- [ ] **Step 6: Verifica manuale e commit**

Run: `pnpm --filter @kamino/plugin build:dev`, copiare `apps/plugin/dist/*` in `<vault di prova>/.obsidian/plugins/kamino-sync/`, abilitare il plugin. Atteso: barra di stato "Mai sincronizzato" (desktop); dalla palette comandi "Mostra galleria stati (sviluppo)" cicla i 14 stati; con stati ≥ Attenzione compare una notice. Su telefono (stessa build): niente barra di stato, icona nell'intestazione della nota solo dal livello Attenzione. Annotare in console eventuali avvisi "status icon … not available".

Run: `pnpm --filter @kamino/plugin build && pnpm --filter @kamino/plugin typecheck && pnpm --filter @kamino/plugin lint`

```bash
git add apps/plugin
git commit -m "feat(plugin): add never-silent status indicator and dev status gallery"
```

---

### Task 8: Documentazione, changeset, verifica finale

**Files:**
- Create: `docs/ui/design-system.md`, `.changeset/ui-foundations.md`
- Modify: `docs/02-architecture.md` (riga `ui` della tabella dei componenti del plugin), `docs/renaming.md`, `docs/HANDOVER.md`, `CLAUDE.md` (struttura: `packages/status`), `docs/06-roadmap.md` (nota sulle sotto-fasi della Fase UI)

- [ ] **Step 1: `docs/ui/design-system.md`**

Contenuto (in italiano), sezioni:
1. **Direzione visiva C "Ibrida"**: base neutra con tinta ardesia del brand; ciano solo per azioni e link; primario blu notte (chiaro) / ciano (scuro); titoli di pagina e card in Source Serif 4, resto in Inter.
2. **Token**: le due tabelle di §4.1 della spec con i valori **finali** di `apps/web/src/index.css`; rimando a `src/theme/tokens.test.ts` (≥ 4.5:1).
3. **Stati di sync**: tabella livello → id → icone → significato → colore web → variabile Obsidian; ordine di gravità; regole di `describeStatus` in breve con rimando alla spec §3.3; testi in `packages/status/src/messages.ts`.
4. **Regole d'uso**: mai solo colore (icona + testo); pallino accanto al nome, mai bordo laterale colorato; "in attesa" è grigio e non usa il ciano; nessun font o risorsa da CDN; testi solo via i18n o `@kamino/status`; lessico a tema vietato.
5. **Plugin**: classi `.kamino-status*`, variabili di Obsidian, indicatore (desktop: barra di stato; ribbon; mobile: azione nell'intestazione da Attenzione in su; notice al cambio verso Attenzione+), icone di riserva.
6. **Gallerie**: web `pnpm --filter @kamino/web dev` → `http://localhost:5173/dev/gallery`; plugin `pnpm --filter @kamino/plugin build:dev` + copia nella vault di prova + comando "Mostra galleria stati (sviluppo)".

- [ ] **Step 2: Altri documenti**

- `docs/02-architecture.md`, riga `ui`: sostituire "Indicatore in status bar (desktop) / ribbon + notice (mobile)" con "Indicatore: barra di stato (desktop); icona nel ribbon e notice (tutte le piattaforme); su mobile, azione nell'intestazione della nota attiva dal livello Attenzione in su (vedi `docs/ui/design-system.md`)".
- `docs/renaming.md`, sezione "Punti che non leggono `brand`": aggiungere "**CSS del plugin** (`apps/plugin/src/styles.css`): prefisso delle classi `.kamino-status*` = `PRODUCT_SLUG`; il test `apps/plugin/test/styles.test.ts` fallisce finché non è allineato."
- `CLAUDE.md`, blocco Struttura: aggiungere `packages/status     lessico e logica degli stati di sync (livelli, describeStatus, testi it/en)`.
- `docs/06-roadmap.md`, sezione Fase UI: aggiungere la scomposizione in 4 sotto-fasi con rimando a `docs/superpowers/specs/2026-11-07-ui-fondamenta-design.md`.
- `docs/HANDOVER.md`: tabella "Dove siamo" (Fase UI: sotto-fase 1 completata sul branch `ui-fondamenta`, in attesa di approvazione delle gallerie), decisioni U1–U8, punti aperti "Fase UI" chiusi (flash del tema, modalità sistema, chiavi `theme.*`, `<title>`/`lang`), prossimi passi (approvazione gallerie → PR → sotto-fase 2).

- [ ] **Step 3: Changeset**

`.changeset/ui-foundations.md`:

```md
---
"@kamino/web": minor
"@kamino/plugin": minor
---

Add the design system foundations: shared sync status vocabulary, web design tokens with bundled fonts and flash-free theme, and a never-silent status indicator in the plugin.
```

- [ ] **Step 4: Verifica completa**

Run:

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm release-names:check
```

Expected: tutto verde. Se `format:check` fallisce: `pnpm format`, ricontrollare il diff, includere nel commit.

- [ ] **Step 5: Commit e push**

```bash
git add docs CLAUDE.md .changeset
git commit -m "docs: add design system guide and record UI foundations"
git push -u origin ui-fondamenta
```

Expected: CI verde sul branch. L'approvazione delle gallerie da parte del committente (desktop e telefono) chiude la sotto-fase.
