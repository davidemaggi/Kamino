# Fase UI, sotto-fase 2 — Pannello di stato e risoluzione conflitti: piano di implementazione

> **For agentic workers:** standard del progetto (`CLAUDE.md`): eseguire con superpowers:executing-plans nella sessione corrente, a blocchi con checkpoint; subagent-driven-development solo su richiesta del committente. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** diff/merge vero (`packages/ui-diff` su `@codemirror/merge`), pannello di stato e viste di risoluzione dei conflitti (testo, binari, in blocco) nel plugin, alimentati da interfacce dati con un'implementazione finta.

**Architecture:** `@kamino/ui-diff` avvolge `@codemirror/merge` senza framework; nel plugin `@codemirror/state`/`view` restano esterni (li fornisce Obsidian) e `merge` entra nel bundle. Le viste (`ItemView`, `Modal`) leggono da `SyncStateSource` e agiscono tramite `ConflictActions`; `FakeSyncState` implementa entrambe in memoria finché M1/M3 non portano il motore vero. Un `UiContext` raccoglie dipendenze e navigazione.

**Tech Stack:** TypeScript strict, `@codemirror/merge` 6.x, API DOM di Obsidian, Vitest + jsdom, esbuild.

**Spec:** `docs/superpowers/specs/2026-11-08-ui-stato-conflitti-design.md`.

**Blocchi e checkpoint:** (A) Task 1 → **checkpoint R-3 col committente** in Obsidian; (B) Task 2–3; (C) Task 4–5; (D) Task 6.

## Global Constraints

- TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- Plugin: niente API Node/Electron; solo API di Obsidian, DOM standard, `@kamino/*`; `isDesktopOnly: false`.
- `@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@lezer/*` **mai** nel bundle del plugin (esterni); `@codemirror/merge` sì.
- Nessun testo UI scritto a mano: plugin `src/i18n/{it,en}.json` (stesse chiavi), testi di stato da `@kamino/status`. Lessico a tema vietato nei testi UI.
- Path e nomi di file mai nei log.
- CSS del plugin: solo variabili di Obsidian (nessun colore letterale `#…`, `rgb(`, `hsl(`; ammesso `rgba(var(--color-*-rgb), …)`); prefisso classi `${PRODUCT_SLUG}-` (= `kamino-`), mai bordi laterali colorati.
- Comandi di sviluppo (id `dev-*`) solo con `__DEV__`, assenti dal bundle di produzione.
- Ogni nuovo pacchetto del workspace → `COPY` del suo `package.json` in `docker/Dockerfile`.
- Commit Conventional Commits in inglese; documentazione in italiano.

## Review Focus

1. "Salva l'unione" senza modifiche → `manual` con il testo della tua versione, uguale su desktop (split) e mobile (unified). → Task 1, Task 4.
2. Risoluzione con risposta `stale` → la vista mostra la nuova versione in arrivo e l'avviso; nessuna notice di successo; il conflitto resta nel pannello. → Task 2, Task 4.
3. Conflitto risolto altrove mentre la sua scheda è aperta → "già risolto", nessun crash. → Task 4.
4. "Risolvi tutti…" senza scelta → "Applica" disabilitato, nessuna chiamata. → Task 5.
5. Bundle di produzione: nessun `dev-*`, `require("@codemirror/state")` esterno. → Task 5.

## File Structure

```
packages/ui-diff/                      nuovo
  package.json, tsconfig.json, tsconfig.build.json
  src/summary.ts (+test)               diffSummary
  src/view.ts (+test)                  createDiffView
  src/index.ts
apps/plugin/
  esbuild.config.mjs                   esterni espliciti
  src/i18n/{it,en}.json                testi panel/conflict/bulk/dev
  src/i18n/format.ts (+test)           fmt, formatWhen, formatSize
  src/state/types.ts                   tipi dei dati
  src/state/fake.ts (+test)            FakeSyncState
  src/state/scenarios.ts               scenario conflitti
  src/ui/dom.ts                        helper h()
  src/ui/context.ts                    UiContext
  src/ui/workspace.ts                  tipi vista, openStatusPanel, openConflict
  src/ui/StatusIndicator.ts            onOpenDetails al posto della notice
  src/ui/StatusPanelView.ts (+test)
  src/ui/ConflictView.ts (+test)
  src/ui/BulkResolveModal.ts (+test)
  src/dev/diff-test.ts                 modal R-3
  src/dev/commands.ts                  registra i comandi dev
  src/dev/status-gallery.ts            ora su FakeSyncState
  src/__mocks__/obsidian.ts            ItemView, WorkspaceLeaf, Modal, registerView…
  src/__mocks__/ui-context.ts          makeCtx() per i test
  src/main.ts
  src/styles.css
  test/manifest.test.ts                controlli sul bundle
docker/Dockerfile, docs/…
```

---

### Task 1: `packages/ui-diff` + verifica R-3 su desktop

**Files:**
- Create: `packages/ui-diff/{package.json,tsconfig.json,tsconfig.build.json}`, `packages/ui-diff/src/{summary.ts,view.ts,index.ts}`
- Test: `packages/ui-diff/src/summary.test.ts`, `packages/ui-diff/src/view.test.ts`
- Modify: `apps/plugin/esbuild.config.mjs`, `apps/plugin/package.json`, `apps/plugin/src/i18n/{it,en}.json`, `apps/plugin/src/main.ts`
- Create: `apps/plugin/src/ui/dom.ts`, `apps/plugin/src/dev/diff-test.ts`, `apps/plugin/src/dev/commands.ts`
- Modify: `apps/plugin/src/__mocks__/obsidian.ts` (aggiunta `Modal`), `docker/Dockerfile`, `.changeset/config.json`, `docs/spikes/R-3.md`

**Interfaces:**
- Produces: `diffSummary(mine: string, incoming: string): { changes: number }`; `createDiffView(parent: HTMLElement, opts: DiffViewOptions): DiffViewHandle` con `DiffViewOptions { mine; incoming; layout: "split" | "unified"; editable: boolean; labels: { mine: string; incoming: string }; phrases?: Record<string, string> }` e `DiffViewHandle { getMerged(): string; destroy(): void }`. Classi DOM: wrapper `.diff-view.diff-view--split|unified`.
- Produces (plugin): `h(parent, tag, opts?)` in `src/ui/dom.ts`; `registerDevCommands(plugin, deps)` in `src/dev/commands.ts` (esteso nei task successivi).

- [ ] **Step 1: Scaffold**

`packages/ui-diff/package.json`:

```json
{
  "name": "@kamino/ui-diff",
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

`packages/ui-diff/tsconfig.json`:

```json
{
  "extends": "@kamino/tsconfig/obsidian.json",
  "compilerOptions": { "types": [] },
  "include": ["src"]
}
```

`packages/ui-diff/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true
  },
  "exclude": ["src/**/*.test.ts"]
}
```

Run:

```bash
pnpm --filter @kamino/ui-diff add @codemirror/merge
pnpm --filter @kamino/ui-diff add -D @codemirror/state @codemirror/view jsdom vitest
```

Poi in `packages/ui-diff/package.json` aggiungere `"peerDependencies": { "@codemirror/state": "^6.5.0", "@codemirror/view": "^6.38.0" }`. In `.changeset/config.json` aggiungere `"@kamino/ui-diff"` a `ignore`. In `docker/Dockerfile`, dopo la riga `COPY packages/status/package.json packages/status/`, aggiungere `COPY packages/ui-diff/package.json packages/ui-diff/`.

- [ ] **Step 2: `diffSummary` (test → implementazione)**

`packages/ui-diff/src/summary.test.ts`:

```ts
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
```

Run: `pnpm --filter @kamino/ui-diff test` → FAIL (modulo mancante).

`packages/ui-diff/src/summary.ts`:

```ts
import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";

export interface DiffSummary {
  /** Number of changed line blocks. */
  changes: number;
}

export function diffSummary(mine: string, incoming: string): DiffSummary {
  const chunks = Chunk.build(Text.of(mine.split("\n")), Text.of(incoming.split("\n")));
  return { changes: chunks.length };
}
```

Run: PASS. Se "two distant changes" dà 1 (blocchi uniti dal margine di `Chunk.build`), allungare la distanza nel testo del test (più righe uguali in mezzo), non cambiare l'implementazione.

- [ ] **Step 3: `createDiffView` (test → implementazione)**

`packages/ui-diff/src/view.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createDiffView, type DiffViewOptions } from "./view.js";

const MINE = "- milk\n- bread\n- eggs (6)\n";
const INCOMING = "- milk\n- bread\n- eggs (12)\n- apples\n";
const labels = { mine: "Mine", incoming: "Incoming" };

function mount(opts: Partial<DiffViewOptions>) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const handle = createDiffView(parent, {
    mine: MINE,
    incoming: INCOMING,
    layout: "split",
    editable: false,
    labels,
    ...opts,
  });
  return { parent, handle };
}

const editable = (p: HTMLElement) => p.querySelectorAll('[contenteditable="true"]').length;

afterEach(() => {
  document.body.replaceChildren();
});

describe("createDiffView", () => {
  it("split, read-only: merge view, nothing editable, merged = mine", () => {
    const { parent, handle } = mount({});
    expect(parent.querySelector(".diff-view--split .cm-mergeView")).not.toBeNull();
    expect(editable(parent)).toBe(0);
    expect(handle.getMerged()).toBe(MINE);
  });

  it("split, editable: only mine is editable", () => {
    const { parent, handle } = mount({ editable: true });
    expect(editable(parent)).toBe(1);
    expect(handle.getMerged()).toBe(MINE);
  });

  it("unified: one editor whose document is mine", () => {
    const { parent, handle } = mount({ layout: "unified", editable: true });
    expect(parent.querySelectorAll(".diff-view--unified .cm-editor")).toHaveLength(1);
    expect(editable(parent)).toBe(1);
    expect(handle.getMerged()).toBe(MINE);
  });

  it("unified, read-only: nothing editable", () => {
    const { parent } = mount({ layout: "unified" });
    expect(editable(parent)).toBe(0);
  });

  it("destroy removes everything", () => {
    const { parent, handle } = mount({ layout: "unified" });
    handle.destroy();
    expect(parent.children).toHaveLength(0);
  });
});
```

`packages/ui-diff/src/view.ts`:

```ts
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export interface DiffViewOptions {
  mine: string;
  incoming: string;
  layout: "split" | "unified";
  editable: boolean;
  /** Already translated. */
  labels: { mine: string; incoming: string };
  /** CodeMirror phrases (e.g. merge control labels), already translated. */
  phrases?: Record<string, string>;
}

export interface DiffViewHandle {
  /** Your version, with the edits made in the view. */
  getMerged(): string;
  destroy(): void;
}

const READ_ONLY: Extension[] = [EditorState.readOnly.of(true), EditorView.editable.of(false)];

function common(label: string, phrases: Record<string, string> | undefined): Extension[] {
  return [
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ "aria-label": label }),
    ...(phrases ? [EditorState.phrases.of(phrases)] : []),
  ];
}

/**
 * Diff/merge view on @codemirror/merge. In both layouts the editable document is
 * "mine", so a merge always starts from your version.
 */
export function createDiffView(parent: HTMLElement, opts: DiffViewOptions): DiffViewHandle {
  const wrapper = parent.ownerDocument.createElement("div");
  wrapper.className = `diff-view diff-view--${opts.layout}`;
  parent.append(wrapper);

  if (opts.layout === "split") {
    const view = new MergeView({
      a: {
        doc: opts.mine,
        extensions: [...common(opts.labels.mine, opts.phrases), ...(opts.editable ? [] : READ_ONLY)],
      },
      b: { doc: opts.incoming, extensions: [...common(opts.labels.incoming, opts.phrases), ...READ_ONLY] },
      parent: wrapper,
      highlightChanges: true,
      gutter: true,
      ...(opts.editable ? { revertControls: "b-to-a" as const } : {}),
    });
    return {
      getMerged: () => view.a.state.doc.toString(),
      destroy: () => {
        view.destroy();
        wrapper.remove();
      },
    };
  }

  const view = new EditorView({
    parent: wrapper,
    state: EditorState.create({
      doc: opts.mine,
      extensions: [
        ...common(`${opts.labels.mine} / ${opts.labels.incoming}`, opts.phrases),
        ...(opts.editable ? [] : READ_ONLY),
        unifiedMergeView({
          original: opts.incoming,
          mergeControls: opts.editable,
          highlightChanges: true,
          gutter: true,
        }),
      ],
    }),
  });
  return {
    getMerged: () => view.state.doc.toString(),
    destroy: () => {
      view.destroy();
      wrapper.remove();
    },
  };
}
```

`packages/ui-diff/src/index.ts`:

```ts
export * from "./summary.js";
export * from "./view.js";
```

Run: `pnpm --filter @kamino/ui-diff test` → PASS. Se jsdom manca di API usate da CodeMirror (es. `Range.prototype.getClientRects`, `ResizeObserver`), aggiungere in testa a `view.test.ts` gli stub minimi che servono (es. `Range.prototype.getClientRects = () => [] as unknown as DOMRectList`) e annotarli nel commit.

Run: `pnpm --filter @kamino/ui-diff build && pnpm --filter @kamino/ui-diff typecheck && pnpm --filter @kamino/ui-diff lint`.

- [ ] **Step 4: Esterni espliciti nel plugin**

Run:

```bash
pnpm --filter @kamino/plugin add '@kamino/ui-diff@workspace:*'
pnpm --filter @kamino/plugin add -D @codemirror/state @codemirror/view
```

In `apps/plugin/esbuild.config.mjs` sostituire `external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],` con:

```js
  // Provided by Obsidian at runtime. @codemirror/merge is NOT here: it is bundled.
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
  ],
```

- [ ] **Step 5: Helper DOM, mock `Modal`, testi dev**

`apps/plugin/src/ui/dom.ts`:

```ts
/** Creates a child element with standard DOM (works in popout windows and in tests). */
export function h<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  opts: { cls?: string; text?: string; attrs?: Record<string, string> } = {},
): HTMLElementTagNameMap[K] {
  const el = parent.ownerDocument.createElement(tag);
  if (opts.cls) el.className = opts.cls;
  if (opts.text !== undefined) el.textContent = opts.text;
  for (const [k, v] of Object.entries(opts.attrs ?? {})) el.setAttribute(k, v);
  parent.append(el);
  return el;
}
```

In `apps/plugin/src/__mocks__/obsidian.ts` aggiungere (prima di `PluginSettingTab`):

```ts
export class Modal {
  contentEl: ObsidianElement = makeEl();
  titleEl: ObsidianElement = makeEl();
  isOpen = false;
  constructor(public app: App) {}
  open(): void {
    this.isOpen = true;
    void this.onOpen();
  }
  close(): void {
    this.isOpen = false;
    void this.onClose();
  }
  onOpen(): void | Promise<void> {}
  onClose(): void {}
}
```

Testi: in `apps/plugin/src/i18n/it.json`, oggetto `dev`, aggiungere:

```json
"diffTest": "Apri diff di prova (sviluppo)",
"diffSplit": "Affiancato",
"diffUnified": "Unificato",
"diffEditable": "Modificabile",
"diffMine": "La tua (prova)",
"diffIncoming": "In arrivo (prova)"
```

e in `en.json`:

```json
"diffTest": "Open test diff (development)",
"diffSplit": "Side by side",
"diffUnified": "Unified",
"diffEditable": "Editable",
"diffMine": "Yours (test)",
"diffIncoming": "Incoming (test)"
```

- [ ] **Step 6: Modal di prova e registrazione dei comandi dev**

`apps/plugin/src/dev/diff-test.ts`:

```ts
import { createDiffView, type DiffViewHandle } from "@kamino/ui-diff";
import type { Lang } from "@kamino/status";
import { Modal, type App } from "obsidian";
import { t } from "../i18n/index.js";
import { h } from "../ui/dom.js";

// Sample note contents (test data, not UI text).
const MINE = "# Shopping list\n\n- milk\n- bread\n- eggs (a dozen)\n\nThis line only exists locally.\n";
const INCOMING = "# Shopping list\n\n- milk\n- wholegrain bread\n- eggs\n\nThis line was added on the desktop.\n";

/** Dev-only (R-3 check): a diff in all layout/edit combinations. */
export class DiffTestModal extends Modal {
  private handle: DiffViewHandle | null = null;

  constructor(
    app: App,
    private readonly lang: Lang,
  ) {
    super(app);
  }

  override onOpen(): void {
    const m = t(this.lang).dev;
    this.titleEl.textContent = m.diffTest;
    const bar = h(this.contentEl, "div");
    const host = h(this.contentEl, "div");
    let layout: "split" | "unified" = "split";
    let editable = false;
    const show = () => {
      this.handle?.destroy();
      this.handle = null;
      try {
        this.handle = createDiffView(host, {
          mine: MINE,
          incoming: INCOMING,
          layout,
          editable,
          labels: { mine: m.diffMine, incoming: m.diffIncoming },
        });
      } catch (err) {
        console.error(err);
        host.textContent = String(err);
      }
    };
    h(bar, "button", { text: m.diffSplit }).addEventListener("click", () => {
      layout = "split";
      show();
    });
    h(bar, "button", { text: m.diffUnified }).addEventListener("click", () => {
      layout = "unified";
      show();
    });
    h(bar, "button", { text: m.diffEditable }).addEventListener("click", () => {
      editable = !editable;
      show();
    });
    show();
  }

  override onClose(): void {
    this.handle?.destroy();
    this.handle = null;
    this.contentEl.replaceChildren();
  }
}
```

`apps/plugin/src/dev/commands.ts`:

```ts
import type { Lang } from "@kamino/status";
import type { Plugin } from "obsidian";
import { t } from "../i18n/index.js";
import { DiffTestModal } from "./diff-test.js";

export interface DevDeps {
  lang: Lang;
}

/** Registers development-only commands (called only when __DEV__). */
export function registerDevCommands(plugin: Plugin, deps: DevDeps): void {
  plugin.addCommand({
    id: "dev-diff-test",
    name: t(deps.lang).dev.diffTest,
    callback: () => new DiffTestModal(plugin.app, deps.lang).open(),
  });
}
```

In `apps/plugin/src/main.ts`, accanto alla registrazione della galleria: `if (__DEV__) { registerStatusGallery(this, indicator, { now, lang }); registerDevCommands(this, { lang }); }`.

In `apps/plugin/test/manifest.test.ts`, sostituire l'asserzione `not.toContain("dev-status-gallery")` con `expect(read("dist/main.js")).not.toMatch(/"dev-[a-z-]+"/);`.

Run: `pnpm --filter @kamino/plugin test && pnpm --filter @kamino/plugin typecheck && pnpm --filter @kamino/plugin lint` → verdi.

- [ ] **Step 7: Build, commit, checkpoint R-3**

Run: `pnpm --filter @kamino/plugin build && wc -c apps/plugin/dist/main.js` (annotare: dimensione **prima**, senza `ui-diff` in produzione), poi `pnpm --filter @kamino/plugin build:vault`.

```bash
git add packages/ui-diff apps/plugin docker/Dockerfile .changeset/config.json pnpm-lock.yaml
git commit -m "feat(ui-diff): add CodeMirror merge diff view and R-3 test command"
```

**Checkpoint col committente:** in Obsidian desktop (vault `vault/kamino`, plugin ricaricato), comando "Apri diff di prova (sviluppo)", provare le 4 combinazioni. Controllare: console senza errori (in particolare "Unrecognized extension value" o istanze duplicate di `@codemirror/state`), evidenziazione, scorrimento, modifica della sola "tua", frecce (split) / controlli (unified) in modalità modificabile. Annotare la versione di Obsidian (Impostazioni → Informazioni).

- [ ] **Step 8: Esito in `docs/spikes/R-3.md`**

In testa al file cambiare lo stato in "**Stato: DESKTOP SUPERATO** (2026-11-08, Obsidian <versione> desktop, `@codemirror/merge` <versione>); mobile in attesa" (oppure FALLITO con l'errore) e aggiungere una sezione "Esito desktop (sotto-fase UI 2)" con: versione Obsidian, versione `@codemirror/merge` dal lockfile, variante external, combinazioni provate, errori in console (o "nessuno"). Se fallisce: **fermarsi** e proporre al committente il fallback dell'ADR-0016 prima di continuare.

```bash
git add docs/spikes/R-3.md
git commit -m "docs(spikes): record R-3 desktop result"
```

---

### Task 2: Dati del plugin — tipi, `FakeSyncState`, scenario, formattazione

**Files:**
- Create: `apps/plugin/src/state/types.ts`, `src/state/fake.ts`, `src/state/scenarios.ts`, `src/i18n/format.ts`
- Test: `apps/plugin/src/state/fake.test.ts`, `apps/plugin/src/i18n/format.test.ts`
- Modify: `apps/plugin/src/i18n/{it,en}.json`

**Interfaces:**
- Consumes: `SyncSnapshot` da `@kamino/status`; `INITIAL_SNAPSHOT` da `src/ui/StatusIndicator.ts`.
- Produces: tutti i tipi di spec §4 (`ConflictSummary`, `ConflictDetail`, `BinaryInfo`, `PendingChange`, `DeferredFile`, `DeviceInfo`, `Resolution`, `ResolveOutcome` con `"stale" | "gone"`, `BulkStrategy`, `SyncStateSource`, `ConflictActions`); `class FakeSyncState implements SyncStateSource, ConflictActions` con in più `setSnapshot(s)`, `loadScenario(sc: Scenario)`, `nextResolveStale()`; `interface Scenario { snapshot; conflicts: ConflictDetail[]; pending: PendingChange[]; deferred: DeferredFile[] }`; `conflictScenario(now: number): Scenario`; `fmt(template, params)`, `formatWhen(at, now, lang, timeZone?)`, `formatSize(bytes, lang)`, `basename(path)`.

- [ ] **Step 1: Tipi**

`apps/plugin/src/state/types.ts`:

```ts
import type { SyncSnapshot } from "@kamino/status";

export type ConflictKind = "concurrent_edit" | "both_created";

export interface VersionInfo {
  device: string;
  /** epoch ms */
  at: number;
}

export interface ConflictSummary {
  id: string;
  path: string;
  kind: ConflictKind;
  binary: boolean;
  mine: VersionInfo;
  incoming: VersionInfo;
}

export interface BinaryInfo {
  size: number;
  mime: string;
  /** Only for images. */
  previewUrl: string | null;
}

export type ConflictDetail =
  | (ConflictSummary & { binary: false; mineText: string; incomingText: string })
  | (ConflictSummary & { binary: true; mineFile: BinaryInfo; incomingFile: BinaryInfo });

export interface PendingChange {
  path: string;
  op: "create" | "modify" | "delete" | "rename";
  since: number;
}

export interface DeferredFile {
  path: string;
  size: number;
  direction: "upload" | "download";
}

export interface DeviceInfo {
  name: string;
  mode: "live" | "periodic" | "manual";
  /** Host only. */
  server: string;
}

export type Resolution =
  | { type: "keep_mine" }
  | { type: "keep_incoming" }
  | { type: "keep_both" }
  | { type: "manual"; text: string };

/** gone = already resolved elsewhere. */
export type ResolveOutcome = { ok: true } | { ok: false; reason: "stale" | "gone" };

export type BulkStrategy = "keep_mine" | "keep_incoming" | "keep_both";

export interface SyncStateSource {
  snapshot(): SyncSnapshot;
  conflicts(): ConflictSummary[];
  conflict(id: string): Promise<ConflictDetail | null>;
  pending(): PendingChange[];
  deferred(): DeferredFile[];
  device(): DeviceInfo;
  /** Returns the function that stops listening. */
  onChange(cb: () => void): () => void;
}

export interface ConflictActions {
  resolve(id: string, resolution: Resolution): Promise<ResolveOutcome>;
  resolveAll(strategy: BulkStrategy): Promise<{ resolved: number }>;
  syncNow(): Promise<void>;
  uploadNow(path: string): Promise<void>;
}
```

- [ ] **Step 2: Test di `FakeSyncState` (falliscono)**

`apps/plugin/src/state/fake.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { FakeSyncState } from "./fake.js";
import { conflictScenario } from "./scenarios.js";

const NOW = Date.UTC(2026, 10, 8, 10, 0);
const device = { name: "Laptop", mode: "live" as const, server: "sync.example" };

function loaded() {
  const s = new FakeSyncState(device, () => NOW);
  s.loadScenario(conflictScenario(NOW));
  return s;
}

describe("FakeSyncState", () => {
  it("starts empty and never synced", () => {
    const s = new FakeSyncState(device, () => NOW);
    expect(s.conflicts()).toEqual([]);
    expect(s.snapshot().lastConfirmedAt).toBeNull();
    expect(s.device()).toEqual(device);
  });

  it("loads the conflict scenario consistently", async () => {
    const s = loaded();
    const list = s.conflicts();
    expect(list).toHaveLength(3);
    expect(s.snapshot().conflicts).toBe(3);
    expect(list.some((c) => c.binary)).toBe(true);
    expect(await s.conflict(list[0]!.id)).not.toBeNull();
    expect(s.pending().length).toBeGreaterThan(0);
    expect(s.deferred().length).toBeGreaterThan(0);
  });

  it.each(["keep_mine", "keep_incoming", "keep_both"] as const)("resolve %s closes the conflict and notifies", async (type) => {
    const s = loaded();
    const cb = vi.fn();
    s.onChange(cb);
    const id = s.conflicts()[0]!.id;
    expect(await s.resolve(id, { type })).toEqual({ ok: true });
    expect(s.conflicts().map((c) => c.id)).not.toContain(id);
    expect(s.snapshot().conflicts).toBe(2);
    expect(cb).toHaveBeenCalled();
  });

  it("manual resolution closes the conflict", async () => {
    const s = loaded();
    const id = s.conflicts()[0]!.id;
    expect(await s.resolve(id, { type: "manual", text: "merged" })).toEqual({ ok: true });
    expect(await s.conflict(id)).toBeNull();
  });

  it("stale keeps the conflict open and changes the incoming version", async () => {
    const s = loaded();
    const id = s.conflicts().find((c) => !c.binary)!.id;
    const before = await s.conflict(id);
    s.nextResolveStale();
    expect(await s.resolve(id, { type: "keep_mine" })).toEqual({ ok: false, reason: "stale" });
    const after = await s.conflict(id);
    expect(after).not.toBeNull();
    expect(after!.binary).toBe(false);
    if (before && !before.binary && after && !after.binary) {
      expect(after.incomingText).not.toBe(before.incomingText);
    }
    expect(s.snapshot().conflicts).toBe(3);
  });

  it("resolving an unknown conflict reports gone", async () => {
    expect(await loaded().resolve("nope", { type: "keep_mine" })).toEqual({ ok: false, reason: "gone" });
  });

  it("resolveAll resolves everything and returns the count", async () => {
    const s = loaded();
    expect(await s.resolveAll("keep_both")).toEqual({ resolved: 3 });
    expect(s.conflicts()).toEqual([]);
    expect(s.snapshot().conflicts).toBe(0);
  });

  it("syncNow empties the queue and confirms when the server is reachable", async () => {
    const s = loaded();
    await s.syncNow();
    expect(s.pending()).toEqual([]);
    expect(s.snapshot().queued).toBe(0);
    expect(s.snapshot().lastConfirmedAt).toBe(NOW);
  });

  it("uploadNow removes the deferred file", async () => {
    const s = loaded();
    const path = s.deferred()[0]!.path;
    await s.uploadNow(path);
    expect(s.deferred().map((d) => d.path)).not.toContain(path);
  });

  it("onChange unsubscribe stops notifications", async () => {
    const s = loaded();
    const cb = vi.fn();
    const off = s.onChange(cb);
    off();
    await s.resolveAll("keep_mine");
    expect(cb).not.toHaveBeenCalled();
  });
});
```

Run: `pnpm --filter @kamino/plugin test -- fake` → FAIL (moduli mancanti).

- [ ] **Step 3: `FakeSyncState` e scenario**

`apps/plugin/src/state/fake.ts`:

```ts
import type { SyncSnapshot } from "@kamino/status";
import { INITIAL_SNAPSHOT } from "../ui/StatusIndicator.js";
import type {
  BulkStrategy,
  ConflictActions,
  ConflictDetail,
  ConflictSummary,
  DeferredFile,
  DeviceInfo,
  PendingChange,
  Resolution,
  ResolveOutcome,
  SyncStateSource,
} from "./types.js";

export interface Scenario {
  snapshot: SyncSnapshot;
  conflicts: ConflictDetail[];
  pending: PendingChange[];
  deferred: DeferredFile[];
}

/**
 * In-memory stand-in for the sync engine (until M1/M3). Actions really change the
 * state, so views and the indicator react as they will with real data.
 */
export class FakeSyncState implements SyncStateSource, ConflictActions {
  private snap: SyncSnapshot = { ...INITIAL_SNAPSHOT };
  private items: ConflictDetail[] = [];
  private pendingList: PendingChange[] = [];
  private deferredList: DeferredFile[] = [];
  private readonly listeners = new Set<() => void>();
  private staleNext = false;

  constructor(
    private readonly deviceInfo: DeviceInfo,
    private readonly clock: () => number,
  ) {}

  snapshot(): SyncSnapshot {
    return { ...this.snap };
  }
  conflicts(): ConflictSummary[] {
    return this.items.map(({ id, path, kind, binary, mine, incoming }) => ({ id, path, kind, binary, mine, incoming }));
  }
  conflict(id: string): Promise<ConflictDetail | null> {
    return Promise.resolve(this.items.find((c) => c.id === id) ?? null);
  }
  pending(): PendingChange[] {
    return [...this.pendingList];
  }
  deferred(): DeferredFile[] {
    return [...this.deferredList];
  }
  device(): DeviceInfo {
    return this.deviceInfo;
  }
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  setSnapshot(s: SyncSnapshot): void {
    this.snap = { ...s };
    this.emit();
  }
  loadScenario(sc: Scenario): void {
    this.snap = { ...sc.snapshot };
    this.items = [...sc.conflicts];
    this.pendingList = [...sc.pending];
    this.deferredList = [...sc.deferred];
    this.emit();
  }
  /** Test/dev helper: the next resolve() answers "stale" and a newer version arrives. */
  nextResolveStale(): void {
    this.staleNext = true;
  }

  resolve(id: string, resolution: Resolution): Promise<ResolveOutcome> {
    void resolution;
    const index = this.items.findIndex((c) => c.id === id);
    const item = this.items[index];
    if (!item) return Promise.resolve({ ok: false, reason: "gone" });
    if (this.staleNext) {
      this.staleNext = false;
      const incoming = { ...item.incoming, at: this.clock() };
      this.items[index] = item.binary
        ? { ...item, incoming }
        : { ...item, incoming, incomingText: `${item.incomingText}- newer line\n` };
      this.emit();
      return Promise.resolve({ ok: false, reason: "stale" });
    }
    this.items.splice(index, 1);
    this.snap = { ...this.snap, conflicts: Math.max(0, this.snap.conflicts - 1) };
    this.emit();
    return Promise.resolve({ ok: true });
  }

  resolveAll(strategy: BulkStrategy): Promise<{ resolved: number }> {
    void strategy;
    const resolved = this.items.length;
    this.items = [];
    this.snap = { ...this.snap, conflicts: 0 };
    this.emit();
    return Promise.resolve({ resolved });
  }

  syncNow(): Promise<void> {
    if (this.snap.unreachableSince === null) {
      this.pendingList = [];
      this.snap = { ...this.snap, queued: 0, oldestQueuedAt: null, lastConfirmedAt: this.clock() };
    }
    this.emit();
    return Promise.resolve();
  }

  uploadNow(path: string): Promise<void> {
    this.deferredList = this.deferredList.filter((d) => d.path !== path);
    this.emit();
    return Promise.resolve();
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb();
  }
}
```

`apps/plugin/src/state/scenarios.ts`:

```ts
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
  return { size: 48_213, mime: "image/svg+xml", previewUrl: `data:image/svg+xml,${encodeURIComponent(svg)}` };
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
```

Run: `pnpm --filter @kamino/plugin test -- fake` → PASS.

- [ ] **Step 4: Formattazione (test → implementazione)**

`apps/plugin/src/i18n/format.test.ts`:

```ts
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
```

`apps/plugin/src/i18n/format.ts`:

```ts
import type { Lang } from "@kamino/status";

/** Replaces {name} placeholders; unknown placeholders are left as they are. */
export function fmt(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

/** "10:45" today, "7 nov, 10:45" on other days. `timeZone` is for tests. */
export function formatWhen(at: number, now: number, lang: Lang, timeZone?: string): string {
  const tz = timeZone ? { timeZone } : {};
  const day = (d: number) =>
    new Intl.DateTimeFormat("en-CA", { ...tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat(lang, { ...tz, hour: "2-digit", minute: "2-digit" }).format(at);
  if (day(at) === day(now)) return time;
  const date = new Intl.DateTimeFormat(lang, { ...tz, day: "numeric", month: "short" }).format(at);
  return `${date}, ${time}`;
}

export function formatSize(bytes: number, lang: Lang): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const n = new Intl.NumberFormat(lang, { maximumFractionDigits: i === 0 ? 0 : 1 }).format(value);
  return `${n} ${units[i]}`;
}

export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}
```

Run: `pnpm --filter @kamino/plugin test -- format` → PASS. Se l'ICU di Node formatta il mese diversamente ("7 nov" vs "7 nov."), allineare l'atteso del test alla forma di `Intl` (la funzione non va adattata a mano).

- [ ] **Step 5: Testi UI**

Aggiungere a `apps/plugin/src/i18n/it.json` (oggetti di primo livello):

```json
"panel": {
  "title": "Stato sync",
  "openCommand": "Apri stato sync",
  "syncNow": "Sincronizza ora",
  "conflicts": "Conflitti · {count}",
  "conflictFrom": "{device} · {when}",
  "resolveAll": "Risolvi tutti…",
  "pending": "Non ancora sul server · {count}",
  "pendingMeta": "{op} · {age}",
  "showAll": "Mostra tutte ({count})",
  "deferred": "In attesa di Wi-Fi · {count}",
  "uploadNow": "Carica ora",
  "downloadNow": "Scarica ora",
  "device": "Questo dispositivo",
  "deviceName": "Nome",
  "mode": "Modalità",
  "server": "Server",
  "notLinked": "Non ancora collegato",
  "noServer": "Nessun server",
  "modes": { "live": "Live", "periodic": "Periodica", "manual": "Manuale" },
  "ops": { "create": "nuova", "modify": "modificata", "delete": "eliminata", "rename": "rinominata" }
},
"conflict": {
  "viewTitle": "Conflitto: {name}",
  "viewTitleEmpty": "Conflitto",
  "summaryEdit": "Modificata qui ({mine}) e su {device} ({incoming}). Entrambe le versioni sono salvate.",
  "summaryCreated": "Due file con lo stesso nome creati qui ({mine}) e su {device} ({incoming}). Entrambi sono salvati.",
  "changes": "Differenze: {count}",
  "labelMine": "La tua versione · questo dispositivo",
  "labelIncoming": "In arrivo · {device}, {when}",
  "tabMine": "La tua",
  "tabDiff": "Differenze",
  "tabIncoming": "In arrivo",
  "keepMine": "Tieni la mia",
  "keepIncoming": "Tieni quella in arrivo",
  "keepBoth": "Tieni entrambe",
  "edit": "Modifica e unisci…",
  "saveMerge": "Salva l'unione",
  "cancel": "Annulla",
  "chunkKeepMine": "Tieni la mia",
  "chunkTakeIncoming": "Prendi quella in arrivo",
  "doneMine": "Hai tenuto la tua versione. Quella di {device} resta nello storico.",
  "doneIncoming": "Hai tenuto la versione di {device}. La tua resta nello storico.",
  "doneBoth": "Hai tenuto entrambe: la tua è salvata come file affiancato.",
  "doneMerge": "Unione salvata.",
  "stale": "È arrivata una versione più recente: controlla di nuovo prima di scegliere.",
  "gone": "Questo conflitto è già stato risolto.",
  "close": "Chiudi",
  "fileDevice": "Dispositivo",
  "fileDate": "Data",
  "fileSize": "Dimensione",
  "fileType": "Tipo",
  "noPreview": "Anteprima non disponibile"
},
"bulk": {
  "title": "Risolvi tutti i conflitti",
  "keepMine": "Tieni tutte le mie",
  "keepIncoming": "Tieni tutte quelle in arrivo",
  "keepBoth": "Tieni entrambe per tutti",
  "appliesTo": "Si applica a {count} file",
  "apply": "Applica",
  "cancel": "Annulla",
  "done": "Conflitti risolti: {count}"
}
```

e a `en.json`:

```json
"panel": {
  "title": "Sync status",
  "openCommand": "Open sync status",
  "syncNow": "Sync now",
  "conflicts": "Conflicts · {count}",
  "conflictFrom": "{device} · {when}",
  "resolveAll": "Resolve all…",
  "pending": "Not on the server yet · {count}",
  "pendingMeta": "{op} · {age}",
  "showAll": "Show all ({count})",
  "deferred": "Waiting for Wi-Fi · {count}",
  "uploadNow": "Upload now",
  "downloadNow": "Download now",
  "device": "This device",
  "deviceName": "Name",
  "mode": "Mode",
  "server": "Server",
  "notLinked": "Not linked yet",
  "noServer": "No server",
  "modes": { "live": "Live", "periodic": "Periodic", "manual": "Manual" },
  "ops": { "create": "new", "modify": "modified", "delete": "deleted", "rename": "renamed" }
},
"conflict": {
  "viewTitle": "Conflict: {name}",
  "viewTitleEmpty": "Conflict",
  "summaryEdit": "Edited here ({mine}) and on {device} ({incoming}). Both versions are saved.",
  "summaryCreated": "Two files with the same name created here ({mine}) and on {device} ({incoming}). Both are saved.",
  "changes": "Differences: {count}",
  "labelMine": "Your version · this device",
  "labelIncoming": "Incoming · {device}, {when}",
  "tabMine": "Yours",
  "tabDiff": "Differences",
  "tabIncoming": "Incoming",
  "keepMine": "Keep mine",
  "keepIncoming": "Keep incoming",
  "keepBoth": "Keep both",
  "edit": "Edit and merge…",
  "saveMerge": "Save merge",
  "cancel": "Cancel",
  "chunkKeepMine": "Keep mine",
  "chunkTakeIncoming": "Take incoming",
  "doneMine": "You kept your version. The one from {device} stays in the history.",
  "doneIncoming": "You kept the version from {device}. Yours stays in the history.",
  "doneBoth": "You kept both: yours is saved as a separate file.",
  "doneMerge": "Merge saved.",
  "stale": "A newer version arrived: check again before choosing.",
  "gone": "This conflict has already been resolved.",
  "close": "Close",
  "fileDevice": "Device",
  "fileDate": "Date",
  "fileSize": "Size",
  "fileType": "Type",
  "noPreview": "No preview available"
},
"bulk": {
  "title": "Resolve all conflicts",
  "keepMine": "Keep all mine",
  "keepIncoming": "Keep all incoming",
  "keepBoth": "Keep both for all",
  "appliesTo": "Applies to {count} files",
  "apply": "Apply",
  "cancel": "Cancel",
  "done": "Conflicts resolved: {count}"
}
```

In `dev` (entrambi i file): `"conflictScenario": "Carica scenario conflitti (sviluppo)"` / `"Load conflict scenario (development)"`.

Run: `pnpm --filter @kamino/plugin test` (parità chiavi e lessico) → PASS.

- [ ] **Step 6: Verifica e commit**

Run: `pnpm --filter @kamino/plugin typecheck && pnpm --filter @kamino/plugin lint`

```bash
git add apps/plugin
git commit -m "feat(plugin): add sync state interfaces, fake state and formatting helpers"
```

---

### Task 3: Pannello di stato e collegamento nel plugin

**Files:**
- Modify: `apps/plugin/src/__mocks__/obsidian.ts` (ItemView, WorkspaceLeaf, registerView, getRightLeaf, getLeaf, getLeavesOfType, revealLeaf)
- Create: `apps/plugin/src/__mocks__/ui-context.ts`, `src/ui/context.ts`, `src/ui/workspace.ts`, `src/ui/StatusPanelView.ts`
- Modify: `src/ui/StatusIndicator.ts` (+ test), `src/dev/status-gallery.ts`, `src/dev/commands.ts`, `src/main.ts`, `src/styles.css`
- Test: `apps/plugin/src/ui/StatusPanelView.test.ts`

**Interfaces:**
- Consumes: Task 2 (tipi, `FakeSyncState`, `fmt`, `formatWhen`, `formatSize`, `basename`), `describeStatus`, `formatStatusMessage`, `formatLastConfirmed`, `formatAge` da `@kamino/status`; `renderStatusIndicator` (sotto-fase 1).
- Produces:
  - `interface UiContext { source: SyncStateSource; actions: ConflictActions; lang: Lang; isMobile: boolean; now: () => number; available: ReadonlySet<string> | null; openStatusPanel(): Promise<void>; openConflict(id: string): Promise<void>; openBulkResolve(): void }`
  - `STATUS_VIEW`, `CONFLICT_VIEW` (stringhe), `openStatusPanel(app: App): Promise<void>`, `openConflict(app: App, id: string): Promise<void>` in `src/ui/workspace.ts`
  - `class StatusPanelView extends ItemView` (costruttore `(leaf, ctx: UiContext)`)
  - `IndicatorDeps` con in più `onOpenDetails: () => void`
  - `makeCtx(overrides?: Partial<UiContext>): { ctx: UiContext; state: FakeSyncState; plugin: Plugin }` (mock)

- [ ] **Step 1: Mock di workspace e viste**

In `apps/plugin/src/__mocks__/obsidian.ts`:

1. Sostituire `class Workspace` con:

```ts
type ViewCreator = (leaf: WorkspaceLeaf) => ItemView;

export class Workspace {
  private handlers = new Map<string, Handler[]>();
  activeView: MarkdownView | null = null;
  creators = new Map<string, ViewCreator>();
  leaves: WorkspaceLeaf[] = [];
  revealed: WorkspaceLeaf[] = [];
  constructor(public app: App) {}
  on(name: string, cb: Handler): { name: string } {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), cb]);
    return { name };
  }
  trigger(name: string, ...args: unknown[]): void {
    for (const h of this.handlers.get(name) ?? []) h(...args);
  }
  getActiveViewOfType<T>(type: unknown): T | null {
    void type;
    return this.activeView as T | null;
  }
  getRightLeaf(split: boolean): WorkspaceLeaf {
    void split;
    return new WorkspaceLeaf(this.app);
  }
  getLeaf(newLeaf?: unknown): WorkspaceLeaf {
    void newLeaf;
    return new WorkspaceLeaf(this.app);
  }
  getLeavesOfType(type: string): WorkspaceLeaf[] {
    return this.leaves.filter((l) => l.view?.getViewType() === type);
  }
  revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
    this.revealed.push(leaf);
    return Promise.resolve();
  }
}

export class WorkspaceLeaf {
  view: ItemView | null = null;
  constructor(public app: App) {}
  async setViewState(state: { type: string; state?: unknown; active?: boolean }): Promise<void> {
    const creator = this.app.workspace.creators.get(state.type);
    if (!creator) throw new Error(`no view registered: ${state.type}`);
    if (this.view) await this.view.close();
    this.view = creator(this);
    if (!this.app.workspace.leaves.includes(this)) this.app.workspace.leaves.push(this);
    await this.view.open();
    await this.view.setState(state.state ?? {}, { history: false });
  }
  detach(): void {
    this.app.workspace.leaves = this.app.workspace.leaves.filter((l) => l !== this);
    const view = this.view;
    this.view = null;
    void view?.close();
  }
}

export class ItemView {
  app: App;
  containerEl: ObsidianElement = makeEl();
  contentEl: ObsidianElement = makeEl();
  constructor(public leaf: WorkspaceLeaf) {
    this.app = leaf.app;
    this.containerEl.append(this.contentEl);
  }
  getViewType(): string {
    return "";
  }
  getDisplayText(): string {
    return "";
  }
  getIcon(): string {
    return "";
  }
  getState(): Record<string, unknown> {
    return {};
  }
  setState(state: unknown, result: unknown): Promise<void> {
    void state;
    void result;
    return Promise.resolve();
  }
  protected onOpen(): Promise<void> {
    return Promise.resolve();
  }
  protected onClose(): Promise<void> {
    return Promise.resolve();
  }
  /** Test helper (Obsidian calls onOpen itself). */
  open(): Promise<void> {
    return this.onOpen();
  }
  /** Test helper (Obsidian calls onClose itself). */
  close(): Promise<void> {
    return this.onClose();
  }
}
```

2. In `class App`: `workspace: Workspace = new Workspace(this);`
3. In `class Plugin`: aggiungere

```ts
  registerView(type: string, creator: ViewCreator): void {
    this.app.workspace.creators.set(type, creator);
  }
```

`apps/plugin/src/__mocks__/ui-context.ts`:

```ts
import { vi } from "vitest";
import { FakeSyncState } from "../state/fake.js";
import type { UiContext } from "../ui/context.js";
import { Plugin } from "./obsidian.js";

export const TEST_NOW = Date.UTC(2026, 10, 8, 10, 0);

/** UiContext over a FakeSyncState, with spies for navigation. */
export function makeCtx(overrides: Partial<UiContext> = {}) {
  const plugin = new Plugin();
  const state = new FakeSyncState({ name: "Laptop", mode: "live", server: "sync.example" }, () => TEST_NOW);
  const ctx: UiContext = {
    source: state,
    actions: state,
    lang: "it",
    isMobile: false,
    now: () => TEST_NOW,
    available: null,
    openStatusPanel: vi.fn(() => Promise.resolve()),
    openConflict: vi.fn(() => Promise.resolve()),
    openBulkResolve: vi.fn(),
    ...overrides,
  };
  return { ctx, state, plugin };
}
```

- [ ] **Step 2: Contesto e navigazione**

`apps/plugin/src/ui/context.ts`:

```ts
import type { Lang } from "@kamino/status";
import type { ConflictActions, SyncStateSource } from "../state/types.js";

/** Everything the views need: data, actions, environment and navigation. */
export interface UiContext {
  source: SyncStateSource;
  actions: ConflictActions;
  lang: Lang;
  isMobile: boolean;
  now: () => number;
  available: ReadonlySet<string> | null;
  openStatusPanel(): Promise<void>;
  openConflict(id: string): Promise<void>;
  openBulkResolve(): void;
}
```

`apps/plugin/src/ui/workspace.ts`:

```ts
import { PRODUCT_SLUG } from "@kamino/brand";
import type { App } from "obsidian";

export const STATUS_VIEW = `${PRODUCT_SLUG}-status-panel`;
export const CONFLICT_VIEW = `${PRODUCT_SLUG}-conflict`;

/** Opens (or reveals) the status panel in the right sidebar (the drawer on mobile). */
export async function openStatusPanel(app: App): Promise<void> {
  const existing = app.workspace.getLeavesOfType(STATUS_VIEW)[0];
  const leaf = existing ?? app.workspace.getRightLeaf(false);
  if (!leaf) return;
  if (!existing) await leaf.setViewState({ type: STATUS_VIEW, active: true });
  await app.workspace.revealLeaf(leaf);
}

/** Opens (or reveals) the resolution tab of one conflict. */
export async function openConflict(app: App, id: string): Promise<void> {
  const existing = app.workspace
    .getLeavesOfType(CONFLICT_VIEW)
    .find((l) => l.view.getState()["conflictId"] === id);
  const leaf = existing ?? app.workspace.getLeaf("tab");
  if (!existing) await leaf.setViewState({ type: CONFLICT_VIEW, active: true, state: { conflictId: id } });
  await app.workspace.revealLeaf(leaf);
}
```

(Se il typecheck rifiuta `l.view.getState()` per il tipo `View`, usare `(l.view as { getState(): Record<string, unknown> }).getState()`.)

- [ ] **Step 3: Test del pannello (falliscono)**

`apps/plugin/src/ui/StatusPanelView.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeCtx, TEST_NOW } from "../__mocks__/ui-context.js";
import { WorkspaceLeaf } from "../__mocks__/obsidian.js";
import { conflictScenario } from "../state/scenarios.js";
import type { UiContext } from "./context.js";
import { StatusPanelView } from "./StatusPanelView.js";

async function open(ctx: UiContext, plugin: { app: unknown }) {
  const view = new StatusPanelView(new WorkspaceLeaf(plugin.app as never) as never, ctx);
  await (view as unknown as { open(): Promise<void> }).open();
  const root = (view as unknown as { contentEl: HTMLElement }).contentEl;
  return { view, root };
}
const headings = (root: HTMLElement) => [...root.querySelectorAll("h3")].map((x) => x.textContent);
const buttons = (root: HTMLElement) => [...root.querySelectorAll("button")];

describe("StatusPanelView", () => {
  it("never synced: summary and device only", async () => {
    const { ctx, plugin } = makeCtx();
    const { root } = await open(ctx, plugin);
    expect(root.textContent).toContain("Mai sincronizzato");
    expect(headings(root)).toEqual(["Questo dispositivo"]);
  });

  it("safe: 'Tutto al sicuro', no other sections", async () => {
    const { ctx, state, plugin } = makeCtx();
    state.setSnapshot({ ...state.snapshot(), lastConfirmedAt: TEST_NOW - 60_000 });
    const { root } = await open(ctx, plugin);
    expect(root.textContent).toContain("Tutto al sicuro");
    expect(headings(root)).toEqual(["Questo dispositivo"]);
  });

  it("scenario: all sections in order", async () => {
    const { ctx, state, plugin } = makeCtx();
    state.loadScenario(conflictScenario(TEST_NOW));
    const { root } = await open(ctx, plugin);
    expect(headings(root)).toEqual([
      "Conflitti · 3",
      "Non ancora sul server · 3",
      "In attesa di Wi-Fi · 1",
      "Questo dispositivo",
    ]);
  });

  it("conflict rows open the conflict; 'Risolvi tutti…' opens the bulk modal", async () => {
    const { ctx, state, plugin } = makeCtx();
    state.loadScenario(conflictScenario(TEST_NOW));
    const { root } = await open(ctx, plugin);
    buttons(root).find((b) => b.textContent?.includes("Spesa.md"))!.click();
    expect(ctx.openConflict).toHaveBeenCalledWith("c-shopping");
    buttons(root).find((b) => b.textContent === "Risolvi tutti…")!.click();
    expect(ctx.openBulkResolve).toHaveBeenCalled();
  });

  it("no 'Risolvi tutti…' with a single conflict", async () => {
    const { ctx, state, plugin } = makeCtx();
    const sc = conflictScenario(TEST_NOW);
    state.loadScenario({ ...sc, conflicts: sc.conflicts.slice(0, 1) });
    const { root } = await open(ctx, plugin);
    expect(buttons(root).some((b) => b.textContent === "Risolvi tutti…")).toBe(false);
  });

  it("pending list shows 5 rows then 'Mostra tutte'", async () => {
    const { ctx, state, plugin } = makeCtx();
    const sc = conflictScenario(TEST_NOW);
    const pending = Array.from({ length: 8 }, (_, i) => ({ path: `n${i}.md`, op: "modify" as const, since: TEST_NOW - 60_000 }));
    state.loadScenario({ ...sc, pending });
    const { root } = await open(ctx, plugin);
    expect(root.textContent).not.toContain("n7.md");
    buttons(root).find((b) => b.textContent === "Mostra tutte (8)")!.click();
    expect(root.textContent).toContain("n7.md");
  });

  it("sync now and upload now call the actions; panel re-renders on change", async () => {
    const { ctx, state, plugin } = makeCtx();
    state.loadScenario(conflictScenario(TEST_NOW));
    const { root } = await open(ctx, plugin);
    buttons(root).find((b) => b.textContent === "Carica ora")!.click();
    await Promise.resolve();
    expect(headings(root)).not.toContain("In attesa di Wi-Fi · 1");
    buttons(root).find((b) => b.textContent === "Sincronizza ora")!.click();
    await Promise.resolve();
    expect(headings(root)).not.toContain("Non ancora sul server · 3");
  });

  it("stops listening on close", async () => {
    const { ctx, state, plugin } = makeCtx();
    const { view, root } = await open(ctx, plugin);
    await (view as unknown as { close(): Promise<void> }).close();
    const before = root.innerHTML;
    state.loadScenario(conflictScenario(TEST_NOW));
    expect(root.innerHTML).toBe(before);
  });
});
```

Run: `pnpm --filter @kamino/plugin test -- StatusPanelView` → FAIL (modulo mancante).

- [ ] **Step 4: `StatusPanelView`**

`apps/plugin/src/ui/StatusPanelView.ts`:

```ts
import {
  DEFAULT_THRESHOLDS,
  describeStatus,
  formatAge,
  formatLastConfirmed,
  formatStatusMessage,
} from "@kamino/status";
import { ItemView, type WorkspaceLeaf } from "obsidian";
import { fmt, formatSize, formatWhen } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import type { UiContext } from "./context.js";
import { h } from "./dom.js";
import { renderStatusIndicator, STATUS_CLASS } from "./render-status.js";
import { STATUS_VIEW } from "./workspace.js";

const P = `${STATUS_CLASS}-panel`;
const PENDING_PREVIEW = 5;

/** Sync status panel: summary + non-empty sections (spec §5.1). */
export class StatusPanelView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private showAllPending = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly ctx: UiContext,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return STATUS_VIEW;
  }
  override getDisplayText(): string {
    return t(this.ctx.lang).panel.title;
  }
  override getIcon(): string {
    return "shield-check";
  }

  protected override onOpen(): Promise<void> {
    this.unsubscribe = this.ctx.source.onChange(() => this.render());
    this.render();
    return Promise.resolve();
  }

  protected override onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    return Promise.resolve();
  }

  private render(): void {
    const { ctx } = this;
    const m = t(ctx.lang).panel;
    const now = ctx.now();
    const root = this.contentEl;
    root.replaceChildren();
    root.classList.add(P);

    const status = describeStatus(ctx.source.snapshot(), DEFAULT_THRESHOLDS, now);
    const summary = h(root, "section", { cls: `${P}__summary`, attrs: { "aria-live": "polite" } });
    renderStatusIndicator(h(summary, "div", { cls: `${P}__headline` }), status, {
      lang: ctx.lang,
      now,
      available: ctx.available,
    });
    for (const s of status.secondary) h(summary, "p", { cls: `${P}__muted`, text: formatStatusMessage(s, ctx.lang) });
    h(summary, "p", { cls: `${P}__muted`, text: formatLastConfirmed(status.lastConfirmedAt, now, ctx.lang) });
    h(summary, "button", { cls: "mod-cta", text: m.syncNow }).addEventListener("click", () => {
      void ctx.actions.syncNow();
    });

    const conflicts = ctx.source.conflicts();
    if (conflicts.length > 0) {
      const sec = this.section(root, fmt(m.conflicts, { count: conflicts.length }));
      if (conflicts.length >= 2) {
        h(sec.header, "button", { text: m.resolveAll }).addEventListener("click", () => ctx.openBulkResolve());
      }
      for (const c of conflicts) {
        const meta = fmt(m.conflictFrom, { device: c.incoming.device, when: formatWhen(c.incoming.at, now, ctx.lang) });
        this.row(sec.list, c.path, meta).addEventListener("click", () => {
          void ctx.openConflict(c.id);
        });
      }
    }

    const pending = ctx.source.pending();
    if (pending.length > 0) {
      const sec = this.section(root, fmt(m.pending, { count: pending.length }));
      const shown = this.showAllPending ? pending : pending.slice(0, PENDING_PREVIEW);
      for (const p of shown) {
        const meta = fmt(m.pendingMeta, { op: m.ops[p.op], age: formatAge(now - p.since, ctx.lang) });
        this.row(sec.list, p.path, meta, "div");
      }
      if (shown.length < pending.length) {
        h(sec.list, "button", { cls: `${P}__more`, text: fmt(m.showAll, { count: pending.length }) }).addEventListener(
          "click",
          () => {
            this.showAllPending = true;
            this.render();
          },
        );
      }
    }

    const deferred = ctx.source.deferred();
    if (deferred.length > 0) {
      const sec = this.section(root, fmt(m.deferred, { count: deferred.length }));
      for (const d of deferred) {
        const row = this.row(sec.list, d.path, formatSize(d.size, ctx.lang), "div");
        h(row, "button", { text: d.direction === "upload" ? m.uploadNow : m.downloadNow }).addEventListener(
          "click",
          () => {
            void ctx.actions.uploadNow(d.path);
          },
        );
      }
    }

    const device = ctx.source.device();
    const sec = this.section(root, m.device);
    const dl = h(sec.list, "dl", { cls: `${P}__device` });
    for (const [label, value] of [
      [m.deviceName, device.name],
      [m.mode, m.modes[device.mode]],
      [m.server, device.server],
    ] as const) {
      h(dl, "dt", { text: label });
      h(dl, "dd", { text: value });
    }
  }

  private section(root: HTMLElement, title: string): { header: HTMLElement; list: HTMLElement } {
    const sec = h(root, "section", { cls: `${P}__section` });
    const header = h(sec, "div", { cls: `${P}__header` });
    h(header, "h3", { text: title });
    return { header, list: h(sec, "div", { cls: `${P}__list` }) };
  }

  private row(list: HTMLElement, main: string, meta: string, tag: "button" | "div" = "button"): HTMLElement {
    const row = h(list, tag, { cls: `${P}__row` });
    h(row, "span", { cls: `${P}__name`, text: main });
    h(row, "span", { cls: `${P}__meta`, text: meta });
    return row;
  }
}
```

Run: `pnpm --filter @kamino/plugin test -- StatusPanelView` → PASS.

- [ ] **Step 5: L'indicatore apre il pannello**

In `apps/plugin/src/ui/StatusIndicator.ts`: aggiungere `onOpenDetails: () => void;` a `IndicatorDeps`; sostituire il corpo di `showDetails()` con `this.deps.onOpenDetails();` (rimuovere l'import di `Notice` se non più usato… resta usato dalla notice sul cambio di livello).

In `apps/plugin/src/ui/StatusIndicator.test.ts`: in `setup()` passare `onOpenDetails: vi.fn()` (importare `vi`) e restituirlo; sostituire il test "clicking the ribbon shows the full label" con:

```ts
  it("clicking the ribbon opens the status panel", () => {
    const { plugin, indicator, onOpenDetails } = setup(false);
    indicator.update(status("safe"));
    plugin.ribbonIcons[0]!.click();
    expect(onOpenDetails).toHaveBeenCalled();
  });
```

- [ ] **Step 6: Galleria su `FakeSyncState`, comandi, `main.ts`**

`apps/plugin/src/dev/status-gallery.ts`: cambiare la firma in `registerStatusGallery(plugin: Plugin, state: FakeSyncState, deps: { now: () => number; lang: Lang })` e nel callback sostituire `indicator.update(describeStatus(ex.snapshot, DEFAULT_THRESHOLDS, now));` con `state.setSnapshot(ex.snapshot);` (rimuovere gli import non più usati).

`apps/plugin/src/dev/commands.ts`: `DevDeps` diventa `{ lang: Lang; now: () => number; state: FakeSyncState; ctx: UiContext }`; registrare anche la galleria (`registerStatusGallery(plugin, deps.state, deps)`) e il comando scenario:

```ts
  plugin.addCommand({
    id: "dev-conflict-scenario",
    name: t(deps.lang).dev.conflictScenario,
    callback: () => {
      deps.state.loadScenario(conflictScenario(deps.now()));
      void deps.ctx.openStatusPanel();
    },
  });
```

`apps/plugin/src/main.ts` (contenuto completo; `BulkResolveModal` e `ConflictView` arrivano nei Task 4–5: fino ad allora `openBulkResolve: () => undefined` e nessuna `registerView(CONFLICT_VIEW, …)`):

```ts
import { DEFAULT_THRESHOLDS, describeStatus } from "@kamino/status";
import { getIconIds, Platform, Plugin } from "obsidian";
import { registerDevCommands } from "./dev/commands.js";
import { detectLanguage, t } from "./i18n/index.js";
import { SettingsTab } from "./settings/SettingsTab.js";
import { FakeSyncState } from "./state/fake.js";
import type { UiContext } from "./ui/context.js";
import { StatusIndicator } from "./ui/StatusIndicator.js";
import { StatusPanelView } from "./ui/StatusPanelView.js";
import { openConflict, openStatusPanel, STATUS_VIEW } from "./ui/workspace.js";

export default class SyncPlugin extends Plugin {
  override onload(): void {
    this.addSettingTab(new SettingsTab(this.app, this));

    const lang = detectLanguage();
    const m = t(lang);
    const now = () => Date.now();
    // Until the sync engine lands (M1/M3) the state is an empty in-memory one: "never synced".
    const state = new FakeSyncState({ name: m.panel.notLinked, mode: "live", server: m.panel.noServer }, now);
    const ctx: UiContext = {
      source: state,
      actions: state,
      lang,
      isMobile: Platform.isMobile,
      now,
      available: new Set(getIconIds()),
      openStatusPanel: () => openStatusPanel(this.app),
      openConflict: (id) => openConflict(this.app, id),
      openBulkResolve: () => undefined,
    };

    this.registerView(STATUS_VIEW, (leaf) => new StatusPanelView(leaf, ctx));

    const indicator = new StatusIndicator(this, {
      isMobile: ctx.isMobile,
      lang,
      now,
      available: ctx.available,
      onOpenDetails: () => void ctx.openStatusPanel(),
    });
    indicator.mount();
    const refresh = () => indicator.update(describeStatus(state.snapshot(), DEFAULT_THRESHOLDS, now()));
    this.register(state.onChange(refresh));
    refresh();

    this.addCommand({ id: "open-status", name: m.panel.openCommand, callback: () => void ctx.openStatusPanel() });

    if (__DEV__) registerDevCommands(this, { lang, now, state, ctx });
  }
}
```

- [ ] **Step 7: Stili del pannello**

Aggiungere a `apps/plugin/src/styles.css`:

```css
.kamino-status-panel {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-4);
  padding: var(--size-4-3);
}
.kamino-status-panel__summary {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--size-4-1);
}
.kamino-status-panel__headline {
  font-size: var(--font-ui-medium);
  font-weight: var(--font-semibold);
}
.kamino-status-panel__muted {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--font-ui-small);
}
.kamino-status-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--size-4-2);
  margin-bottom: var(--size-4-1);
}
.kamino-status-panel__header h3 {
  margin: 0;
  font-size: var(--font-ui-small);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.kamino-status-panel__row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--size-4-2);
  width: 100%;
  height: auto;
  padding: var(--size-4-2) var(--size-4-1);
  border-top: 1px solid var(--background-modifier-border);
  background: none;
  box-shadow: none;
  text-align: left;
}
.kamino-status-panel__name {
  overflow-wrap: anywhere;
}
.kamino-status-panel__meta {
  flex: none;
  color: var(--text-muted);
  font-size: var(--font-ui-smaller);
}
.kamino-status-panel__device {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--size-4-1) var(--size-4-3);
  margin: 0;
}
.kamino-status-panel__device dt {
  color: var(--text-muted);
}
.kamino-status-panel__device dd {
  margin: 0;
}
```

- [ ] **Step 8: Verifica e commit**

Run: `pnpm --filter @kamino/plugin test && pnpm --filter @kamino/plugin typecheck && pnpm --filter @kamino/plugin lint` → verdi.

```bash
git add apps/plugin
git commit -m "feat(plugin): add sync status panel backed by sync state interfaces"
```

---

### Task 4: Vista di risoluzione dei conflitti (testo e binari)

**Files:**
- Create: `apps/plugin/src/ui/ConflictView.ts`
- Test: `apps/plugin/src/ui/ConflictView.test.ts`
- Modify: `apps/plugin/src/main.ts` (registerView), `apps/plugin/src/styles.css`

**Interfaces:**
- Consumes: `UiContext`, `ConflictDetail`, `Resolution`, `createDiffView`, `diffSummary`, `fmt`, `formatWhen`, `formatSize`, `basename`, `CONFLICT_VIEW`.
- Produces: `class ConflictView extends ItemView` (costruttore `(leaf, ctx)`; `getState()` restituisce `{ conflictId }`; `setState({ conflictId })` carica il conflitto).

- [ ] **Step 1: Test (falliscono)**

`apps/plugin/src/ui/ConflictView.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const diffCalls: Array<{ layout: string; editable: boolean }> = [];
const destroyed: number[] = [];
vi.mock("@kamino/ui-diff", () => ({
  diffSummary: () => ({ changes: 2 }),
  createDiffView: (parent: HTMLElement, opts: { layout: string; editable: boolean }) => {
    const n = diffCalls.push({ layout: opts.layout, editable: opts.editable });
    const el = parent.ownerDocument.createElement("div");
    el.className = "fake-diff";
    parent.append(el);
    return { getMerged: () => "merged text", destroy: () => destroyed.push(n) };
  },
}));

import { Notice, WorkspaceLeaf } from "../__mocks__/obsidian.js";
import { makeCtx, TEST_NOW } from "../__mocks__/ui-context.js";
import { conflictScenario } from "../state/scenarios.js";
import { ConflictView } from "./ConflictView.js";
import { CONFLICT_VIEW } from "./workspace.js";

beforeEach(() => {
  diffCalls.length = 0;
  destroyed.length = 0;
  Notice.shown = [];
});

async function openConflict(id: string, isMobile = false) {
  const { ctx, state, plugin } = makeCtx({ isMobile });
  state.loadScenario(conflictScenario(TEST_NOW));
  plugin.registerView(CONFLICT_VIEW, (leaf) => new ConflictView(leaf as never, ctx) as never);
  const leaf = new WorkspaceLeaf(plugin.app);
  await leaf.setViewState({ type: CONFLICT_VIEW, state: { conflictId: id } });
  const root = leaf.view!.contentEl;
  const button = (text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === text);
  return { ctx, state, plugin, leaf, root, button };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ConflictView, text, desktop", () => {
  it("shows header, summary and a split read-only diff", async () => {
    const { root, button } = await openConflict("c-shopping");
    expect(root.querySelector("h2")?.textContent).toBe("Spesa.md");
    expect(root.textContent).toContain("Entrambe le versioni sono salvate.");
    expect(root.textContent).toContain("Differenze: 2");
    expect(diffCalls).toEqual([{ layout: "split", editable: false }]);
    for (const b of ["Tieni la mia", "Tieni quella in arrivo", "Tieni entrambe", "Modifica e unisci…"]) {
      expect(button(b)).toBeDefined();
    }
  });

  it.each([
    ["Tieni la mia", { type: "keep_mine" }, "Hai tenuto la tua versione. Quella di iPhone resta nello storico."],
    ["Tieni quella in arrivo", { type: "keep_incoming" }, "Hai tenuto la versione di iPhone. La tua resta nello storico."],
    ["Tieni entrambe", { type: "keep_both" }, "Hai tenuto entrambe: la tua è salvata come file affiancato."],
  ])("%s resolves, notifies and closes", async (label, resolution, notice) => {
    const { state, leaf, button } = await openConflict("c-shopping");
    const spy = vi.spyOn(state, "resolve");
    button(label)!.click();
    await flush();
    expect(spy).toHaveBeenCalledWith("c-shopping", resolution);
    expect(Notice.shown).toContain(notice);
    expect(leaf.view).toBeNull();
  });

  it("edit and merge saves the merged text as a manual resolution", async () => {
    const { state, button } = await openConflict("c-shopping");
    const spy = vi.spyOn(state, "resolve");
    button("Modifica e unisci…")!.click();
    expect(diffCalls.at(-1)).toEqual({ layout: "split", editable: true });
    button("Salva l'unione")!.click();
    await flush();
    expect(spy).toHaveBeenCalledWith("c-shopping", { type: "manual", text: "merged text" });
    expect(Notice.shown).toContain("Unione salvata.");
  });

  it("cancel leaves edit mode", async () => {
    const { button } = await openConflict("c-shopping");
    button("Modifica e unisci…")!.click();
    button("Annulla")!.click();
    expect(diffCalls.at(-1)).toEqual({ layout: "split", editable: false });
    expect(button("Tieni la mia")).toBeDefined();
  });

  it("stale: reloads, warns, no success notice, stays open", async () => {
    const { state, leaf, root, button } = await openConflict("c-shopping");
    state.nextResolveStale();
    button("Tieni la mia")!.click();
    await flush();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(
      "È arrivata una versione più recente: controlla di nuovo prima di scegliere.",
    );
    expect(Notice.shown).toEqual([]);
    expect(leaf.view).not.toBeNull();
  });

  it("resolved elsewhere: shows 'already resolved'", async () => {
    const { state, root, button } = await openConflict("c-shopping");
    await state.resolve("c-shopping", { type: "keep_mine" });
    await flush();
    expect(root.textContent).toContain("Questo conflitto è già stato risolto.");
    expect(button("Chiudi")).toBeDefined();
  });

  it("destroys the diff on close", async () => {
    const { leaf } = await openConflict("c-shopping");
    leaf.detach();
    await flush();
    expect(destroyed.length).toBeGreaterThan(0);
  });
});

describe("ConflictView, text, mobile", () => {
  it("opens on the Differences tab with a unified diff", async () => {
    const { root } = await openConflict("c-shopping", true);
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    expect(tabs.map((x) => x.textContent)).toEqual(["La tua", "Differenze", "In arrivo"]);
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(diffCalls).toEqual([{ layout: "unified", editable: false }]);
  });

  it("'La tua' shows the full text without a diff", async () => {
    const { root } = await openConflict("c-shopping", true);
    (root.querySelector('[role="tab"]') as HTMLElement).click();
    expect(root.querySelector("pre")?.textContent).toContain("uova (6)");
    expect(root.querySelector(".fake-diff")).toBeNull();
  });
});

describe("ConflictView, binary", () => {
  it("shows previews and no edit action", async () => {
    const { root, button } = await openConflict("c-photo");
    expect(root.querySelectorAll("img")).toHaveLength(2);
    expect(root.textContent).toContain("Due file con lo stesso nome");
    expect(button("Modifica e unisci…")).toBeUndefined();
    expect(diffCalls).toEqual([]);
  });

  it("shows a placeholder when there is no preview", async () => {
    const { ctx, state, plugin } = makeCtx();
    const sc = conflictScenario(TEST_NOW);
    const photo = sc.conflicts[2]!;
    if (!photo.binary) throw new Error("fixture");
    state.loadScenario({ ...sc, conflicts: [{ ...photo, mineFile: { ...photo.mineFile, previewUrl: null } }] });
    plugin.registerView(CONFLICT_VIEW, (leaf) => new ConflictView(leaf as never, ctx) as never);
    const leaf = new WorkspaceLeaf(plugin.app);
    await leaf.setViewState({ type: CONFLICT_VIEW, state: { conflictId: "c-photo" } });
    const root = leaf.view!.contentEl;
    expect(root.querySelectorAll("img")).toHaveLength(1);
    expect(root.textContent).toContain("Anteprima non disponibile");
  });
});
```

Run: `pnpm --filter @kamino/plugin test -- ConflictView` → FAIL (modulo mancante).

- [ ] **Step 2: `ConflictView`**

`apps/plugin/src/ui/ConflictView.ts`:

```ts
import { createDiffView, diffSummary, type DiffViewHandle } from "@kamino/ui-diff";
import { ItemView, Notice, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { basename, fmt, formatSize, formatWhen } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import type { BinaryInfo, ConflictDetail, Resolution } from "../state/types.js";
import type { UiContext } from "./context.js";
import { h } from "./dom.js";
import { CLASS_PREFIX } from "./status-classes.js";
import { CONFLICT_VIEW } from "./workspace.js";

const P = `${CLASS_PREFIX}-conflict`;
type Tab = "mine" | "diff" | "incoming";

/** Resolution of one conflict (spec §5.2–5.3). */
export class ConflictView extends ItemView {
  private conflictId: string | null = null;
  private detail: ConflictDetail | null = null;
  private diff: DiffViewHandle | null = null;
  private editing = false;
  private tab: Tab = "diff";
  private staleWarning = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly ctx: UiContext,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return CONFLICT_VIEW;
  }
  override getDisplayText(): string {
    const m = t(this.ctx.lang).conflict;
    return this.detail ? fmt(m.viewTitle, { name: basename(this.detail.path) }) : m.viewTitleEmpty;
  }
  override getIcon(): string {
    return "git-compare-arrows";
  }
  override getState(): Record<string, unknown> {
    return { ...super.getState(), conflictId: this.conflictId };
  }
  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const id = (state as { conflictId?: unknown } | null)?.conflictId;
    this.conflictId = typeof id === "string" ? id : null;
    await this.loadConflict();
    await super.setState(state, result);
  }

  protected override onOpen(): Promise<void> {
    // Resolved elsewhere (another view, bulk, M3 push) → show "already resolved".
    this.unsubscribe = this.ctx.source.onChange(() => {
      if (this.detail && !this.ctx.source.conflicts().some((c) => c.id === this.conflictId)) void this.loadConflict();
    });
    return Promise.resolve();
  }

  protected override onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.destroyDiff();
    return Promise.resolve();
  }

  private async loadConflict(): Promise<void> {
    this.editing = false;
    this.tab = "diff";
    this.detail = this.conflictId ? await this.ctx.source.conflict(this.conflictId) : null;
    this.render();
  }

  private destroyDiff(): void {
    this.diff?.destroy();
    this.diff = null;
  }

  private render(): void {
    const m = t(this.ctx.lang).conflict;
    this.destroyDiff();
    const root = this.contentEl;
    root.replaceChildren();
    root.classList.add(P);
    root.classList.toggle(`${P}--mobile`, this.ctx.isMobile);

    const d = this.detail;
    if (!d) {
      h(root, "p", { text: m.gone });
      h(root, "button", { text: m.close }).addEventListener("click", () => this.leaf.detach());
      return;
    }

    const now = this.ctx.now();
    const when = (at: number) => formatWhen(at, now, this.ctx.lang);
    h(root, "h2", { text: basename(d.path) });
    const summary = d.kind === "both_created" ? m.summaryCreated : m.summaryEdit;
    h(root, "p", {
      cls: `${P}__muted`,
      text: fmt(summary, { mine: when(d.mine.at), device: d.incoming.device, incoming: when(d.incoming.at) }),
    });
    if (this.staleWarning) h(root, "div", { cls: `${P}__alert`, text: m.stale, attrs: { role: "alert" } });

    if (d.binary) this.renderBinary(root, d);
    else this.renderText(root, d);
    this.renderActions(root, d);
  }

  private renderText(root: HTMLElement, d: Extract<ConflictDetail, { binary: false }>): void {
    const m = t(this.ctx.lang).conflict;
    h(root, "p", { cls: `${P}__muted`, text: fmt(m.changes, { count: diffSummary(d.mineText, d.incomingText).changes }) });
    const labels = {
      mine: m.labelMine,
      incoming: fmt(m.labelIncoming, { device: d.incoming.device, when: formatWhen(d.incoming.at, this.ctx.now(), this.ctx.lang) }),
    };
    const phrases = { Accept: m.chunkKeepMine, Reject: m.chunkTakeIncoming };

    if (!this.ctx.isMobile) {
      const host = h(root, "div", { cls: `${P}__diff` });
      this.diff = createDiffView(host, { mine: d.mineText, incoming: d.incomingText, layout: "split", editable: this.editing, labels, phrases });
      return;
    }

    const tabs = h(root, "div", { cls: `${P}__tabs`, attrs: { role: "tablist" } });
    for (const [id, label] of [
      ["mine", m.tabMine],
      ["diff", m.tabDiff],
      ["incoming", m.tabIncoming],
    ] as const) {
      const tab = h(tabs, "button", { text: label, attrs: { role: "tab", "aria-selected": String(this.tab === id) } });
      tab.disabled = this.editing && id !== "diff";
      tab.addEventListener("click", () => {
        this.tab = id;
        this.render();
      });
    }
    const panel = h(root, "div", { cls: `${P}__tabpanel`, attrs: { role: "tabpanel" } });
    if (this.tab === "diff") {
      this.diff = createDiffView(panel, { mine: d.mineText, incoming: d.incomingText, layout: "unified", editable: this.editing, labels, phrases });
    } else {
      h(panel, "pre", { cls: `${P}__text`, text: this.tab === "mine" ? d.mineText : d.incomingText });
    }
  }

  private renderBinary(root: HTMLElement, d: Extract<ConflictDetail, { binary: true }>): void {
    const m = t(this.ctx.lang).conflict;
    const grid = h(root, "div", { cls: `${P}__binary` });
    const card = (title: string, info: BinaryInfo, device: string, at: number) => {
      const box = h(grid, "section", { cls: `${P}__file` });
      h(box, "h3", { text: title });
      if (info.previewUrl) h(box, "img", { attrs: { src: info.previewUrl, alt: title } });
      else h(box, "p", { cls: `${P}__muted`, text: m.noPreview });
      const dl = h(box, "dl");
      for (const [k, v] of [
        [m.fileDevice, device],
        [m.fileDate, formatWhen(at, this.ctx.now(), this.ctx.lang)],
        [m.fileSize, formatSize(info.size, this.ctx.lang)],
        [m.fileType, info.mime],
      ] as const) {
        h(dl, "dt", { text: k });
        h(dl, "dd", { text: v });
      }
    };
    card(m.tabMine, d.mineFile, d.mine.device, d.mine.at);
    card(m.tabIncoming, d.incomingFile, d.incoming.device, d.incoming.at);
  }

  private renderActions(root: HTMLElement, d: ConflictDetail): void {
    const m = t(this.ctx.lang).conflict;
    const bar = h(root, "div", { cls: `${P}__actions` });
    const button = (text: string, onClick: () => void, cta = false) =>
      h(bar, "button", { text, ...(cta ? { cls: "mod-cta" } : {}) }).addEventListener("click", onClick);

    if (this.editing) {
      button(m.saveMerge, () => void this.apply({ type: "manual", text: this.diff?.getMerged() ?? "" }), true);
      button(m.cancel, () => {
        this.editing = false;
        this.render();
      });
      return;
    }
    button(m.keepMine, () => void this.apply({ type: "keep_mine" }));
    button(m.keepIncoming, () => void this.apply({ type: "keep_incoming" }));
    button(m.keepBoth, () => void this.apply({ type: "keep_both" }));
    if (!d.binary) {
      button(
        m.edit,
        () => {
          this.editing = true;
          this.tab = "diff";
          this.render();
        },
        true,
      );
    }
  }

  private async apply(resolution: Resolution): Promise<void> {
    const d = this.detail;
    if (!d || !this.conflictId) return;
    const m = t(this.ctx.lang).conflict;
    const outcome = await this.ctx.actions.resolve(this.conflictId, resolution);
    if (outcome.ok) {
      const text = {
        keep_mine: fmt(m.doneMine, { device: d.incoming.device }),
        keep_incoming: fmt(m.doneIncoming, { device: d.incoming.device }),
        keep_both: m.doneBoth,
        manual: m.doneMerge,
      }[resolution.type];
      new Notice(text);
      this.leaf.detach();
      return;
    }
    this.staleWarning = outcome.reason === "stale";
    await this.loadConflict();
  }
}
```

Note di implementazione:
- `P` vale `kamino-conflict`: in `src/ui/status-classes.ts` aggiungere `export const CLASS_PREFIX = PRODUCT_SLUG;` e definire `STATUS_CLASS` come `` `${CLASS_PREFIX}-status` ``.
- Le chiavi di `phrases` (`Accept`, `Reject`) vanno verificate in `node_modules/@codemirror/merge/dist/index.js` (`state.phrase("…")`): usare le frasi esatte che il pacchetto usa per i controlli unificati (e per la freccia di ripristino della vista affiancata, se ha una frase, aggiungerla con `m.chunkTakeIncoming`).
- `stale` → `staleWarning` resta vero dopo il `load()`; si azzera solo con una nuova apertura della vista.

Run: `pnpm --filter @kamino/plugin test -- ConflictView` → PASS.

- [ ] **Step 3: Registrazione e stili**

In `apps/plugin/src/main.ts`: importare `ConflictView` e `CONFLICT_VIEW`; dopo la registrazione del pannello: `this.registerView(CONFLICT_VIEW, (leaf) => new ConflictView(leaf, ctx));`.

Aggiungere a `apps/plugin/src/styles.css`:

```css
.kamino-conflict {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
  padding: var(--size-4-4);
}
.kamino-conflict h2 {
  margin: 0;
}
.kamino-conflict__muted {
  margin: 0;
  color: var(--text-muted);
}
.kamino-conflict__alert {
  padding: var(--size-4-2) var(--size-4-3);
  border: 1px solid var(--color-yellow);
  border-radius: var(--radius-s);
  background: var(--background-secondary);
}
.kamino-conflict__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--size-4-2);
}
.kamino-conflict--mobile .kamino-conflict__actions {
  flex-direction: column;
}
.kamino-conflict--mobile .kamino-conflict__actions button {
  width: 100%;
}
.kamino-conflict__tabs {
  display: flex;
  border-bottom: 1px solid var(--background-modifier-border);
}
.kamino-conflict__tabs button {
  flex: 1;
  border-radius: 0;
  background: none;
  box-shadow: none;
}
.kamino-conflict__tabs button[aria-selected="true"] {
  box-shadow: inset 0 -2px 0 var(--interactive-accent);
}
.kamino-conflict__text {
  margin: 0;
  white-space: pre-wrap;
  font-family: var(--font-monospace);
  font-size: var(--font-ui-small);
}
.kamino-conflict__binary {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--size-4-3);
}
.kamino-conflict--mobile .kamino-conflict__binary {
  grid-template-columns: 1fr;
}
.kamino-conflict__file img {
  max-width: 100%;
  height: auto;
  border-radius: var(--radius-s);
}
/* Unified diff: the document is "mine", the original is "incoming".
   @codemirror/merge colors the document as inserted (green) and the original as deleted (red):
   recolor so that mine = red and incoming = green, as in the split view.
   Class names checked against @codemirror/merge 6.12 (re-check when upgrading). */
.kamino-conflict .diff-view--unified .cm-changedLine,
.kamino-conflict .diff-view--unified .cm-inlineChangedLine {
  background-color: rgba(var(--color-red-rgb), 0.12);
}
.kamino-conflict .diff-view--unified .cm-changedText {
  background: rgba(var(--color-red-rgb), 0.25);
}
.kamino-conflict .diff-view--unified .cm-deletedChunk {
  background-color: rgba(var(--color-green-rgb), 0.12);
}
.kamino-conflict .diff-view--unified .cm-deletedChunk .cm-deletedText {
  background: rgba(var(--color-green-rgb), 0.25);
}
```

Verificare in `node_modules/@codemirror/merge/dist/index.js` i nomi effettivi delle classi (`cm-changedLine`, `cm-changedText`, `cm-deletedChunk`, `cm-deletedText`…) e correggere i selettori se diversi.

- [ ] **Step 4: Verifica e commit**

Run: `pnpm --filter @kamino/plugin test && pnpm --filter @kamino/plugin typecheck && pnpm --filter @kamino/plugin lint` → verdi.

```bash
git add apps/plugin
git commit -m "feat(plugin): add conflict resolution view for text and binary files"
```

---

### Task 5: Risoluzione in blocco, controlli sul bundle

**Files:**
- Create: `apps/plugin/src/ui/BulkResolveModal.ts`
- Test: `apps/plugin/src/ui/BulkResolveModal.test.ts`
- Modify: `apps/plugin/src/main.ts` (`openBulkResolve`), `apps/plugin/test/manifest.test.ts`

**Interfaces:**
- Consumes: `UiContext`, `BulkStrategy`, `fmt`.
- Produces: `class BulkResolveModal extends Modal` (costruttore `(app, ctx)`).

- [ ] **Step 1: Test (falliscono)**

`apps/plugin/src/ui/BulkResolveModal.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, Notice } from "../__mocks__/obsidian.js";
import { makeCtx, TEST_NOW } from "../__mocks__/ui-context.js";
import { conflictScenario } from "../state/scenarios.js";
import { BulkResolveModal } from "./BulkResolveModal.js";

beforeEach(() => {
  Notice.shown = [];
});

function open() {
  const { ctx, state } = makeCtx();
  state.loadScenario(conflictScenario(TEST_NOW));
  const modal = new BulkResolveModal(new App() as never, ctx);
  modal.open();
  const root = (modal as unknown as { contentEl: HTMLElement }).contentEl;
  const apply = [...root.querySelectorAll("button")].find((b) => b.textContent === "Applica")!;
  return { modal, root, apply, state };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("BulkResolveModal", () => {
  it("lists three options, none selected, and the count", () => {
    const { root, apply } = open();
    const radios = [...root.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    expect(radios).toHaveLength(3);
    expect(radios.some((r) => r.checked)).toBe(false);
    expect(root.textContent).toContain("Si applica a 3 file");
    expect(apply.disabled).toBe(true);
  });

  it("does nothing without a choice", async () => {
    const { apply, state } = open();
    const spy = vi.spyOn(state, "resolveAll");
    apply.click();
    await flush();
    expect(spy).not.toHaveBeenCalled();
  });

  it("applies the chosen strategy, notifies and closes", async () => {
    const { modal, root, apply, state } = open();
    const spy = vi.spyOn(state, "resolveAll");
    const keepBoth = root.querySelector('input[value="keep_both"]') as HTMLInputElement;
    keepBoth.checked = true;
    keepBoth.dispatchEvent(new Event("change"));
    expect(apply.disabled).toBe(false);
    apply.click();
    await flush();
    expect(spy).toHaveBeenCalledWith("keep_both");
    expect(Notice.shown).toContain("Conflitti risolti: 3");
    expect((modal as unknown as { isOpen: boolean }).isOpen).toBe(false);
  });

  it("cancel closes without applying", () => {
    const { modal, root, state } = open();
    const spy = vi.spyOn(state, "resolveAll");
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Annulla")!.click();
    expect(spy).not.toHaveBeenCalled();
    expect((modal as unknown as { isOpen: boolean }).isOpen).toBe(false);
  });
});
```

Run: `pnpm --filter @kamino/plugin test -- BulkResolveModal` → FAIL.

- [ ] **Step 2: `BulkResolveModal`**

`apps/plugin/src/ui/BulkResolveModal.ts`:

```ts
import { Modal, Notice, type App } from "obsidian";
import { fmt } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import type { BulkStrategy } from "../state/types.js";
import type { UiContext } from "./context.js";
import { h } from "./dom.js";

/** "Resolve all…": explicit choice and confirmation (spec §5.4). */
export class BulkResolveModal extends Modal {
  private choice: BulkStrategy | null = null;

  constructor(
    app: App,
    private readonly ctx: UiContext,
  ) {
    super(app);
  }

  override onOpen(): void {
    const m = t(this.ctx.lang).bulk;
    this.titleEl.textContent = m.title;
    const root = this.contentEl;
    root.replaceChildren();

    const apply = root.ownerDocument.createElement("button");
    apply.className = "mod-cta";
    apply.textContent = m.apply;
    apply.disabled = true;
    apply.addEventListener("click", () => void this.apply());

    const group = h(root, "div", { attrs: { role: "radiogroup", "aria-label": m.title } });
    for (const [value, label] of [
      ["keep_mine", m.keepMine],
      ["keep_incoming", m.keepIncoming],
      ["keep_both", m.keepBoth],
    ] as const) {
      const row = h(group, "label");
      const input = h(row, "input", { attrs: { type: "radio", name: "bulk-strategy", value } });
      row.append(` ${label}`);
      input.addEventListener("change", () => {
        if (!input.checked) return;
        this.choice = value;
        apply.disabled = false;
      });
    }

    h(root, "p", { text: fmt(m.appliesTo, { count: this.ctx.source.conflicts().length }) });
    const bar = h(root, "div", { cls: "modal-button-container" });
    bar.append(apply);
    h(bar, "button", { text: m.cancel }).addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.replaceChildren();
  }

  private async apply(): Promise<void> {
    if (!this.choice) return;
    const { resolved } = await this.ctx.actions.resolveAll(this.choice);
    new Notice(fmt(t(this.ctx.lang).bulk.done, { count: resolved }));
    this.close();
  }
}
```

In `apps/plugin/src/main.ts`: importare `BulkResolveModal` e impostare `openBulkResolve: () => new BulkResolveModal(this.app, ctx).open(),`.

Run: `pnpm --filter @kamino/plugin test -- BulkResolveModal` → PASS.

- [ ] **Step 3: Controlli sul bundle di produzione**

In `apps/plugin/test/manifest.test.ts`, nel `describe` che legge `dist/main.js`, aggiungere:

```ts
  it("keeps Obsidian's CodeMirror external and bundles the merge view", () => {
    const bundle = read("dist/main.js");
    expect(bundle).toMatch(/require\("@codemirror\/state"\)/);
    expect(bundle).toMatch(/require\("@codemirror\/view"\)/);
    expect(bundle).not.toMatch(/require\("@codemirror\/merge"\)/);
  });
```

Run: `pnpm --filter @kamino/plugin test` → PASS. Run: `pnpm --filter @kamino/plugin build && wc -c apps/plugin/dist/main.js` e annotare la dimensione **dopo** (nel messaggio di commit e nell'HANDOVER).

- [ ] **Step 4: Verifica manuale e commit**

Run: `pnpm --filter @kamino/plugin build:vault`. In Obsidian desktop: "Carica scenario conflitti (sviluppo)" → pannello con 3 conflitti, 3 modifiche, 1 file in attesa; aprire ogni conflitto; provare tieni la mia / in arrivo / entrambe / modifica e unisci; "Risolvi tutti…"; "Sincronizza ora"; "Carica ora". Indicatore e pannello si aggiornano a ogni passo.

Run: `pnpm --filter @kamino/plugin typecheck && pnpm --filter @kamino/plugin lint`

```bash
git add apps/plugin
git commit -m "feat(plugin): add bulk conflict resolution and bundle checks"
```

---

### Task 6: Documentazione, changeset, verifica finale

**Files:**
- Modify: `docs/ui/design-system.md`, `docs/HANDOVER.md`, `CLAUDE.md`, `docs/renaming.md`
- Create: `.changeset/status-panel-conflicts.md`

- [ ] **Step 1: `docs/ui/design-system.md`** — nuova sezione "7. Pannello di stato e conflitti" (in italiano):
  - pannello: posizione (barra laterale destra, cassetto su mobile), riepilogo, sezioni non vuote nell'ordine conflitti / non ancora sul server / in attesa di Wi-Fi / questo dispositivo, "Risolvi tutti…" da 2 conflitti;
  - vista di risoluzione: desktop affiancata, mobile schede "La tua / Differenze / In arrivo"; colori del diff (la tua = rosso, in arrivo = verde, in entrambi i layout); "Modifica e unisci" parte sempre dalla tua versione;
  - regola delle risoluzioni: si applicano subito con notice (l'altra versione resta nello storico); conferma esplicita solo in blocco; `stale` e "già risolto";
  - binari: anteprima solo per immagini;
  - gallerie: comandi "Carica scenario conflitti (sviluppo)" e "Apri diff di prova (sviluppo)".
  Nella sezione 5 (Plugin) aggiornare: il clic sull'indicatore apre il pannello.

- [ ] **Step 2: Altri documenti**
  - `CLAUDE.md`, Struttura: sostituire la riga `packages/ui-diff   (milestone successive) …` con `packages/ui-diff    diff/merge su @codemirror/merge (plugin ora, web in M4)`.
  - `docs/renaming.md`: aggiungere che i tipi di vista del plugin (`kamino-status-panel`, `kamino-conflict`) derivano da `PRODUCT_SLUG` (cambiarli fa perdere le schede aperte salvate nel layout degli utenti).
  - `docs/HANDOVER.md`: stato della sotto-fase 2; decisioni V1–V5; esito R-3 desktop; dimensione del bundle prima/dopo; rimuovere il punto aperto M3 sugli esterni di esbuild (fatto); prossimi passi.

- [ ] **Step 3: Changeset**

`.changeset/status-panel-conflicts.md`:

```md
---
"@kamino/plugin": minor
---

Add the sync status panel and conflict resolution views (side-by-side diff on desktop, tabs with a unified diff on mobile, binary files, resolve all), built on a CodeMirror merge view.
```

- [ ] **Step 4: Verifica completa**

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm release-names:check
docker build -q -f docker/Dockerfile --build-arg KAMINO_BUILD_COMMIT=local .
```

Expected: tutto verde, immagine costruita.

- [ ] **Step 5: Commit e push**

```bash
git add docs CLAUDE.md .changeset
git commit -m "docs: document status panel and conflict resolution"
git push
```

Expected: CI verde. Poi revisione finale del branch (un subagente) e PR.
