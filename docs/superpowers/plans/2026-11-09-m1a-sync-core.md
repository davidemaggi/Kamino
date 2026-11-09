# M1a — `packages/sync-core` — piano di implementazione

> **For agentic workers:** standard del progetto (`CLAUDE.md`): superpowers:executing-plans nella sessione corrente, a blocchi. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** logica di sync pura e deterministica: path, esclusioni, arbitro con le regole del server e archivio in memoria, riduttore del client, simulatore con N client e proprietà di convergenza e "nessuna perdita".

**Architecture:** core funzionale, guscio imperativo (Z3). `decide(view, op)` per il server; `step(state, event, env) → { state, effects }` per il client; il simulatore fa da guscio a entrambi. Contratto in `@kamino/protocol/sync.ts`.

**Spec:** `docs/superpowers/specs/2026-11-09-m1a-sync-core-design.md` (decisioni Z1–Z9).

**Blocchi:** (A) Task 1–3 contratto, pacchetto, path, esclusioni; (B) Task 4 arbitro e archivio; (C) Task 5 client; (D) Task 6 simulatore e proprietà; (E) Task 7 documenti, verifica, revisione, PR.

## Global Constraints

- TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`); nessuna API Node/DOM nel codice di `sync-core` (`types: []`, `lib: ES2023`): niente `structuredClone`, `TextEncoder`, `process`.
- Nessun orologio, nessuna casualità: ID, tempi e valori casuali arrivano come input.
- Mai loggare path o contenuti (qui non si logga nulla).
- Ogni controesempio trovato da fast-check diventa un test con il suo seme.
- Nuovo pacchetto: `COPY` nel `docker/Dockerfile`, `ignore` nei changeset.
- `pnpm format:check` prima di ogni push.

## Review Focus

1. Il client non sovrascrive né cestina mai un contenuto locale che il server non ha (write con `expect`, trash con `expect`, nessuna scrittura su file in conflitto). → Task 5–6.
2. Le op con esito ignoto si ripetono identiche (stesso `opId`) e l'arbitro restituisce l'esito originale (`duplicate`); i rifiuti non vengono registrati. → Task 4–5.
3. `persist` precede ogni effetto (write-ahead): dopo un crash l'indice ritrova le scritture e le op inviate. → Task 5–6.
4. `collisionKey` conservativa e uguale per NFC/NFD e maiuscole. → Task 2.

---

### Task 1: Contratto di sync

**Files:** Create `packages/protocol/src/sync.ts`, `packages/protocol/src/sync.test.ts`; Modify `packages/protocol/src/index.ts`.

- [ ] **Step 1: Test** — `packages/protocol/src/sync.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ChangesResponse, CommitRequest, JournalEntry, Op, OpResult, Snapshot } from "./index.js";

const H = "a".repeat(64);

describe("sync contract", () => {
  it("ops are discriminated by type", () => {
    const put = { type: "put", opId: "o1", fileId: "f1", versionId: "v1", path: "a.md", baseVersionId: null, contentHash: H, size: 1, mtime: 0 };
    expect(Op.parse(put).type).toBe("put");
    expect(Op.safeParse({ ...put, contentHash: "XYZ" }).success).toBe(false);
    expect(Op.safeParse({ type: "move", opId: "o", fileId: "f", fromPath: "a", toPath: "b" }).success).toBe(true);
    expect(Op.safeParse({ type: "delete", opId: "o", fileId: "f", baseVersionId: null }).success).toBe(true);
  });

  it("commit batches hold 1 to 500 ops", () => {
    const op = { type: "mkdir", opId: "o", fileId: "f", path: "d" };
    expect(CommitRequest.safeParse({ ops: [] }).success).toBe(false);
    expect(CommitRequest.safeParse({ ops: Array(500).fill(op) }).success).toBe(true);
    expect(CommitRequest.safeParse({ ops: Array(501).fill(op) }).success).toBe(false);
  });

  it("results, including duplicates of the original", () => {
    const accepted = { status: "accepted", seq: 3, fileId: "f", versionId: "v", path: "a.md" };
    expect(OpResult.parse({ status: "duplicate", original: accepted }).status).toBe("duplicate");
    expect(OpResult.safeParse({ status: "rejected", code: "path_taken", path: "b.md" }).success).toBe(true);
    expect(OpResult.safeParse({ status: "rejected", code: "nope" }).success).toBe(false);
  });

  it("journal entries accept unknown types (03 §13)", () => {
    const e = { seq: 1, type: "something_new", fileId: "f", path: "a.md", deviceId: "d", at: "2026-01-01T00:00:00.000Z", ignorable: true };
    expect(JournalEntry.parse(e).type).toBe("something_new");
    expect(ChangesResponse.parse({ entries: [e], head: 1, hasMore: false }).head).toBe(1);
  });

  it("snapshot", () => {
    const s = { head: 2, files: [{ fileId: "f", kind: "file", path: "a.md", versionId: "v", contentHash: H, size: 1, mtime: 0 }], openConflicts: [] };
    expect(Snapshot.parse(s).files).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implementazione** — `packages/protocol/src/sync.ts`:

```ts
import { z } from "zod";
import { ErrorCode } from "./errors.js";

/** Client-generated identifiers (UUIDv7 recommended, 03 §1.7). */
export const SyncId = z.string().min(1).max(64);
/** SHA-256 of the plaintext, lowercase hex. */
export const ContentHash = z.string().regex(/^[0-9a-f]{64}$/);
/** Canonical path: "/" separators, NFC, "{config}/" prefix for the configuration folder (03 §2). */
export const SyncPath = z.string().min(1).max(4096);
export const FileKind = z.enum(["file", "folder"]);

export const PutOp = z.object({
  type: z.literal("put"),
  opId: SyncId,
  fileId: SyncId,
  versionId: SyncId,
  path: SyncPath,
  baseVersionId: SyncId.nullable(),
  contentHash: ContentHash,
  size: z.number().int().min(0),
  mtime: z.number().int(),
});
export const MkdirOp = z.object({ type: z.literal("mkdir"), opId: SyncId, fileId: SyncId, path: SyncPath });
export const MoveOp = z.object({
  type: z.literal("move"),
  opId: SyncId,
  fileId: SyncId,
  fromPath: SyncPath,
  toPath: SyncPath,
});
/** `baseVersionId` is null only for folders. */
export const DeleteOp = z.object({
  type: z.literal("delete"),
  opId: SyncId,
  fileId: SyncId,
  baseVersionId: SyncId.nullable(),
});
export const Op = z.discriminatedUnion("type", [PutOp, MkdirOp, MoveOp, DeleteOp]);
export type PutOp = z.infer<typeof PutOp>;
export type MkdirOp = z.infer<typeof MkdirOp>;
export type MoveOp = z.infer<typeof MoveOp>;
export type DeleteOp = z.infer<typeof DeleteOp>;
export type Op = z.infer<typeof Op>;

/** `seq` = journal entry of the op, or the current head when the op added none (e.g. delete of a deleted file). */
export const AcceptedResult = z.object({
  status: z.literal("accepted"),
  seq: z.number().int().min(0),
  fileId: SyncId,
  versionId: SyncId.optional(),
  path: SyncPath,
});
export const ConflictResult = z.object({
  status: z.literal("conflict"),
  conflictId: SyncId,
  headVersionId: SyncId,
});
/** Rejections are not recorded: the same opId may be sent again. */
export const RejectedResult = z.object({
  status: z.literal("rejected"),
  code: ErrorCode,
  path: SyncPath.optional(),
});
export const FinalResult = z.discriminatedUnion("status", [AcceptedResult, ConflictResult, RejectedResult]);
export const DuplicateResult = z.object({ status: z.literal("duplicate"), original: FinalResult });
export const OpResult = z.discriminatedUnion("status", [
  AcceptedResult,
  ConflictResult,
  RejectedResult,
  DuplicateResult,
]);
export type AcceptedResult = z.infer<typeof AcceptedResult>;
export type ConflictResult = z.infer<typeof ConflictResult>;
export type RejectedResult = z.infer<typeof RejectedResult>;
export type FinalResult = z.infer<typeof FinalResult>;
export type OpResult = z.infer<typeof OpResult>;

export const CommitRequest = z.object({ ops: z.array(Op).min(1).max(500) });
export const CommitResponse = z.object({ results: z.array(OpResult), head: z.number().int().min(0) });
export type CommitResponse = z.infer<typeof CommitResponse>;

export const JournalType = z.enum([
  "file_put",
  "file_moved",
  "file_deleted",
  "file_restored",
  "folder_created",
  "folder_deleted",
  "conflict_opened",
  "conflict_resolved",
  "vault_settings_changed",
]);
export type JournalType = z.infer<typeof JournalType>;
/** `type` is a free string: clients skip unknown types only when `ignorable` (03 §13). */
export const JournalEntry = z.object({
  seq: z.number().int().min(1),
  type: z.string(),
  fileId: SyncId,
  kind: FileKind.optional(),
  opId: SyncId.optional(),
  versionId: SyncId.optional(),
  path: SyncPath,
  contentHash: ContentHash.optional(),
  size: z.number().int().min(0).optional(),
  mtime: z.number().int().optional(),
  conflictId: SyncId.optional(),
  deviceId: SyncId,
  at: z.string(),
  ignorable: z.boolean().optional(),
});
export type JournalEntry = z.infer<typeof JournalEntry>;
export const ChangesResponse = z.object({
  entries: z.array(JournalEntry),
  head: z.number().int().min(0),
  hasMore: z.boolean(),
});
export type ChangesResponse = z.infer<typeof ChangesResponse>;

export const SnapshotFile = z.object({
  fileId: SyncId,
  kind: FileKind,
  path: SyncPath,
  versionId: SyncId.nullable(),
  contentHash: ContentHash.nullable(),
  size: z.number().int().min(0),
  mtime: z.number().int(),
});
export const Snapshot = z.object({
  head: z.number().int().min(0),
  files: z.array(SnapshotFile),
  openConflicts: z.array(z.object({ conflictId: SyncId, fileId: SyncId })),
});
export type SnapshotFile = z.infer<typeof SnapshotFile>;
export type Snapshot = z.infer<typeof Snapshot>;
```

`index.ts`: `export * from "./sync.js";`.

Run test/build/typecheck/lint del pacchetto; commit `feat(protocol): add sync contract`.

---

### Task 2: Pacchetto `sync-core` e path

**Files:** Create `packages/sync-core/{package.json,tsconfig.json,tsconfig.build.json}`, `packages/sync-core/src/{index.ts,paths.ts,paths.test.ts}`; Modify `docker/Dockerfile` (COPY), `.changeset/config.json` (`ignore`).

- [ ] **Step 1: Pacchetto** — `packages/sync-core/package.json`:

```json
{
  "name": "@kamino/sync-core",
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
    "test": "vitest run",
    "test:deep": "vitest run --config vitest.deep.config.ts"
  },
  "dependencies": {
    "@kamino/brand": "workspace:*",
    "@kamino/protocol": "workspace:*"
  },
  "devDependencies": {
    "@kamino/tsconfig": "workspace:*",
    "fast-check": "^4.10.2",
    "vitest": "^5.1.0"
  }
}
```

`packages/sync-core/tsconfig.json`:

```json
{
  "extends": "@kamino/tsconfig/node.json",
  "compilerOptions": { "types": [] },
  "include": ["src"]
}
```

`packages/sync-core/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true
  },
  "exclude": ["src/**/*.test.ts", "src/sim/**"]
}
```

`packages/sync-core/vitest.deep.config.ts` (molte più esecuzioni del simulatore; funziona anche in PowerShell):

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["src/sim/**/*.test.ts"], env: { SIM_RUNS: "3000" }, testTimeout: 1_800_000 } });
```

`docker/Dockerfile`: aggiungere `COPY packages/sync-core/package.json packages/sync-core/` accanto alle altre. `.changeset/config.json`: aggiungere `"@kamino/sync-core"` a `ignore`. Poi `pnpm install`.

- [ ] **Step 2: Test** — `packages/sync-core/src/paths.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CONFIG_PREFIX,
  collisionKey,
  conflictSiblingPath,
  isCanonical,
  isRepresentable,
  localPath,
  normalizePath,
  utf8Length,
} from "./paths.js";

const ok = (raw: string, cfg = ".obsidian") => {
  const r = normalizePath(raw, cfg);
  if (!r.ok) throw new Error(r.reason);
  return r.path;
};

describe("normalizePath", () => {
  it("separators, slashes, NFC, config prefix", () => {
    expect(ok("\\a\\b.md")).toBe("a/b.md");
    expect(ok("/a/b/")).toBe("a/b");
    expect(ok("é.md")).toBe("é.md");
    expect(ok(".obsidian/app.json")).toBe(`${CONFIG_PREFIX}/app.json`);
    expect(ok(".obsidian")).toBe(CONFIG_PREFIX);
    expect(ok("custom-cfg/app.json", "custom-cfg")).toBe(`${CONFIG_PREFIX}/app.json`);
    expect(localPath(`${CONFIG_PREFIX}/app.json`, ".obsidian")).toBe(".obsidian/app.json");
    expect(localPath("a/b.md", ".obsidian")).toBe("a/b.md");
  });

  it("rejects empty, dot and reserved segments", () => {
    expect(normalizePath("", ".obsidian")).toEqual({ ok: false, reason: "empty" });
    expect(normalizePath("a//b", ".obsidian")).toEqual({ ok: false, reason: "empty_segment" });
    expect(normalizePath("a/../b", ".obsidian")).toEqual({ ok: false, reason: "dot_segment" });
    expect(normalizePath("{config}/x", ".obsidian")).toEqual({ ok: false, reason: "reserved" });
  });

  it("canonical paths", () => {
    expect(isCanonical("a/b.md")).toBe(true);
    expect(isCanonical(`${CONFIG_PREFIX}/app.json`)).toBe(true);
    expect(isCanonical("é.md")).toBe(false);
    expect(isCanonical("a\\b")).toBe(false);
    expect(isCanonical("/a")).toBe(false);
  });

  it("normalizing twice changes nothing", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (raw) => {
        const r = normalizePath(raw, ".obsidian");
        if (r.ok) expect(normalizePath(localPath(r.path, ".obsidian"), ".obsidian")).toEqual(r);
      }),
    );
  });
});

describe("collisionKey", () => {
  it("case, NFC/NFD and sharp s collide", () => {
    expect(collisionKey("Nota.md")).toBe(collisionKey("nota.md"));
    expect(collisionKey("é.md")).toBe(collisionKey("é.md"));
    expect(collisionKey("Straße.md")).toBe(collisionKey("STRASSE.md"));
    expect(collisionKey("a.md")).not.toBe(collisionKey("b.md"));
  });

  it("idempotent, case- and normalization-insensitive", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (s) => {
        const k = collisionKey(s);
        expect(collisionKey(k)).toBe(k);
        expect(collisionKey(s.toUpperCase())).toBe(k);
        expect(collisionKey(s.toLowerCase())).toBe(k);
        expect(collisionKey(s.normalize("NFD"))).toBe(k);
      }),
      { numRuns: 500 },
    );
  });
});

describe("isRepresentable", () => {
  it("windows rules", () => {
    expect(isRepresentable("con.md", "windows")).toEqual({ ok: false, reason: "reserved_name" });
    expect(isRepresentable("a/COM1", "windows")).toEqual({ ok: false, reason: "reserved_name" });
    expect(isRepresentable("a?.md", "windows")).toEqual({ ok: false, reason: "forbidden_char" });
    expect(isRepresentable("a./b.md", "windows")).toEqual({ ok: false, reason: "trailing_dot_or_space" });
    expect(isRepresentable("con.md", "linux")).toEqual({ ok: true });
  });

  it("apple, android, linux", () => {
    expect(isRepresentable("a:b.md", "macos")).toEqual({ ok: false, reason: "forbidden_char" });
    expect(isRepresentable("a:b.md", "ios")).toEqual({ ok: false, reason: "forbidden_char" });
    expect(isRepresentable("a|b.md", "android")).toEqual({ ok: false, reason: "forbidden_char" });
    expect(isRepresentable("a|b.md", "linux")).toEqual({ ok: true });
  });

  it("lengths in UTF-8 bytes", () => {
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length("😀")).toBe(4);
    expect(isRepresentable("é".repeat(128), "linux")).toEqual({ ok: false, reason: "segment_too_long" });
    expect(isRepresentable("é".repeat(127), "linux")).toEqual({ ok: true });
  });
});

describe("conflictSiblingPath", () => {
  it("suffix before the extension, or at the end", () => {
    expect(conflictSiblingPath("a/Nota.md", 1)).toBe("a/Nota (1).md");
    expect(conflictSiblingPath("Nota.tar.gz", 2)).toBe("Nota.tar (2).gz");
    expect(conflictSiblingPath(".env", 1)).toBe(".env (1)");
    expect(conflictSiblingPath("Makefile", 3)).toBe("Makefile (3)");
  });
});
```

- [ ] **Step 3: Implementazione** — `packages/sync-core/src/paths.ts`:

```ts
/** Canonical paths (03 §2). Pure: no I/O. */

/** Canonical prefix of the Obsidian configuration folder (03 §11). */
export const CONFIG_PREFIX = "{config}";

export type PathError = "empty" | "empty_segment" | "dot_segment" | "reserved";
export type PathResult = { ok: true; path: string } | { ok: false; reason: PathError };

/** Local path → canonical: "/" separators, no leading/trailing "/", NFC, config folder → "{config}". */
export function normalizePath(raw: string, configDir: string): PathResult {
  const parts = raw.replace(/\\/g, "/").split("/");
  while (parts[0] === "") parts.shift();
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  if (parts.length === 0) return { ok: false, reason: "empty" };
  const out: string[] = [];
  for (const p of parts) {
    if (p === "") return { ok: false, reason: "empty_segment" };
    if (p === "." || p === "..") return { ok: false, reason: "dot_segment" };
    out.push(p.normalize("NFC"));
  }
  if (out[0] === CONFIG_PREFIX) return { ok: false, reason: "reserved" };
  if (out[0] === configDir.normalize("NFC")) out[0] = CONFIG_PREFIX;
  return { ok: true, path: out.join("/") };
}

/** Canonical → local path for this device's configuration folder name. */
export function localPath(canonical: string, configDir: string): string {
  if (canonical === CONFIG_PREFIX) return configDir;
  return canonical.startsWith(`${CONFIG_PREFIX}/`)
    ? `${configDir}${canonical.slice(CONFIG_PREFIX.length)}`
    : canonical;
}

/** True when `path` is already canonical: what the server accepts. */
export function isCanonical(path: string): boolean {
  if (path === CONFIG_PREFIX) return true;
  const body = path.startsWith(`${CONFIG_PREFIX}/`) ? path.slice(CONFIG_PREFIX.length + 1) : path;
  if (body.includes("\\")) return false;
  const r = normalizePath(body, "/");
  return r.ok && r.path === body;
}

/**
 * NFC + Unicode case folding, applied until stable. Deliberately broad ("ß" = "ss"): an extra
 * collision only yields a suffix or a conflict, never a loss (Z5). The server's value is the one that counts.
 */
export function collisionKey(path: string): string {
  let key = path.normalize("NFC");
  for (let i = 0; i < 8; i++) {
    const next = key.toUpperCase().toLowerCase().normalize("NFC");
    if (next === key) return key;
    key = next;
  }
  return key;
}

export type Platform = "windows" | "macos" | "ios" | "android" | "linux";
export type Unrepresentable =
  | "reserved_name"
  | "forbidden_char"
  | "trailing_dot_or_space"
  | "segment_too_long"
  | "path_too_long";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const FORBIDDEN: Record<Platform, string> = {
  windows: '<>:"|?*',
  android: '<>:"|?*',
  macos: ":",
  ios: ":",
  linux: "",
};

export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

function hasForbidden(segment: string, platform: Platform): boolean {
  for (const ch of segment) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0) return true;
    if (cp < 32 && (platform === "windows" || platform === "android")) return true;
    if (FORBIDDEN[platform].includes(ch)) return true;
  }
  return false;
}

/** Whether a local path can exist on this platform (03 §6.4). Pass the local path, not the canonical one. */
export function isRepresentable(
  path: string,
  platform: Platform,
): { ok: true } | { ok: false; reason: Unrepresentable } {
  if (utf8Length(path) > 4096) return { ok: false, reason: "path_too_long" };
  for (const segment of path.split("/")) {
    if (utf8Length(segment) > 255) return { ok: false, reason: "segment_too_long" };
    if (hasForbidden(segment, platform)) return { ok: false, reason: "forbidden_char" };
    if (platform === "windows") {
      if (WINDOWS_RESERVED.test(segment)) return { ok: false, reason: "reserved_name" };
      if (segment.endsWith(".") || segment.endsWith(" "))
        return { ok: false, reason: "trailing_dot_or_space" };
    }
  }
  return { ok: true };
}

/** "Nota.md" → "Nota (1).md"; ".env" → ".env (1)" (03 §5.3, §9.4). */
export function conflictSiblingPath(path: string, n: number): string {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  return `${dir}${stem} (${n})${ext}`;
}
```

`packages/sync-core/src/index.ts` (cresce con i task):

```ts
export * from "./paths.js";
```

Run test/typecheck/lint; commit `feat(sync-core): add canonical paths and collision keys`.

---

### Task 3: Esclusioni

**Files:** Create `packages/sync-core/src/exclusions.ts`, `exclusions.test.ts`; Modify `index.ts`.

- [ ] **Step 1: Test** — `packages/sync-core/src/exclusions.test.ts`:

```ts
import { PLUGIN_ID, PRODUCT_SLUG } from "@kamino/brand";
import { describe, expect, it } from "vitest";
import { classify, DEFAULT_SETTINGS, globMatch, mergeSettings } from "./exclusions.js";

describe("globMatch", () => {
  it("*, **, ?, classes", () => {
    expect(globMatch("*.md", "a.md")).toBe(true);
    expect(globMatch("*.md", "d/a.md")).toBe(false);
    expect(globMatch("**/*.md", "a.md")).toBe(true);
    expect(globMatch("**/*.md", "d/e/a.md")).toBe(true);
    expect(globMatch("d/**", "d/e/a.md")).toBe(true);
    expect(globMatch("d/**", "d")).toBe(true);
    expect(globMatch("d/**", "dd/a")).toBe(false);
    expect(globMatch("a?.md", "ab.md")).toBe(true);
    expect(globMatch("[ab].md", "b.md")).toBe(true);
    expect(globMatch("[!ab].md", "b.md")).toBe(false);
    expect(globMatch("a.md", "A.md")).toBe(false);
    expect(globMatch("(x)+.md", "(x)+.md")).toBe(true);
    expect(globMatch("{config}/x", "{config}/x")).toBe(true);
  });
});

describe("classify", () => {
  it("always excluded, whatever the settings", () => {
    const all = { ...DEFAULT_SETTINGS, patterns: [] };
    for (const p of [
      `{config}/plugins/${PLUGIN_ID}/data.json`,
      "{config}/workspace.json",
      "{config}/workspace-mobile.json",
      "{config}/workspaces.json",
      "{config}/cache/x",
      `notes/a.md.${PRODUCT_SLUG}-tmp`,
    ])
      expect(classify(p, all)).toEqual({ excluded: true, reason: "always" });
  });

  it("config categories (03 §11)", () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { config: { ...DEFAULT_SETTINGS.config, plugins: false } });
    expect(classify("{config}/app.json", s)).toEqual({ excluded: false, category: "base" });
    expect(classify("{config}/themes/x/theme.css", s)).toEqual({ excluded: false, category: "appearance" });
    expect(classify("{config}/hotkeys.json", s)).toEqual({ excluded: false, category: "hotkeys" });
    expect(classify("{config}/community-plugins.json", s)).toEqual({ excluded: false, category: "pluginList" });
    expect(classify("{config}/plugins/other/main.js", s)).toEqual({ excluded: true, reason: "category" });
    expect(classify("notes/a.md", s)).toEqual({ excluded: false, category: "vault" });
  });

  it("default and device patterns", () => {
    expect(classify(".trash/a.md", DEFAULT_SETTINGS)).toEqual({ excluded: true, reason: "pattern" });
    expect(classify("d/.DS_Store", DEFAULT_SETTINGS)).toEqual({ excluded: true, reason: "pattern" });
    const device = mergeSettings(DEFAULT_SETTINGS, { patterns: ["big/**"] });
    expect(classify("big/video.mp4", device)).toEqual({ excluded: true, reason: "pattern" });
    expect(classify(".trash/a.md", device)).toEqual({ excluded: false, category: "vault" });
  });
});
```

- [ ] **Step 2: Implementazione** — `packages/sync-core/src/exclusions.ts`:

```ts
import { PLUGIN_ID, PRODUCT_SLUG } from "@kamino/brand";
import { CONFIG_PREFIX } from "./paths.js";

/** Categories of the configuration folder (03 §11). */
export const CONFIG_CATEGORIES = ["base", "appearance", "hotkeys", "pluginList", "plugins"] as const;
export type ConfigCategory = (typeof CONFIG_CATEGORIES)[number];

export interface SyncSettings {
  config: Record<ConfigCategory, boolean>;
  /** Glob patterns on canonical paths (S-09). */
  patterns: string[];
}

/** Default exclusions outside the configuration folder (editable). */
export const DEFAULT_PATTERNS = [".trash/**", ".git/**", "**/.DS_Store", "**/Thumbs.db", "**/desktop.ini"];
export const DEFAULT_SETTINGS: SyncSettings = {
  config: { base: true, appearance: true, hotkeys: true, pluginList: true, plugins: true },
  patterns: DEFAULT_PATTERNS,
};

/** Never synced, not even if the settings say so. */
export const ALWAYS_EXCLUDED = [
  `${CONFIG_PREFIX}/plugins/${PLUGIN_ID}/**`,
  `${CONFIG_PREFIX}/workspace.json`,
  `${CONFIG_PREFIX}/workspace-mobile.json`,
  `${CONFIG_PREFIX}/workspaces.json`,
  `${CONFIG_PREFIX}/cache/**`,
  `**/*.${PRODUCT_SLUG}-tmp`,
];

/** Vault defaults ⊕ device override: device values replace the vault ones. */
export function mergeSettings(vault: SyncSettings, device: Partial<SyncSettings>): SyncSettings {
  return {
    config: { ...vault.config, ...device.config },
    patterns: device.patterns ?? vault.patterns,
  };
}

/** `*` (no "/"), `**` (zero or more segments), `?`, `[abc]`, `[!abc]`. Case-sensitive. */
export function globToRegExp(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
        continue;
      }
      re += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (c === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end > 0) {
        let body = pattern.slice(i + 1, end);
        const negated = body.startsWith("!");
        if (negated) body = body.slice(1);
        re += `[${negated ? "^" : ""}${body.replace(/[\\\]^]/g, "\\$&")}]`;
        i = end + 1;
        continue;
      }
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  return new RegExp(`${re}$`, "u");
}

const compiled = new Map<string, RegExp>();
export function globMatch(pattern: string, path: string): boolean {
  let re = compiled.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    compiled.set(pattern, re);
  }
  if (re.test(path)) return true;
  // "dir/**" also covers the folder itself.
  return pattern.endsWith("/**") && globMatch(pattern.slice(0, -3), path);
}

function configCategory(rel: string): ConfigCategory {
  if (rel === "appearance.json" || rel.startsWith("themes/") || rel.startsWith("snippets/"))
    return "appearance";
  if (rel === "hotkeys.json") return "hotkeys";
  if (rel === "community-plugins.json") return "pluginList";
  if (rel.startsWith("plugins/")) return "plugins";
  return "base";
}

export type Classification =
  | { excluded: false; category: ConfigCategory | "vault" }
  | { excluded: true; reason: "always" | "category" | "pattern" };

export function classify(path: string, settings: SyncSettings): Classification {
  if (ALWAYS_EXCLUDED.some((p) => globMatch(p, path))) return { excluded: true, reason: "always" };
  const pattern = settings.patterns.some((p) => globMatch(p, path));
  if (path === CONFIG_PREFIX || path.startsWith(`${CONFIG_PREFIX}/`)) {
    const category = configCategory(path.slice(CONFIG_PREFIX.length + 1));
    if (!settings.config[category]) return { excluded: true, reason: "category" };
    return pattern ? { excluded: true, reason: "pattern" } : { excluded: false, category };
  }
  return pattern ? { excluded: true, reason: "pattern" } : { excluded: false, category: "vault" };
}
```

`index.ts`: `export * from "./exclusions.js";`. Run test/typecheck/lint; commit `feat(sync-core): add exclusion rules`.

---

### Task 4: Arbitro e archivio in memoria

**Files:** Create `packages/sync-core/src/arbiter.ts`, `store.ts`, `arbiter.test.ts`, `store.test.ts`; Modify `index.ts`.

- [ ] **Step 1: Test dell'arbitro** — `packages/sync-core/src/arbiter.test.ts`:

```ts
import type { Op } from "@kamino/protocol";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "./store.js";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
let n = 0;
const id = () => `x${++n}`;
const put = (fileId: string, path: string, base: string | null, hash = H1, versionId = id()): Op => ({
  type: "put", opId: id(), fileId, versionId, path, baseVersionId: base, contentHash: hash, size: 1, mtime: 0,
});
function store() {
  const s = new MemoryStore();
  s.blobs.add(H1);
  s.blobs.add(H2);
  return s;
}
const one = (s: MemoryStore, op: Op, device = "d1") => s.commit([op], device).results[0]!;

describe("arbiter: put (03 §5.3)", () => {
  it("creates, updates, and repeats as duplicate", () => {
    const s = store();
    const create = put("f", "a.md", null);
    const r1 = one(s, create);
    expect(r1).toMatchObject({ status: "accepted", seq: 1, path: "a.md" });
    expect(one(s, create)).toEqual({ status: "duplicate", original: r1 });
    expect(s.head).toBe(1);
    const v1 = create.type === "put" ? create.versionId : "";
    expect(one(s, put("f", "a.md", v1, H2))).toMatchObject({ status: "accepted", seq: 2 });
  });

  it("blob first, canonical and allowed paths only", () => {
    const s = new MemoryStore();
    expect(one(s, put("f", "a.md", null))).toEqual({ status: "rejected", code: "blob_missing" });
    s.blobs.add(H1);
    expect(one(s, put("f", "é.md", null))).toEqual({ status: "rejected", code: "path_invalid" });
    expect(one(s, put("f", "{config}/workspace.json", null))).toEqual({ status: "rejected", code: "path_forbidden" });
  });

  it("rejections are not recorded: the same op succeeds later", () => {
    const s = new MemoryStore();
    const op = put("f", "a.md", null);
    expect(one(s, op).status).toBe("rejected");
    s.blobs.add(H1);
    expect(one(s, op).status).toBe("accepted");
  });

  it("both_created on a taken collision key; concurrent_edit on a stale base; candidates pile up", () => {
    const s = store();
    const a = put("f", "Nota.md", null);
    one(s, a);
    const both = one(s, put("g", "nota.md", null, H2));
    expect(both).toMatchObject({ status: "conflict" });
    const stale1 = one(s, put("f", "Nota.md", "old", H2));
    expect(stale1).toMatchObject({ status: "conflict" });
    if (both.status !== "conflict" || stale1.status !== "conflict") throw new Error();
    expect(stale1.conflictId).toBe(both.conflictId);
    expect(s.conflicts.get(both.conflictId)!.candidates).toHaveLength(2);
    expect([...s.versions.values()].filter((v) => v.hash === H2)).toHaveLength(2);
  });

  it("an edit resurrects a deleted file, next to it if the path was taken (C-06)", () => {
    const s = store();
    const a = put("f", "a.md", null);
    one(s, a);
    const v1 = a.type === "put" ? a.versionId : "";
    one(s, { type: "delete", opId: id(), fileId: "f", baseVersionId: v1 });
    one(s, put("g", "A.md", null));
    const r = one(s, put("f", "a.md", "whatever", H2));
    expect(r).toMatchObject({ status: "accepted", path: "a (1).md" });
    expect(s.journal.at(-1)!.type).toBe("file_restored");
  });
});

describe("arbiter: move, delete, mkdir", () => {
  it("move: first arrived wins, taken path rejected, case-only rename accepted", () => {
    const s = store();
    one(s, put("f", "a.md", null));
    one(s, put("g", "b.md", null));
    expect(one(s, { type: "move", opId: id(), fileId: "f", fromPath: "a.md", toPath: "c.md" })).toMatchObject({ status: "accepted", path: "c.md" });
    expect(one(s, { type: "move", opId: id(), fileId: "f", fromPath: "a.md", toPath: "d.md" })).toEqual({ status: "rejected", code: "moved_elsewhere", path: "c.md" });
    expect(one(s, { type: "move", opId: id(), fileId: "f", fromPath: "c.md", toPath: "B.md" })).toEqual({ status: "rejected", code: "path_taken", path: "b.md" });
    expect(one(s, { type: "move", opId: id(), fileId: "f", fromPath: "c.md", toPath: "C.md" })).toMatchObject({ status: "accepted", path: "C.md" });
  });

  it("delete: idempotent; stale base refused", () => {
    const s = store();
    const a = put("f", "a.md", null);
    one(s, a);
    expect(one(s, { type: "delete", opId: id(), fileId: "f", baseVersionId: "old" })).toEqual({ status: "rejected", code: "modified_since" });
    const v1 = a.type === "put" ? a.versionId : "";
    expect(one(s, { type: "delete", opId: id(), fileId: "f", baseVersionId: v1 })).toMatchObject({ status: "accepted" });
    const head = s.head;
    expect(one(s, { type: "delete", opId: id(), fileId: "f", baseVersionId: v1 })).toMatchObject({ status: "accepted", seq: head });
    expect(s.head).toBe(head);
  });

  it("mkdir: same folder twice merges; a folder with live files can't be deleted", () => {
    const s = store();
    expect(one(s, { type: "mkdir", opId: id(), fileId: "d1", path: "D" })).toMatchObject({ status: "accepted", fileId: "d1" });
    expect(one(s, { type: "mkdir", opId: id(), fileId: "d2", path: "d" })).toMatchObject({ status: "accepted", fileId: "d1", path: "D" });
    one(s, put("f", "D/a.md", null));
    expect(one(s, { type: "delete", opId: id(), fileId: "d1", baseVersionId: null })).toEqual({ status: "rejected", code: "modified_since" });
    expect(one(s, put("g", "d", null))).toEqual({ status: "rejected", code: "path_taken", path: "D" });
  });
});
```

- [ ] **Step 2: Test dell'archivio (proprietà)** — `packages/sync-core/src/store.test.ts`:

```ts
import type { Op } from "@kamino/protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkInvariants, MemoryStore } from "./store.js";

const HASHES = ["1", "2", "3"].map((c) => c.repeat(64));
const PATHS = ["a.md", "A.md", "b.md", "d/c.md", "D/c.md", "d"];

/** Random ops on a small universe: ids and paths collide on purpose. */
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    type: fc.constant("put" as const),
    opId: fc.constantFrom("o1", "o2", "o3", "o4", "o5", "o6", "o7", "o8"),
    fileId: fc.constantFrom("f1", "f2", "f3"),
    versionId: fc.constantFrom("v1", "v2", "v3", "v4"),
    path: fc.constantFrom(...PATHS),
    baseVersionId: fc.constantFrom(null, "v1", "v2", "v3", "v4"),
    contentHash: fc.constantFrom(...HASHES),
    size: fc.constant(1),
    mtime: fc.constant(0),
  }),
  fc.record({
    type: fc.constant("move" as const),
    opId: fc.constantFrom("m1", "m2", "m3", "m4"),
    fileId: fc.constantFrom("f1", "f2", "f3", "dd"),
    fromPath: fc.constantFrom(...PATHS),
    toPath: fc.constantFrom(...PATHS),
  }),
  fc.record({
    type: fc.constant("delete" as const),
    opId: fc.constantFrom("x1", "x2", "x3"),
    fileId: fc.constantFrom("f1", "f2", "f3", "dd"),
    baseVersionId: fc.constantFrom(null, "v1", "v2", "v3", "v4"),
  }),
  fc.record({
    type: fc.constant("mkdir" as const),
    opId: fc.constantFrom("k1", "k2"),
    fileId: fc.constantFrom("dd", "de"),
    path: fc.constantFrom(...PATHS),
  }),
);

describe("MemoryStore", () => {
  it("invariants hold for any op sequence; replaying a batch changes nothing", () => {
    fc.assert(
      fc.property(fc.array(fc.array(opArb, { minLength: 1, maxLength: 5 }), { maxLength: 20 }), (batches) => {
        const s = new MemoryStore();
        for (const h of HASHES) s.blobs.add(h);
        for (const batch of batches) {
          s.commit(batch, "d1");
          expect(checkInvariants(s)).toEqual([]);
        }
        const head = s.head;
        const snapshot = JSON.stringify(s.snapshot());
        for (const batch of batches) {
          for (const r of s.commit(batch, "d1").results) expect(r.status === "accepted" || r.status === "conflict").toBe(false);
        }
        expect(s.head).toBe(head);
        expect(JSON.stringify(s.snapshot())).toBe(snapshot);
      }),
      { numRuns: 300 },
    );
  });
});
```

Nota: al replay ogni op già registrata torna `duplicate`, quelle rifiutate restano rifiutate o vengono accettate solo se nel frattempo è cambiato qualcosa — ma lo stato è lo stesso del primo giro, quindi rifiutate di nuovo. Se il test trova un controesempio (es. un'op rifiutata al primo giro e accettata al secondo perché un'op successiva del primo giro ha liberato il path), la proprietà va ristretta a "nessuna op registrata cambia esito" e il caso documentato nel test.

- [ ] **Step 3: Implementazione dell'arbitro** — `packages/sync-core/src/arbiter.ts`:

```ts
import type {
  ConflictResult,
  DeleteOp,
  ErrorCode,
  FinalResult,
  JournalType,
  MkdirOp,
  MoveOp,
  Op,
  PutOp,
  RejectedResult,
} from "@kamino/protocol";
import { ALWAYS_EXCLUDED, globMatch } from "./exclusions.js";
import { collisionKey, conflictSiblingPath, isCanonical } from "./paths.js";

/** Server-side file or folder (current state). */
export interface FileRecord {
  fileId: string;
  kind: "file" | "folder";
  path: string;
  /** Null for folders. */
  headVersionId: string | null;
  headHash: string | null;
  size: number;
  mtime: number;
  deleted: boolean;
}

export interface OpenConflict {
  conflictId: string;
  fileId: string;
  candidates: string[];
}

/**
 * What the rules read. The server (M1c) implements it with queries inside the commit
 * transaction, with the vault row locked; MemoryStore implements it in memory.
 */
export interface ArbiterView {
  recorded(opId: string): FinalResult | undefined;
  file(fileId: string): FileRecord | undefined;
  /** Live (not deleted) file or folder with this collision key. */
  liveAt(key: string): FileRecord | undefined;
  openConflict(fileId: string): OpenConflict | undefined;
  hasLiveDescendants(path: string): boolean;
  blobPresent(hash: string): boolean;
}

export interface JournalDraft {
  type: JournalType;
  fileId: string;
  kind: "file" | "folder";
  path: string;
  versionId?: string;
  contentHash?: string;
  size?: number;
  mtime?: number;
  conflictId?: string;
}

export type Mutation =
  | { type: "createFile"; file: FileRecord }
  | { type: "version"; fileId: string; versionId: string; hash: string; size: number; mtime: number }
  /** New current version; also clears `deleted`. */
  | { type: "head"; fileId: string; versionId: string; hash: string; size: number; mtime: number }
  | { type: "path"; fileId: string; path: string }
  | { type: "tombstone"; fileId: string }
  | { type: "undelete"; fileId: string }
  | {
      type: "openConflict";
      conflictId: string;
      fileId: string;
      kind: "concurrent_edit" | "both_created";
      baseVersionId: string | null;
      headVersionId: string;
      candidate: string;
    }
  | { type: "addCandidate"; conflictId: string; versionId: string }
  | { type: "journal"; entry: JournalDraft };

/** Accepted results get their `seq` from the store (the op's journal entry, or the head). */
export type DraftResult =
  | { status: "accepted"; fileId: string; versionId?: string; path: string }
  | ConflictResult
  | RejectedResult
  | { status: "duplicate"; original: FinalResult };

export interface Decision {
  result: DraftResult;
  mutations: Mutation[];
}

export interface ArbiterCtx {
  newId(): string;
}

const reject = (code: ErrorCode, path?: string): Decision => ({
  result: path === undefined ? { status: "rejected", code } : { status: "rejected", code, path },
  mutations: [],
});

const accept = (fileId: string, path: string, mutations: Mutation[], versionId?: string): Decision => ({
  result: versionId === undefined ? { status: "accepted", fileId, path } : { status: "accepted", fileId, versionId, path },
  mutations,
});

function pathError(path: string): ErrorCode | null {
  if (!isCanonical(path)) return "path_invalid";
  if (ALWAYS_EXCLUDED.some((p) => globMatch(p, path))) return "path_forbidden";
  return null;
}

function freeSibling(view: ArbiterView, path: string, fileId: string): string {
  for (let n = 1; ; n++) {
    const candidate = conflictSiblingPath(path, n);
    const other = view.liveAt(collisionKey(candidate));
    if (!other || other.fileId === fileId) return candidate;
  }
}

/** The commit rules of 03 §5.3, one op at a time. */
export function decide(view: ArbiterView, op: Op, ctx: ArbiterCtx): Decision {
  const recorded = view.recorded(op.opId);
  if (recorded) return { result: { status: "duplicate", original: recorded }, mutations: [] };
  switch (op.type) {
    case "put":
      return decidePut(view, op, ctx);
    case "move":
      return decideMove(view, op);
    case "delete":
      return decideDelete(view, op);
    case "mkdir":
      return decideMkdir(view, op);
  }
}

function versionOf(fileId: string, op: PutOp): Mutation {
  return { type: "version", fileId, versionId: op.versionId, hash: op.contentHash, size: op.size, mtime: op.mtime };
}

function headOf(fileId: string, op: PutOp): Mutation {
  return { type: "head", fileId, versionId: op.versionId, hash: op.contentHash, size: op.size, mtime: op.mtime };
}

function putJournal(type: JournalType, fileId: string, path: string, op: PutOp): Mutation {
  return {
    type: "journal",
    entry: { type, fileId, kind: "file", path, versionId: op.versionId, contentHash: op.contentHash, size: op.size, mtime: op.mtime },
  };
}

/** The version is kept as a candidate: nothing is ever thrown away (C-02). */
function conflictOn(
  view: ArbiterView,
  target: FileRecord,
  kind: "concurrent_edit" | "both_created",
  op: PutOp,
  ctx: ArbiterCtx,
): Decision {
  const headVersionId = target.headVersionId ?? "";
  const version = versionOf(target.fileId, op);
  const open = view.openConflict(target.fileId);
  if (open)
    return {
      result: { status: "conflict", conflictId: open.conflictId, headVersionId },
      mutations: [version, { type: "addCandidate", conflictId: open.conflictId, versionId: op.versionId }],
    };
  const conflictId = ctx.newId();
  return {
    result: { status: "conflict", conflictId, headVersionId },
    mutations: [
      version,
      { type: "openConflict", conflictId, fileId: target.fileId, kind, baseVersionId: op.baseVersionId, headVersionId, candidate: op.versionId },
      { type: "journal", entry: { type: "conflict_opened", fileId: target.fileId, kind: "file", path: target.path, conflictId } },
    ],
  };
}

function decidePut(view: ArbiterView, op: PutOp, ctx: ArbiterCtx): Decision {
  if (!view.blobPresent(op.contentHash)) return reject("blob_missing");
  const f = view.file(op.fileId);
  if (!f) {
    if (op.baseVersionId !== null) return reject("not_found");
    const bad = pathError(op.path);
    if (bad) return reject(bad);
    const other = view.liveAt(collisionKey(op.path));
    if (other)
      return other.kind === "folder" ? reject("path_taken", other.path) : conflictOn(view, other, "both_created", op, ctx);
    const file: FileRecord = {
      fileId: op.fileId, kind: "file", path: op.path, headVersionId: op.versionId,
      headHash: op.contentHash, size: op.size, mtime: op.mtime, deleted: false,
    };
    return accept(op.fileId, op.path, [{ type: "createFile", file }, versionOf(op.fileId, op), putJournal("file_put", op.fileId, op.path, op)], op.versionId);
  }
  if (f.kind === "folder") return reject("path_invalid");
  if (f.deleted) {
    // C-06: an edit wins over a deletion. Restored at its path, or next to it if taken meanwhile.
    const other = view.liveAt(collisionKey(f.path));
    const path = other && other.fileId !== f.fileId ? freeSibling(view, f.path, f.fileId) : f.path;
    const mutations: Mutation[] = [versionOf(f.fileId, op), headOf(f.fileId, op)];
    if (path !== f.path) mutations.push({ type: "path", fileId: f.fileId, path });
    mutations.push(putJournal("file_restored", f.fileId, path, op));
    return accept(f.fileId, path, mutations, op.versionId);
  }
  if (op.baseVersionId === f.headVersionId)
    return accept(f.fileId, f.path, [versionOf(f.fileId, op), headOf(f.fileId, op), putJournal("file_put", f.fileId, f.path, op)], op.versionId);
  return conflictOn(view, f, "concurrent_edit", op, ctx);
}

function decideMove(view: ArbiterView, op: MoveOp): Decision {
  const f = view.file(op.fileId);
  if (!f || f.deleted) return reject("not_found");
  if (f.path !== op.fromPath) return reject("moved_elsewhere", f.path);
  const bad = pathError(op.toPath);
  if (bad) return reject(bad);
  const other = view.liveAt(collisionKey(op.toPath));
  if (other && other.fileId !== f.fileId) return reject("path_taken", other.path);
  return accept(f.fileId, op.toPath, [
    { type: "path", fileId: f.fileId, path: op.toPath },
    { type: "journal", entry: { type: "file_moved", fileId: f.fileId, kind: f.kind, path: op.toPath } },
  ]);
}

function decideDelete(view: ArbiterView, op: DeleteOp): Decision {
  const f = view.file(op.fileId);
  if (!f) return reject("not_found");
  if (f.deleted) return accept(f.fileId, f.path, []);
  if (f.kind === "folder") {
    if (view.hasLiveDescendants(f.path)) return reject("modified_since");
    return accept(f.fileId, f.path, [
      { type: "tombstone", fileId: f.fileId },
      { type: "journal", entry: { type: "folder_deleted", fileId: f.fileId, kind: "folder", path: f.path } },
    ]);
  }
  if (op.baseVersionId !== f.headVersionId) return reject("modified_since");
  return accept(f.fileId, f.path, [
    { type: "tombstone", fileId: f.fileId },
    { type: "journal", entry: { type: "file_deleted", fileId: f.fileId, kind: "file", path: f.path } },
  ]);
}

function decideMkdir(view: ArbiterView, op: MkdirOp): Decision {
  const f = view.file(op.fileId);
  if (f && f.kind !== "folder") return reject("path_invalid");
  if (f && !f.deleted) return accept(f.fileId, f.path, []);
  const bad = pathError(op.path);
  if (bad) return reject(bad);
  const other = view.liveAt(collisionKey(op.path));
  // 03 §9.4: two folders with the same path merge.
  if (other) return other.kind === "folder" ? accept(other.fileId, other.path, []) : reject("path_taken", other.path);
  const journal: Mutation = { type: "journal", entry: { type: "folder_created", fileId: op.fileId, kind: "folder", path: op.path } };
  if (f) {
    const mutations: Mutation[] = [{ type: "undelete", fileId: f.fileId }];
    if (f.path !== op.path) mutations.push({ type: "path", fileId: f.fileId, path: op.path });
    return accept(f.fileId, op.path, [...mutations, journal]);
  }
  const folder: FileRecord = {
    fileId: op.fileId, kind: "folder", path: op.path, headVersionId: null, headHash: null, size: 0, mtime: 0, deleted: false,
  };
  return accept(op.fileId, op.path, [{ type: "createFile", file: folder }, journal]);
}
```

- [ ] **Step 4: Implementazione dell'archivio** — `packages/sync-core/src/store.ts`:

```ts
import type { CommitResponse, FinalResult, JournalEntry, Op, OpResult, Snapshot } from "@kamino/protocol";
import { decide, type ArbiterView, type FileRecord, type Mutation } from "./arbiter.js";
import { collisionKey } from "./paths.js";

export interface StoredVersion {
  fileId: string;
  hash: string;
  size: number;
  mtime: number;
}

export interface StoredConflict {
  conflictId: string;
  fileId: string;
  kind: "concurrent_edit" | "both_created";
  baseVersionId: string | null;
  headVersionId: string;
  candidates: string[];
}

/** In-memory server: the simulator's backend and, in M1c, the oracle for the real server's tests. */
export class MemoryStore {
  head = 0;
  readonly files = new Map<string, FileRecord>();
  readonly versions = new Map<string, StoredVersion>();
  readonly conflicts = new Map<string, StoredConflict>();
  readonly journal: JournalEntry[] = [];
  readonly results = new Map<string, FinalResult>();
  readonly blobs = new Set<string>();
  readonly cursors = new Map<string, number>();
  private ids = 0;

  private readonly view: ArbiterView = {
    recorded: (opId) => this.results.get(opId),
    file: (fileId) => this.files.get(fileId),
    liveAt: (key) => {
      for (const f of this.files.values()) if (!f.deleted && collisionKey(f.path) === key) return f;
      return undefined;
    },
    // In M1a every stored conflict is open (resolution comes with M3).
    openConflict: (fileId) => {
      for (const c of this.conflicts.values()) if (c.fileId === fileId) return c;
      return undefined;
    },
    hasLiveDescendants: (path) => {
      const prefix = `${collisionKey(path)}/`;
      for (const f of this.files.values()) if (!f.deleted && collisionKey(f.path).startsWith(prefix)) return true;
      return false;
    },
    blobPresent: (hash) => this.blobs.has(hash),
  };

  commit(ops: readonly Op[], deviceId: string): CommitResponse {
    return { results: ops.map((op) => this.apply(op, deviceId)), head: this.head };
  }

  private apply(op: Op, deviceId: string): OpResult {
    const decision = decide(this.view, op, { newId: () => `srv-${++this.ids}` });
    let seq = this.head;
    for (const m of decision.mutations) {
      if (m.type === "journal") {
        seq = ++this.head;
        this.journal.push({ ...m.entry, seq, opId: op.opId, deviceId, at: new Date(0).toISOString() });
      } else this.mutate(m);
    }
    const r = decision.result;
    if (r.status === "accepted") {
      const result: FinalResult = { ...r, seq };
      this.results.set(op.opId, result);
      return result;
    }
    if (r.status === "conflict") this.results.set(op.opId, r);
    return r;
  }

  private mutate(m: Exclude<Mutation, { type: "journal" }>): void {
    switch (m.type) {
      case "createFile":
        this.files.set(m.file.fileId, { ...m.file });
        return;
      case "version":
        this.versions.set(m.versionId, { fileId: m.fileId, hash: m.hash, size: m.size, mtime: m.mtime });
        return;
      case "head": {
        const f = this.files.get(m.fileId)!;
        Object.assign(f, { headVersionId: m.versionId, headHash: m.hash, size: m.size, mtime: m.mtime, deleted: false });
        return;
      }
      case "path":
        this.files.get(m.fileId)!.path = m.path;
        return;
      case "tombstone":
        this.files.get(m.fileId)!.deleted = true;
        return;
      case "undelete":
        this.files.get(m.fileId)!.deleted = false;
        return;
      case "openConflict":
        this.conflicts.set(m.conflictId, {
          conflictId: m.conflictId, fileId: m.fileId, kind: m.kind, baseVersionId: m.baseVersionId,
          headVersionId: m.headVersionId, candidates: [m.candidate],
        });
        return;
      case "addCandidate":
        this.conflicts.get(m.conflictId)!.candidates.push(m.versionId);
        return;
    }
  }

  changes(after: number, limit = 1000): { entries: JournalEntry[]; head: number; hasMore: boolean } {
    const all = this.journal.filter((e) => e.seq > after);
    return { entries: all.slice(0, limit), head: this.head, hasMore: all.length > limit };
  }

  snapshot(): Snapshot {
    return {
      head: this.head,
      files: [...this.files.values()]
        .filter((f) => !f.deleted)
        .map((f) => ({ fileId: f.fileId, kind: f.kind, path: f.path, versionId: f.headVersionId, contentHash: f.headHash, size: f.size, mtime: f.mtime })),
      openConflicts: [...this.conflicts.values()].map((c) => ({ conflictId: c.conflictId, fileId: c.fileId })),
    };
  }

  /** Whether this content is on the server: as a version, current or old, or as a conflict candidate. */
  hasContent(hash: string): boolean {
    for (const v of this.versions.values()) if (v.hash === hash) return true;
    return false;
  }
}

/** Broken invariants, as readable strings (empty = fine). */
export function checkInvariants(s: MemoryStore): string[] {
  const out: string[] = [];
  const keys = new Map<string, string>();
  for (const f of s.files.values()) {
    if (f.deleted) continue;
    const key = collisionKey(f.path);
    const other = keys.get(key);
    if (other) out.push(`two live files share a collision key: ${other} and ${f.fileId}`);
    keys.set(key, f.fileId);
    if (f.kind === "file") {
      const v = f.headVersionId === null ? undefined : s.versions.get(f.headVersionId);
      if (!v || v.hash !== f.headHash) out.push(`head of ${f.fileId} is not a stored version`);
    }
  }
  s.journal.forEach((e, i) => {
    if (e.seq !== i + 1) out.push(`journal seq ${e.seq} at position ${i + 1}`);
  });
  if (s.journal.length !== s.head) out.push(`head ${s.head} but ${s.journal.length} entries`);
  const perFile = new Set<string>();
  for (const c of s.conflicts.values()) {
    if (perFile.has(c.fileId)) out.push(`two open conflicts on ${c.fileId}`);
    perFile.add(c.fileId);
    for (const v of c.candidates) if (!s.versions.has(v)) out.push(`candidate ${v} not stored`);
  }
  return out;
}
```

`index.ts`: `export * from "./arbiter.js"; export * from "./store.js";`. Run test/typecheck/lint; commit `feat(sync-core): add the arbiter and the in-memory store`.

---

### Task 5: Client (riduttore del dispositivo)

**Files:** Create `packages/sync-core/src/client.ts`, `client.test.ts`; Modify `index.ts`.

**Produces:** `initialState(config)`, `step(state, event, env)`, `nextOps(state, env)`, `retryDelay(attempt, random)`; tipi `ClientState`, `Entry`, `ClientEvent`, `Effect`, `ClientConfig`, `ScanItem`.

- [ ] **Step 1: Test** — `packages/sync-core/src/client.test.ts`:

```ts
import type { Op, OpResult } from "@kamino/protocol";
import { describe, expect, it } from "vitest";
import { initialState, retryDelay, step, type ClientEvent, type ClientState, type Effect } from "./client.js";
import { DEFAULT_SETTINGS } from "./exclusions.js";
import { MemoryStore } from "./store.js";

let n = 0;
const env = { newId: () => `id${++n}` };
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const scanItem = (path: string, hash: string) => ({ path, hash, size: 1, mtime: 0 });

function client(platform: "linux" | "windows" = "linux"): ClientState {
  return initialState({ deviceId: "dev", platform, configDir: ".obsidian", settings: DEFAULT_SETTINGS, batchSize: 500 });
}
function run(s: ClientState, e: ClientEvent) {
  return step(s, e, env);
}
const ofType = <T extends Effect["type"]>(fx: Effect[], t: T) => fx.filter((f): f is Extract<Effect, { type: T }> => f.type === t);

/** A joined client (empty snapshot already applied). */
function joined(platform: "linux" | "windows" = "linux"): ClientState {
  let s = client(platform);
  s = run(s, { type: "sync", scan: [] }).state;
  const req = s.vol.requestId!;
  return run(s, { type: "snapshotResult", requestId: req, snapshot: { head: 0, files: [], openConflicts: [] } }).state;
}

/** Push with a store, return the state after the response. */
function push(s: ClientState, store: MemoryStore, scan: ReturnType<typeof scanItem>[]) {
  const r1 = run(s, { type: "sync", scan });
  const p = ofType(r1.effects, "push")[0];
  if (!p) return { state: r1.state, effects: r1.effects, ops: [] as Op[] };
  for (const h of p.hashes) store.blobs.add(h);
  const res = store.commit(p.ops, "dev");
  const r2 = run(r1.state, { type: "pushResult", requestId: p.requestId, results: res.results, head: res.head });
  return { state: r2.state, effects: [...r1.effects, ...r2.effects], ops: p.ops };
}

describe("client", () => {
  it("persist always comes first (write-ahead)", () => {
    const r = run(joined(), { type: "sync", scan: [scanItem("a.md", H1)] });
    expect(r.effects[0]).toEqual({ type: "persist" });
  });

  it("joining an empty server uploads everything (V-05)", () => {
    let s = client();
    let r = run(s, { type: "sync", scan: [scanItem("a.md", H1)] });
    const snap = ofType(r.effects, "snapshot")[0]!;
    r = run(r.state, { type: "snapshotResult", requestId: snap.requestId, snapshot: { head: 0, files: [], openConflicts: [] } });
    const p = ofType(r.effects, "push")[0]!;
    expect(p.ops).toMatchObject([{ type: "put", path: "a.md", baseVersionId: null, contentHash: H1 }]);
    s = r.state;
    expect(s.durable.sent).toHaveLength(1);
  });

  it("new, modified, renamed and deleted files become ops; accepted results update the index", () => {
    const store = new MemoryStore();
    let { state: s, ops } = push(joined(), store, [scanItem("a.md", H1)]);
    expect(ops).toMatchObject([{ type: "put", baseVersionId: null }]);
    const fileId = ops[0]!.fileId;
    expect(s.durable.index[fileId]).toMatchObject({ confirmed: true, baseHash: H1, remotePath: "a.md" });
    expect(s.durable.sent).toEqual([]);

    ({ state: s, ops } = push(s, store, [scanItem("a.md", H2)]));
    expect(ops).toMatchObject([{ type: "put", baseVersionId: (ops[0] as { versionId?: string }).versionId === undefined ? null : expect.any(String) }]);
    expect(store.files.get(fileId)!.headHash).toBe(H2);

    s = run(s, { type: "localRename", from: "a.md", to: "b.md" }).state;
    ({ state: s, ops } = push(s, store, [scanItem("b.md", H2)]));
    expect(ops).toMatchObject([{ type: "move", fromPath: "a.md", toPath: "b.md" }]);

    ({ state: s, ops } = push(s, store, []));
    expect(ops).toMatchObject([{ type: "delete" }]);
    expect(s.durable.index[fileId]).toBeUndefined();
    expect(store.files.get(fileId)!.deleted).toBe(true);
  });

  it("an op with unknown outcome is resent identical (same opId)", () => {
    const store = new MemoryStore();
    const r1 = run(joined(), { type: "sync", scan: [scanItem("a.md", H1)] });
    const p1 = ofType(r1.effects, "push")[0]!;
    let s = run(r1.state, { type: "networkError", requestId: p1.requestId }).state;
    const r2 = run(s, { type: "sync", scan: [scanItem("a.md", H2)] });
    const p2 = ofType(r2.effects, "push")[0]!;
    expect(p2.ops).toEqual(p1.ops);
    store.blobs.add(H1);
    const res = store.commit(p2.ops, "dev");
    s = run(r2.state, { type: "pushResult", requestId: p2.requestId, results: res.results, head: res.head }).state;
    const again = ofType(run(s, { type: "sync", scan: [scanItem("a.md", H2)] }).effects, "push")[0]!;
    expect(again.ops).toMatchObject([{ type: "put", contentHash: H2 }]);
  });

  it("a conflict marks the file and never overwrites the local copy", () => {
    let s = joined();
    const r = run(s, { type: "sync", scan: [scanItem("a.md", H1)] });
    const p = ofType(r.effects, "push")[0]!;
    const conflict: OpResult = { status: "conflict", conflictId: "c1", headVersionId: "vx" };
    s = run(r.state, { type: "pushResult", requestId: p.requestId, results: [conflict], head: 5 }).state;
    const e = Object.values(s.durable.index)[0]!;
    expect(e.conflictId).toBe("c1");
    const pull = run(s, { type: "sync", scan: [scanItem("a.md", H2)] });
    expect(ofType(pull.effects, "push")).toEqual([]);
    const req = pull.state.vol.requestId!;
    const after = run(pull.state, {
      type: "pullResult", requestId: req, hasMore: false, head: 6,
      entries: [{ seq: 6, type: "file_put", fileId: e.fileId, versionId: "v9", path: "a.md", contentHash: H1, deviceId: "other", at: "" }],
    });
    expect(ofType(after.effects, "write")).toEqual([]);
  });

  it("remote put: written when unmodified (expect = local hash), held back when modified", () => {
    const store = new MemoryStore();
    const { state } = push(joined(), store, [scanItem("a.md", H1)]);
    const e = Object.values(state.durable.index)[0]!;
    const entry = { seq: 9, type: "file_put", fileId: e.fileId, versionId: "v9", path: "a.md", contentHash: H2, deviceId: "other", at: "" };
    const pullFrom = (s: ClientState, scan: ReturnType<typeof scanItem>[]) => {
      const r = run(s, { type: "sync", scan });
      return run(r.state, { type: "pullResult", requestId: r.state.vol.requestId!, entries: [entry], head: 9, hasMore: false });
    };
    const clean = pullFrom(state, [scanItem("a.md", H1)]);
    expect(ofType(clean.effects, "write")).toMatchObject([{ path: "a.md", hash: H2, expect: H1 }]);
    expect(clean.state.durable.index[e.fileId]!.pendingWrite).toEqual({ versionId: "v9", hash: H2 });
    const written = run(clean.state, { type: "written", fileId: e.fileId, ok: true }).state;
    expect(written.durable.index[e.fileId]).toMatchObject({ localHash: H2, baseHash: H2, base: "v9", pendingWrite: null });
    expect(ofType(clean.effects, "ack")).toEqual([{ type: "ack", seq: 9 }]);

    const edited = { ...state, durable: { ...state.durable, index: { ...state.durable.index } } };
    const dirty = run(edited, { type: "sync", scan: [scanItem("a.md", "3".repeat(64))] });
    const held = run(dirty.state, { type: "networkError", requestId: dirty.state.vol.requestId! }).state;
    const r = run(held, { type: "sync", scan: [scanItem("a.md", "3".repeat(64))] });
    const afterPull = run(run(r.state, { type: "networkError", requestId: r.state.vol.requestId! }).state, { type: "sync", scan: [scanItem("a.md", "3".repeat(64))] });
    expect(afterPull.state.durable.index[e.fileId]!.localHash).toBe("3".repeat(64));
  });

  it("remote delete: trash only if unmodified, with expect", () => {
    const store = new MemoryStore();
    const { state } = push(joined(), store, [scanItem("a.md", H1)]);
    const e = Object.values(state.durable.index)[0]!;
    const r = run(state, { type: "sync", scan: [scanItem("a.md", H1)] });
    const del = { seq: 4, type: "file_deleted", fileId: e.fileId, path: "a.md", deviceId: "other", at: "" };
    const out = run(r.state, { type: "pullResult", requestId: r.state.vol.requestId!, entries: [del], head: 4, hasMore: false });
    expect(ofType(out.effects, "trash")).toMatchObject([{ path: "a.md", expect: H1 }]);
    const done = run(out.state, { type: "trashed", fileId: e.fileId, ok: true }).state;
    expect(done.durable.index[e.fileId]).toBeUndefined();
  });

  it("remote file on a path not representable here is never written", () => {
    const s = joined("windows");
    const r = run(s, { type: "sync", scan: [] });
    const entry = { seq: 1, type: "file_put", fileId: "f", versionId: "v", path: "con.md", contentHash: H1, deviceId: "other", at: "" };
    const out = run(r.state, { type: "pullResult", requestId: r.state.vol.requestId!, entries: [entry], head: 1, hasMore: false });
    expect(ofType(out.effects, "write")).toEqual([]);
    expect(out.state.durable.index["f"]!.unavailable).toBe("reserved_name");
  });

  it("unknown journal types: skipped when ignorable, otherwise sync stops", () => {
    const s = joined();
    const r = run(s, { type: "sync", scan: [] });
    const base = { fileId: "f", path: "a.md", deviceId: "other", at: "" };
    const ok = run(r.state, { type: "pullResult", requestId: r.state.vol.requestId!, entries: [{ ...base, seq: 1, type: "future", ignorable: true }], head: 1, hasMore: false });
    expect(ok.state.durable.cursor).toBe(1);
    const r2 = run(s, { type: "sync", scan: [] });
    const stop = run(r2.state, { type: "pullResult", requestId: r2.state.vol.requestId!, entries: [{ ...base, seq: 1, type: "future" }], head: 1, hasMore: false });
    expect(stop.state.durable.cursor).toBe(0);
    expect(stop.state.vol.stopped).toBe("update_required");
  });

  it("D-07: joining with local content never overwrites", () => {
    let s = client();
    const r = run(s, { type: "sync", scan: [scanItem("same.md", H1), scanItem("diff.md", H1), scanItem("mine.md", H1)] });
    const snap = ofType(r.effects, "snapshot")[0]!;
    const f = (fileId: string, path: string, hash: string) => ({ fileId, kind: "file" as const, path, versionId: `v-${fileId}`, contentHash: hash, size: 1, mtime: 0 });
    const out = run(r.state, {
      type: "snapshotResult", requestId: snap.requestId,
      snapshot: { head: 3, files: [f("s", "same.md", H1), f("d", "diff.md", H2), f("t", "theirs.md", H2)], openConflicts: [] },
    });
    s = out.state;
    expect(s.durable.index["s"]).toMatchObject({ confirmed: true, baseHash: H1, localHash: H1 });
    expect(ofType(out.effects, "write")).toMatchObject([{ path: "theirs.md", hash: H2, expect: null }]);
    const push1 = ofType(out.effects, "push")[0]!;
    expect(push1.ops.map((o) => (o.type === "put" ? o.path : ""))).toEqual(["diff.md", "mine.md"]);
    expect(s.durable.cursor).toBe(3);
  });

  it("retryDelay: exponential with jitter, 1 s to 5 min", () => {
    expect(retryDelay(0, 0)).toBe(1000);
    expect(retryDelay(3, 0)).toBe(8000);
    expect(retryDelay(30, 0.999)).toBeLessThanOrEqual(300_000);
    expect(retryDelay(2, 0.5)).toBeGreaterThan(retryDelay(2, 0));
  });
});
```

- [ ] **Step 2: Implementazione** — `packages/sync-core/src/client.ts`:

```ts
import type { AcceptedResult, ErrorCode, JournalEntry, Op, OpResult, RejectedResult, Snapshot } from "@kamino/protocol";
import { classify, type SyncSettings } from "./exclusions.js";
import { collisionKey, conflictSiblingPath, isRepresentable, localPath, type Platform } from "./paths.js";

/** One file as this device knows it (durable). Folders arrive with M1d (Z9). */
export interface Entry {
  fileId: string;
  /** Canonical path on this device. */
  path: string;
  /** The server knows this fileId. */
  confirmed: boolean;
  /** Path on the server as last known (null until confirmed). */
  remotePath: string | null;
  /** Version the local content derives from. */
  base: string | null;
  baseHash: string | null;
  /** Latest server version known: may be newer than `base`. */
  head: string | null;
  headHash: string | null;
  headSeq: number;
  headDeleted: boolean;
  /** Content on disk as last seen; null = not on disk. */
  localHash: string | null;
  size: number;
  mtime: number;
  /** Was on disk for this entry: only then a missing file means "deleted here". */
  materialized: boolean;
  /** Write in progress, persisted before the write (write-ahead). */
  pendingWrite: { versionId: string; hash: string } | null;
  /** Losing side of an open conflict: the local copy is the user's, never overwritten (03 §9.2). */
  conflictId: string | null;
  /** Why the server path can't exist on this device (not representable or excluded): never written or moved here. */
  unavailable: string | null;
  /** Last rejection: not retried until the next sync cycle. */
  blocked: ErrorCode | null;
}

export interface Durable {
  index: Record<string, Entry>;
  /** Ops sent with unknown outcome: resent identical (same opId) before anything else. */
  sent: Op[];
  cursor: number;
  joined: boolean;
}

export interface Volatile {
  phase: "idle" | "joining" | "pushing" | "pulling";
  requestId: string | null;
  /** Set when an unknown, non-ignorable journal entry arrives: the plugin must be updated. */
  stopped: "update_required" | null;
}

export interface ClientConfig {
  deviceId: string;
  platform: Platform;
  configDir: string;
  settings: SyncSettings;
  batchSize: number;
}

export interface ClientState {
  config: ClientConfig;
  durable: Durable;
  vol: Volatile;
}

export interface ScanItem {
  /** Canonical path. */
  path: string;
  hash: string;
  size: number;
  mtime: number;
}

export type ClientEvent =
  /** Start of a cycle (03 §8): full scan of the vault, then push and pull. */
  | { type: "sync"; scan: ScanItem[] }
  | { type: "localRename"; from: string; to: string }
  | { type: "snapshotResult"; requestId: string; snapshot: Snapshot }
  | { type: "pushResult"; requestId: string; results: OpResult[]; head: number }
  | { type: "pullResult"; requestId: string; entries: JournalEntry[]; head: number; hasMore: boolean }
  | { type: "networkError"; requestId: string }
  | { type: "written"; fileId: string; ok: boolean }
  | { type: "renamed"; fileId: string; to: string; ok: boolean }
  | { type: "trashed"; fileId: string; ok: boolean };

export type NotifyKind = "conflict" | "blocked" | "restored" | "renamed" | "update_required";

/** Paths in file effects are local (configuration folder under its local name). */
export type Effect =
  | { type: "persist" }
  | { type: "snapshot"; requestId: string }
  | { type: "push"; requestId: string; ops: Op[]; hashes: string[] }
  | { type: "pull"; requestId: string; after: number }
  /** Write only if the file at `path` still has hash `expect` (null = must not exist). */
  | { type: "write"; fileId: string; path: string; hash: string; expect: string | null }
  | { type: "rename"; fileId: string; from: string; to: string; toPath: string }
  /** Move to the trash only if the file still has hash `expect`. */
  | { type: "trash"; fileId: string; path: string; expect: string }
  | { type: "ack"; seq: number }
  | { type: "notify"; kind: NotifyKind; fileId?: string; code?: ErrorCode };

export interface ClientEnv {
  newId(): string;
}

interface Ctx {
  s: ClientState;
  env: ClientEnv;
  fx: Effect[];
}

export function initialState(config: ClientConfig): ClientState {
  return {
    config,
    durable: { index: {}, sent: [], cursor: 0, joined: false },
    vol: { phase: "idle", requestId: null, stopped: null },
  };
}

/** Exponential backoff with jitter, 1 s to 5 min (03 §8). `random` in [0, 1). */
export function retryDelay(attempt: number, random: number): number {
  const base = Math.min(300_000, 1000 * 2 ** Math.min(attempt, 20));
  return Math.min(300_000, Math.round(base * (1 + random)));
}

/**
 * The whole client as a pure reducer. `persist` is always the first effect: the shell saves
 * `durable` before doing anything else (S-04, write-ahead).
 */
export function step(state: ClientState, event: ClientEvent, env: ClientEnv): { state: ClientState; effects: Effect[] } {
  const s: ClientState = {
    config: state.config,
    durable: JSON.parse(JSON.stringify(state.durable)) as Durable,
    vol: { ...state.vol },
  };
  const c: Ctx = { s, env, fx: [] };
  switch (event.type) {
    case "sync":
      onSync(c, event.scan);
      break;
    case "localRename":
      onLocalRename(c, event.from, event.to);
      break;
    case "snapshotResult":
      if (event.requestId === s.vol.requestId) onSnapshot(c, event.snapshot);
      break;
    case "pushResult":
      if (event.requestId === s.vol.requestId) onPushResult(c, event.results);
      break;
    case "pullResult":
      if (event.requestId === s.vol.requestId) onPullResult(c, event.entries, event.hasMore);
      break;
    case "networkError":
      if (event.requestId === s.vol.requestId) idle(s);
      break;
    case "written":
      onWritten(c, event.fileId, event.ok);
      break;
    case "renamed":
      onRenamed(c, event.fileId, event.to, event.ok);
      break;
    case "trashed":
      onTrashed(c, event.fileId, event.ok);
      break;
  }
  return { state: s, effects: [{ type: "persist" }, ...c.fx] };
}

// ---------- helpers ----------

const entries = (s: ClientState): Entry[] => Object.values(s.durable.index);
const caseInsensitive = (p: Platform) => p !== "linux";
const diskKey = (s: ClientState, path: string) => (caseInsensitive(s.config.platform) ? collisionKey(path) : path);
const local = (s: ClientState, path: string) => localPath(path, s.config.configDir);

function idle(s: ClientState): void {
  s.vol.phase = "idle";
  s.vol.requestId = null;
}

/** Why a server path can't be used on this device, or null. */
function unavailableReason(s: ClientState, path: string): string | null {
  const r = isRepresentable(local(s, path), s.config.platform);
  if (!r.ok) return r.reason;
  return classify(path, s.config.settings).excluded ? "excluded" : null;
}

/** The entry whose file occupies `path` on disk (or is being written there). */
function ownerOf(s: ClientState, path: string, except?: Entry): Entry | undefined {
  const key = diskKey(s, path);
  return entries(s).find((e) => e !== except && (e.localHash !== null || e.pendingWrite !== null) && diskKey(s, e.path) === key);
}

function newLocalEntry(fileId: string, item: ScanItem): Entry {
  return {
    fileId, path: item.path, confirmed: false, remotePath: null, base: null, baseHash: null,
    head: null, headHash: null, headSeq: 0, headDeleted: false, localHash: item.hash, size: item.size,
    mtime: item.mtime, materialized: true, pendingWrite: null, conflictId: null, unavailable: null, blocked: null,
  };
}

function remoteEntry(s: ClientState, r: { fileId: string; path: string; versionId: string; hash: string; size: number; mtime: number; seq: number }): Entry {
  return {
    fileId: r.fileId, path: r.path, confirmed: true, remotePath: r.path, base: null, baseHash: null,
    head: r.versionId, headHash: r.hash, headSeq: r.seq, headDeleted: false, localHash: null, size: r.size,
    mtime: r.mtime, materialized: false, pendingWrite: null, conflictId: null,
    unavailable: unavailableReason(s, r.path), blocked: null,
  };
}

function adoptWrite(e: Entry): void {
  const w = e.pendingWrite!;
  e.localHash = w.hash;
  e.base = w.versionId;
  e.baseHash = w.hash;
  e.materialized = true;
  e.pendingWrite = null;
}

function write(c: Ctx, e: Entry): void {
  if (e.head === null || e.headHash === null) return;
  e.pendingWrite = { versionId: e.head, hash: e.headHash };
  c.fx.push({ type: "write", fileId: e.fileId, path: local(c.s, e.path), hash: e.headHash, expect: e.localHash });
}

function renameLocal(c: Ctx, e: Entry, to: string): void {
  c.fx.push({ type: "rename", fileId: e.fileId, from: local(c.s, e.path), to: local(c.s, to), toPath: to });
}

/** A free path next to `path` on this device: "Nota (1).md", "Nota (2).md"… */
function freeLocalSibling(s: ClientState, path: string, self: Entry): string {
  for (let n = 1; ; n++) {
    const p = conflictSiblingPath(path, n);
    const key = diskKey(s, p);
    if (!entries(s).some((e) => e !== self && diskKey(s, e.path) === key)) return p;
  }
}

/** Download what the server has and this device doesn't (and is allowed to have). */
function materialize(c: Ctx, e: Entry): void {
  if (!e.confirmed || e.materialized || e.pendingWrite || e.headDeleted || e.conflictId) return;
  e.unavailable = unavailableReason(c.s, e.path);
  if (e.unavailable || ownerOf(c.s, e.path, e)) return;
  write(c, e);
}

/** Remote deletion of an unmodified file: to the trash, never a hard delete (03 §6.4). */
function trashIfClean(c: Ctx, e: Entry): void {
  if (!e.headDeleted || e.conflictId || e.pendingWrite || e.localHash === null) return;
  if (e.localHash !== e.baseHash) return; // the edit wins: the next put resurrects it
  c.fx.push({ type: "trash", fileId: e.fileId, path: local(c.s, e.path), expect: e.localHash });
}

/** The server path changed: follow it, unless a local move is pending (first arrived wins, the server says). */
function followRemotePath(c: Ctx, e: Entry, path: string): void {
  const previous = e.remotePath;
  e.remotePath = path;
  if (e.path === path) return;
  if (!e.materialized || (e.localHash === null && !e.pendingWrite)) {
    e.path = path;
    e.unavailable = unavailableReason(c.s, path);
    return;
  }
  if (previous !== null && e.path !== previous) return;
  const reason = unavailableReason(c.s, path);
  if (reason) {
    // Stays where it is on this device; content still syncs (03 §6.4).
    e.unavailable = reason;
    return;
  }
  e.unavailable = null;
  const taken = ownerOf(c.s, path, e);
  renameLocal(c, e, taken ? freeLocalSibling(c.s, path, e) : path);
}

// ---------- local side ----------

function onSync(c: Ctx, scan: ScanItem[]): void {
  const { s } = c;
  for (const e of entries(s)) e.blocked = null;
  applyScan(c, scan);
  if (s.vol.phase !== "idle") return;
  if (!s.durable.joined) {
    startSnapshot(c);
    return;
  }
  for (const e of entries(s)) {
    materialize(c, e);
    trashIfClean(c, e);
  }
  if (!startPush(c)) startPull(c);
}

function applyScan(c: Ctx, scan: ScanItem[]): void {
  const { s } = c;
  const owners = new Map<string, Entry>();
  for (const e of entries(s)) if (e.localHash !== null || e.pendingWrite) owners.set(diskKey(s, e.path), e);
  const seen = new Set<Entry>();
  for (const item of scan) {
    if (classify(item.path, s.config.settings).excluded) continue;
    const e = owners.get(diskKey(s, item.path));
    if (e?.pendingWrite) {
      if (item.hash === e.pendingWrite.hash) {
        adoptWrite(e); // the write happened; its event was lost (crash)
        e.path = item.path;
        seen.add(e);
        continue;
      }
      e.pendingWrite = null;
      if (e.localHash === null) {
        // An untracked file where a remote one was going: both are kept.
        const id = c.env.newId();
        s.durable.index[id] = newLocalEntry(id, item);
        continue;
      }
    }
    if (e) {
      seen.add(e);
      e.path = item.path;
      if (e.localHash !== item.hash) {
        e.localHash = item.hash;
        e.size = item.size;
        e.mtime = item.mtime;
      }
      continue;
    }
    const id = c.env.newId();
    s.durable.index[id] = newLocalEntry(id, item);
  }
  for (const e of owners.values()) {
    if (seen.has(e)) continue;
    if (e.pendingWrite) {
      e.pendingWrite = null; // the write never happened
      continue;
    }
    e.localHash = null;
    // Created and deleted here before the server ever knew it.
    if (!e.confirmed && !s.durable.sent.some((op) => op.fileId === e.fileId)) delete s.durable.index[e.fileId];
  }
}

function onLocalRename(c: Ctx, from: string, to: string): void {
  const e = ownerOf(c.s, from);
  if (!e) return;
  if (classify(to, c.s.config.settings).excluded) e.localHash = null;
  else e.path = to;
}

// ---------- push ----------

/** Ops for every difference between this device and the server (Z8): one per file, deletes → moves → puts. */
export function nextOps(s: ClientState, env: ClientEnv): Op[] {
  if (s.durable.sent.length > 0) return s.durable.sent;
  const deletes: Op[] = [];
  const moves: Op[] = [];
  const puts: Op[] = [];
  for (const e of entries(s)) {
    if (e.conflictId || e.pendingWrite || e.blocked) continue;
    if (!e.confirmed) {
      if (e.localHash !== null)
        puts.push({ type: "put", opId: env.newId(), fileId: e.fileId, versionId: env.newId(), path: e.path, baseVersionId: null, contentHash: e.localHash, size: e.size, mtime: e.mtime });
      continue;
    }
    if (e.localHash === null) {
      if (e.materialized && !e.headDeleted && e.base !== null)
        deletes.push({ type: "delete", opId: env.newId(), fileId: e.fileId, baseVersionId: e.base });
      continue;
    }
    if (e.remotePath !== null && e.path !== e.remotePath && !e.unavailable)
      moves.push({ type: "move", opId: env.newId(), fileId: e.fileId, fromPath: e.remotePath, toPath: e.path });
    else if (e.localHash !== e.baseHash)
      puts.push({ type: "put", opId: env.newId(), fileId: e.fileId, versionId: env.newId(), path: e.path, baseVersionId: e.base, contentHash: e.localHash, size: e.size, mtime: e.mtime });
  }
  return [...deletes, ...moves, ...puts].slice(0, s.config.batchSize);
}

function startPush(c: Ctx): boolean {
  const { s } = c;
  const ops = nextOps(s, c.env);
  if (ops.length === 0) return false;
  s.durable.sent = ops;
  s.vol.phase = "pushing";
  s.vol.requestId = c.env.newId();
  const hashes = [...new Set(ops.flatMap((op) => (op.type === "put" ? [op.contentHash] : [])))];
  c.fx.push({ type: "push", requestId: s.vol.requestId, ops, hashes });
  return true;
}

function onPushResult(c: Ctx, results: OpResult[]): void {
  const { s } = c;
  const sent = s.durable.sent;
  s.durable.sent = [];
  idle(s);
  sent.forEach((op, i) => {
    const r = results[i];
    if (r) applyResult(c, op, r);
  });
  if (!startPush(c)) startPull(c);
}

function applyResult(c: Ctx, op: Op, r: OpResult): void {
  const res = r.status === "duplicate" ? r.original : r;
  const e = c.s.durable.index[op.fileId];
  if (!e) return;
  if (res.status === "accepted") onAccepted(c, e, op, res);
  else if (res.status === "conflict") {
    e.conflictId = res.conflictId;
    c.fx.push({ type: "notify", kind: "conflict", fileId: e.fileId });
  } else onRejected(c, e, op, res);
}

/** Idempotent: the same result may arrive from the response and from the journal. */
function onAccepted(c: Ctx, e: Entry, op: Op, res: Pick<AcceptedResult, "seq" | "path">): void {
  const wasConfirmed = e.confirmed;
  e.confirmed = true;
  if (op.type === "put") {
    e.base = op.versionId;
    e.baseHash = op.contentHash;
    if (res.seq >= e.headSeq) {
      e.head = op.versionId;
      e.headHash = op.contentHash;
      e.headSeq = res.seq;
      e.headDeleted = false;
    }
    if (!wasConfirmed || e.remotePath === null) e.remotePath = op.path;
    if (res.path !== e.remotePath) followRemotePath(c, e, res.path);
  } else if (op.type === "move") {
    e.remotePath = res.path;
  } else if (op.type === "delete") {
    e.headDeleted = true;
    if (e.localHash === null) delete c.s.durable.index[e.fileId];
  }
}

function onRejected(c: Ctx, e: Entry, op: Op, res: RejectedResult): void {
  e.blocked = res.code;
  switch (res.code) {
    case "moved_elsewhere":
      if (res.path !== undefined) {
        e.remotePath = res.path;
        renameLocal(c, e, ownerOf(c.s, res.path, e) ? freeLocalSibling(c.s, res.path, e) : res.path);
      }
      return;
    case "path_taken":
      if (op.type === "move") {
        renameLocal(c, e, freeLocalSibling(c.s, op.toPath, e));
        c.fx.push({ type: "notify", kind: "renamed", fileId: e.fileId });
      }
      return;
    case "modified_since":
      // Changed elsewhere: the deletion doesn't happen, the current version comes back (03 §5.3).
      e.materialized = false;
      e.base = null;
      e.baseHash = null;
      e.blocked = null;
      c.fx.push({ type: "notify", kind: "restored", fileId: e.fileId });
      materialize(c, e);
      return;
    case "not_found":
      e.confirmed = false;
      e.remotePath = null;
      e.base = null;
      e.baseHash = null;
      if (e.localHash === null) delete c.s.durable.index[e.fileId];
      return;
    case "blob_missing":
      return; // retried at the next cycle with the content on disk then
    default:
      c.fx.push({ type: "notify", kind: "blocked", fileId: e.fileId, code: res.code });
  }
}

// ---------- pull ----------

function startSnapshot(c: Ctx): void {
  c.s.vol.phase = "joining";
  c.s.vol.requestId = c.env.newId();
  c.fx.push({ type: "snapshot", requestId: c.s.vol.requestId });
}

function startPull(c: Ctx): boolean {
  const { s } = c;
  if (s.vol.phase !== "idle" || s.vol.stopped) return false;
  s.vol.phase = "pulling";
  s.vol.requestId = c.env.newId();
  c.fx.push({ type: "pull", requestId: s.vol.requestId, after: s.durable.cursor });
  return true;
}

function onPullResult(c: Ctx, journal: JournalEntry[], hasMore: boolean): void {
  const { s } = c;
  idle(s);
  const before = s.durable.cursor;
  for (const entry of journal) {
    if (entry.seq <= s.durable.cursor) continue;
    if (!applyEntry(c, entry)) break;
    s.durable.cursor = entry.seq;
  }
  if (s.durable.cursor > before) c.fx.push({ type: "ack", seq: s.durable.cursor });
  if (hasMore && !s.vol.stopped) startPull(c);
}

/** 03 §6.4. Returns false when sync must stop (unknown, non-ignorable entry). */
function applyEntry(c: Ctx, entry: JournalEntry): boolean {
  const { s } = c;
  const own = entry.opId === undefined ? undefined : s.durable.sent.find((op) => op.opId === entry.opId);
  if (own) {
    // Our op went through but its response was lost: the journal tells us. Still resent (duplicate).
    const e = s.durable.index[own.fileId];
    if (e && entry.type === "conflict_opened" && entry.conflictId !== undefined) e.conflictId = entry.conflictId;
    else if (e) onAccepted(c, e, own, { seq: entry.seq, path: entry.path });
    return true;
  }
  if (entry.deviceId === s.config.deviceId) return true;
  if (entry.kind === "folder") return true; // folders: M1d (Z9)
  switch (entry.type) {
    case "file_put":
    case "file_restored":
      onRemotePut(c, entry);
      return true;
    case "file_moved": {
      const e = s.durable.index[entry.fileId];
      if (e) followRemotePath(c, e, entry.path);
      return true;
    }
    case "file_deleted":
      onRemoteDelete(c, entry);
      return true;
    case "folder_created":
    case "folder_deleted":
    case "conflict_opened":
    case "conflict_resolved":
    case "vault_settings_changed":
      return true;
    default:
      if (entry.ignorable) return true;
      s.vol.stopped = "update_required";
      c.fx.push({ type: "notify", kind: "update_required" });
      return false;
  }
}

function onRemotePut(c: Ctx, entry: JournalEntry): void {
  const { s } = c;
  if (entry.versionId === undefined || entry.contentHash === undefined) return;
  let e = s.durable.index[entry.fileId];
  if (!e) {
    e = remoteEntry(s, { fileId: entry.fileId, path: entry.path, versionId: entry.versionId, hash: entry.contentHash, size: entry.size ?? 0, mtime: entry.mtime ?? 0, seq: entry.seq });
    s.durable.index[e.fileId] = e;
    materialize(c, e);
    return;
  }
  if (entry.seq > e.headSeq) {
    e.head = entry.versionId;
    e.headHash = entry.contentHash;
    e.headSeq = entry.seq;
    e.headDeleted = false;
  }
  if (e.remotePath !== entry.path) followRemotePath(c, e, entry.path);
  if (e.conflictId || e.pendingWrite) return;
  if (!e.materialized) {
    materialize(c, e);
    return;
  }
  // Unmodified here → write; local edits wait and their put will meet the conflict (no overwrite).
  if (e.localHash !== null && e.localHash === e.baseHash && e.headHash !== e.localHash) write(c, e);
}

function onRemoteDelete(c: Ctx, entry: JournalEntry): void {
  const e = c.s.durable.index[entry.fileId];
  if (!e) return;
  e.headDeleted = true;
  e.headSeq = Math.max(e.headSeq, entry.seq);
  if (e.conflictId) return;
  if (!e.materialized || (e.localHash === null && !e.pendingWrite)) {
    delete c.s.durable.index[e.fileId];
    return;
  }
  trashIfClean(c, e);
}

// ---------- file effects ----------

function onWritten(c: Ctx, fileId: string, ok: boolean): void {
  const e = c.s.durable.index[fileId];
  if (!e?.pendingWrite) return;
  if (ok) {
    adoptWrite(e);
    trashIfClean(c, e);
  } else e.pendingWrite = null; // the file changed meanwhile: the next scan sees the user's content
}

function onRenamed(c: Ctx, fileId: string, to: string, ok: boolean): void {
  const e = c.s.durable.index[fileId];
  if (e && ok) e.path = to;
}

function onTrashed(c: Ctx, fileId: string, ok: boolean): void {
  if (ok) delete c.s.durable.index[fileId];
}

// ---------- joining (D-07, V-05) ----------

/** 03 §8.1 for a device without index: identical files align, different ones become conflicts, nothing is overwritten. */
function onSnapshot(c: Ctx, snap: Snapshot): void {
  const { s } = c;
  idle(s);
  const remote = new Map<string, Snapshot["files"][number]>();
  for (const f of snap.files) if (f.kind === "file" && f.versionId !== null && f.contentHash !== null) remote.set(diskKey(s, f.path), f);
  for (const e of entries(s)) {
    if (e.confirmed || e.localHash === null) continue;
    const r = remote.get(diskKey(s, e.path));
    if (!r || r.versionId === null || r.contentHash === null) continue;
    if (r.contentHash !== e.localHash) continue; // both kept: our put meets both_created
    remote.delete(diskKey(s, e.path));
    delete s.durable.index[e.fileId];
    const aligned = remoteEntry(s, { fileId: r.fileId, path: e.path, versionId: r.versionId, hash: r.contentHash, size: r.size, mtime: r.mtime, seq: snap.head });
    Object.assign(aligned, { localHash: e.localHash, base: r.versionId, baseHash: r.contentHash, materialized: true, remotePath: r.path, unavailable: null });
    s.durable.index[r.fileId] = aligned;
    if (e.path !== r.path) renameLocal(c, aligned, r.path);
  }
  for (const r of remote.values()) {
    if (r.versionId === null || r.contentHash === null) continue;
    const e = remoteEntry(s, { fileId: r.fileId, path: r.path, versionId: r.versionId, hash: r.contentHash, size: r.size, mtime: r.mtime, seq: snap.head });
    s.durable.index[e.fileId] = e;
    materialize(c, e);
  }
  s.durable.cursor = snap.head;
  s.durable.joined = true;
  if (!startPush(c)) startPull(c);
}
```

`index.ts`: `export * from "./client.js";`. Run test/typecheck/lint; commit `feat(sync-core): add the client reducer`.

(Il test "remote put … held back when modified" è volutamente generico nella seconda metà: il comportamento "trattenuto" viene verificato a fondo dal simulatore; in esecuzione va semplificato tenendo solo l'asserzione che nessun `write` parte su un file modificato.)

---

### Task 6: Simulatore e proprietà

**Files:** Create `packages/sync-core/src/sim/world.ts`, `packages/sync-core/src/sim/sim.test.ts`.

- [ ] **Step 1: Mondo simulato** — `packages/sync-core/src/sim/world.ts`:

```ts
import type { JournalEntry, Op, OpResult, Snapshot } from "@kamino/protocol";
import { initialState, nextOps, step, type ClientEvent, type ClientState, type Durable, type Effect } from "../client.js";
import { DEFAULT_SETTINGS } from "../exclusions.js";
import { collisionKey, isRepresentable, type Platform } from "../paths.js";
import { checkInvariants, MemoryStore } from "../store.js";

type Msg =
  | { to: "server"; client: number; requestId: string; kind: "push"; ops: Op[]; blobs: string[] }
  | { to: "server"; client: number; requestId: string; kind: "pull"; after: number }
  | { to: "server"; client: number; requestId: string; kind: "snapshot" }
  | { to: "client"; client: number; event: ClientEvent & { requestId: string } };

interface SimClient {
  platform: Platform;
  deviceId: string;
  state: ClientState;
  persisted: Durable;
  /** Disk: diskKey → file. Case-insensitive platforms key by collisionKey. */
  disk: Map<string, { path: string; hash: string }>;
  queue: ClientEvent[];
}

export interface ClientSpec {
  platform: Platform;
  files: Array<[string, string]>;
}

export type Action =
  | { t: "write"; c: number; path: string; hash: string }
  | { t: "remove"; c: number; path: string }
  | { t: "rename"; c: number; from: string; to: string; watched: boolean }
  | { t: "sync"; c: number; crashAt: number | null }
  | { t: "deliver"; k: number; crashAt: number | null }
  | { t: "drop"; k: number }
  | { t: "dup"; k: number }
  | { t: "crash"; c: number };

/** N clients, one server, a network that loses, duplicates and reorders, and crashes (02 §5). */
export class World {
  readonly store = new MemoryStore();
  readonly clients: SimClient[];
  net: Msg[] = [];
  readonly violations: string[] = [];
  private ids = 0;
  private readonly env = { newId: () => `id-${++this.ids}` };

  constructor(specs: ClientSpec[]) {
    this.clients = specs.map((spec, i) => {
      const deviceId = `dev-${i}`;
      const state = initialState({ deviceId, platform: spec.platform, configDir: ".obsidian", settings: DEFAULT_SETTINGS, batchSize: 4 });
      const c: SimClient = { platform: spec.platform, deviceId, state, persisted: state.durable, disk: new Map(), queue: [] };
      for (const [path, hash] of spec.files) if (this.canExist(c, path)) this.diskSet(c, path, hash);
      return c;
    });
  }

  private key(c: SimClient, path: string): string {
    return c.platform === "linux" ? path : collisionKey(path);
  }
  private canExist(c: SimClient, path: string): boolean {
    return isRepresentable(path, c.platform).ok;
  }
  private diskSet(c: SimClient, path: string, hash: string): void {
    const k = this.key(c, path);
    const existing = c.disk.get(k);
    c.disk.set(k, { path: existing?.path ?? path, hash });
  }

  act(a: Action): void {
    switch (a.t) {
      case "write": {
        const c = this.clients[a.c]!;
        if (this.canExist(c, a.path)) this.diskSet(c, a.path, a.hash);
        return;
      }
      case "remove": {
        const c = this.clients[a.c]!;
        c.disk.delete(this.key(c, a.path));
        return;
      }
      case "rename": {
        const c = this.clients[a.c]!;
        const from = c.disk.get(this.key(c, a.from));
        if (!from || !this.canExist(c, a.to)) return;
        const toKey = this.key(c, a.to);
        if (c.disk.has(toKey) && toKey !== this.key(c, a.from)) return;
        c.disk.delete(this.key(c, a.from));
        c.disk.set(toKey, { path: a.to, hash: from.hash });
        if (a.watched) this.feed(a.c, { type: "localRename", from: from.path, to: a.to }, null);
        return;
      }
      case "sync":
        this.feed(a.c, { type: "sync", scan: this.scan(this.clients[a.c]!) }, a.crashAt);
        return;
      case "deliver":
        this.deliver(a.k, a.crashAt);
        return;
      case "drop": {
        if (this.net.length === 0) return;
        const [m] = this.net.splice(a.k % this.net.length, 1);
        // A lost request or response looks like a timeout to the client.
        if (m) {
          const requestId = m.to === "server" ? m.requestId : m.event.requestId;
          this.feed(m.client, { type: "networkError", requestId }, null);
        }
        return;
      }
      case "dup":
        if (this.net.length > 0) this.net.push(this.net[a.k % this.net.length]!);
        return;
      case "crash":
        this.crash(a.c);
        return;
    }
  }

  private scan(c: SimClient) {
    return [...c.disk.values()].map((f) => ({ path: f.path, hash: f.hash, size: 1, mtime: 0 }));
  }

  private crash(i: number): void {
    const c = this.clients[i]!;
    c.state = { config: c.state.config, durable: JSON.parse(JSON.stringify(c.persisted)) as Durable, vol: { phase: "idle", requestId: null, stopped: null } };
    c.queue = [];
  }

  /** Runs an event and every event its effects cause; `crashAt` = crash after that many effects. */
  private feed(i: number, event: ClientEvent, crashAt: number | null): void {
    const c = this.clients[i]!;
    c.queue.push(event);
    let budget = crashAt;
    while (c.queue.length > 0) {
      const ev = c.queue.shift()!;
      const out = step(c.state, ev, this.env);
      c.state = out.state;
      for (const fx of out.effects) {
        if (budget !== null && budget-- <= 0) {
          this.crash(i);
          return;
        }
        this.run(i, fx);
      }
    }
  }

  private run(i: number, fx: Effect): void {
    const c = this.clients[i]!;
    switch (fx.type) {
      case "persist":
        c.persisted = JSON.parse(JSON.stringify(c.state.durable)) as Durable;
        return;
      case "snapshot":
        this.net.push({ to: "server", client: i, requestId: fx.requestId, kind: "snapshot" });
        return;
      case "push": {
        // The shell reads the contents at send time: only what is on disk now can be uploaded.
        const onDisk = new Set([...c.disk.values()].map((f) => f.hash));
        this.net.push({ to: "server", client: i, requestId: fx.requestId, kind: "push", ops: fx.ops, blobs: fx.hashes.filter((h) => onDisk.has(h)) });
        return;
      }
      case "pull":
        this.net.push({ to: "server", client: i, requestId: fx.requestId, kind: "pull", after: fx.after });
        return;
      case "write": {
        const k = this.key(c, fx.path);
        const cur = c.disk.get(k)?.hash ?? null;
        if (cur !== fx.expect) {
          c.queue.push({ type: "written", fileId: fx.fileId, ok: false });
          return;
        }
        if (cur !== null && !this.store.hasContent(cur)) this.violations.push(`client ${i} overwrote content the server doesn't have: ${fx.path}`);
        c.disk.set(k, { path: c.disk.get(k)?.path ?? fx.path, hash: fx.hash });
        c.queue.push({ type: "written", fileId: fx.fileId, ok: true });
        return;
      }
      case "rename": {
        const from = c.disk.get(this.key(c, fx.from));
        const toKey = this.key(c, fx.to);
        const ok = !!from && (!c.disk.has(toKey) || toKey === this.key(c, fx.from)) && this.canExist(c, fx.to);
        if (ok) {
          c.disk.delete(this.key(c, fx.from));
          c.disk.set(toKey, { path: fx.to, hash: from.hash });
        }
        c.queue.push({ type: "renamed", fileId: fx.fileId, to: fx.toPath, ok });
        return;
      }
      case "trash": {
        const k = this.key(c, fx.path);
        const cur = c.disk.get(k)?.hash ?? null;
        if (cur !== fx.expect) {
          c.queue.push({ type: "trashed", fileId: fx.fileId, ok: false });
          return;
        }
        if (!this.store.hasContent(fx.expect)) this.violations.push(`client ${i} trashed content the server doesn't have: ${fx.path}`);
        c.disk.delete(k);
        c.queue.push({ type: "trashed", fileId: fx.fileId, ok: true });
        return;
      }
      case "ack":
        this.store.cursors.set(c.deviceId, fx.seq);
        return;
      case "notify":
        return;
    }
  }

  private deliver(k: number, crashAt: number | null): void {
    if (this.net.length === 0) return;
    const [m] = this.net.splice(k % this.net.length, 1);
    if (!m) return;
    if (m.to === "client") {
      this.feed(m.client, m.event, crashAt);
      return;
    }
    const deviceId = this.clients[m.client]!.deviceId;
    let event: ClientEvent & { requestId: string };
    if (m.kind === "push") {
      for (const h of m.blobs) this.store.blobs.add(h);
      const res = this.store.commit(m.ops, deviceId);
      for (const problem of checkInvariants(this.store)) this.violations.push(`server: ${problem}`);
      event = { type: "pushResult", requestId: m.requestId, results: res.results as OpResult[], head: res.head };
    } else if (m.kind === "pull") {
      const res = this.store.changes(m.after, 3);
      event = { type: "pullResult", requestId: m.requestId, entries: res.entries as JournalEntry[], head: res.head, hasMore: res.hasMore };
    } else {
      event = { type: "snapshotResult", requestId: m.requestId, snapshot: this.store.snapshot() as Snapshot };
    }
    this.net.push({ to: "client", client: m.client, event });
  }

  /** No more faults: sync everyone until nothing moves. Returns false if it never settles. */
  settle(maxRounds = 40): boolean {
    for (let round = 0; round < maxRounds; round++) {
      for (let i = 0; i < this.clients.length; i++) {
        this.act({ t: "sync", c: i, crashAt: null });
        while (this.net.length > 0) this.deliver(0, null);
      }
      if (this.quiet()) return true;
    }
    return false;
  }

  private quiet(): boolean {
    return this.clients.every((c) => {
      const s = c.state;
      if (!s.durable.joined || s.vol.phase !== "idle" || s.durable.cursor !== this.store.head) return false;
      if (Object.values(s.durable.index).some((e) => e.pendingWrite)) return false;
      const probe = { ...s, durable: { ...s.durable, index: JSON.parse(JSON.stringify(s.durable.index)) as Durable["index"] } };
      for (const e of Object.values(probe.durable.index)) e.blocked = null;
      return nextOps(probe, { newId: () => "probe" }).length === 0;
    });
  }

  /** Convergence and "nothing lost" (spec §4.1–2), as readable problems. */
  check(): string[] {
    const out = [...this.violations];
    const live = [...this.store.files.values()].filter((f) => f.kind === "file" && !f.deleted);
    this.clients.forEach((c, i) => {
      const index = c.state.durable.index;
      for (const f of live) {
        const e = index[f.fileId];
        if (!e) {
          out.push(`client ${i} doesn't know ${f.path}`);
          continue;
        }
        if (e.unavailable || e.conflictId) continue;
        const occupant = Object.values(index).find((o) => o !== e && o.conflictId && this.key(c, o.path) === this.key(c, f.path));
        if (occupant) continue; // our conflicted copy keeps the path on this device (03 §9.2)
        const onDisk = c.disk.get(this.key(c, f.path));
        if (!onDisk || onDisk.hash !== f.headHash || onDisk.path !== f.path)
          out.push(`client ${i}: ${f.path} is ${onDisk ? `${onDisk.path}=${onDisk.hash}` : "missing"}, server has ${f.headHash}`);
      }
      for (const d of c.disk.values()) {
        const e = Object.values(index).find((x) => x.localHash !== null && this.key(c, x.path) === this.key(c, d.path));
        if (!e) {
          out.push(`client ${i}: ${d.path} on disk but not tracked`);
          continue;
        }
        if (e.conflictId) continue; // local edits after a conflict stay local until it's resolved (M3)
        if (!this.store.hasContent(d.hash)) out.push(`client ${i}: content of ${d.path} never reached the server`);
        if (!e.unavailable && !live.some((f) => f.fileId === e.fileId))
          out.push(`client ${i}: ${d.path} is not a live file on the server`);
      }
    });
    return out;
  }
}
```

- [ ] **Step 2: Proprietà** — `packages/sync-core/src/sim/sim.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Platform } from "../paths.js";
import { World, type Action, type ClientSpec } from "./world.js";

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Number(env["SIM_RUNS"] ?? 150);

const PATHS = ["a.md", "A.md", "b.md", "d/c.md", "D/c.md", "é.md", "con.md", "x/y/z.md"];
const HASHES = ["0", "1", "2", "3", "4"].map((c) => c.repeat(64));
const PLATFORMS: Platform[] = ["linux", "windows", "macos", "android", "ios"];

const specArb: fc.Arbitrary<ClientSpec> = fc.record({
  platform: fc.constantFrom(...PLATFORMS),
  files: fc.array(fc.tuple(fc.constantFrom(...PATHS), fc.constantFrom(...HASHES)), { maxLength: 3 }),
});

const actionArb = (clients: number): fc.Arbitrary<Action> => {
  const c = fc.nat(clients - 1);
  const path = fc.constantFrom(...PATHS);
  const crashAt = fc.option(fc.nat(6), { freq: 4 });
  return fc.oneof(
    { weight: 4, arbitrary: fc.record({ t: fc.constant("write" as const), c, path, hash: fc.constantFrom(...HASHES) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant("remove" as const), c, path }) },
    { weight: 2, arbitrary: fc.record({ t: fc.constant("rename" as const), c, from: path, to: path, watched: fc.boolean() }) },
    { weight: 4, arbitrary: fc.record({ t: fc.constant("sync" as const), c, crashAt }) },
    { weight: 6, arbitrary: fc.record({ t: fc.constant("deliver" as const), k: fc.nat(20), crashAt }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant("drop" as const), k: fc.nat(20) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant("dup" as const), k: fc.nat(20) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant("crash" as const), c }) },
  );
};

const scenarioArb = fc
  .array(specArb, { minLength: 2, maxLength: 3 })
  .chain((specs) => fc.tuple(fc.constant(specs), fc.array(actionArb(specs.length), { maxLength: 60 })));

describe("simulator (02 §5)", () => {
  it(
    "every client converges to the server and nothing is ever lost",
    () => {
      fc.assert(
        fc.property(scenarioArb, ([specs, actions]) => {
          const w = new World(specs);
          for (const a of actions) w.act(a);
          expect(w.settle()).toBe(true);
          expect(w.check()).toEqual([]);
        }),
        { numRuns: RUNS },
      );
    },
    120_000,
  );

  it("two devices create Nota.md and nota.md: both versions survive (03 §14)", () => {
    const w = new World([
      { platform: "linux", files: [] },
      { platform: "windows", files: [] },
    ]);
    w.act({ t: "sync", c: 0, crashAt: null });
    w.act({ t: "sync", c: 1, crashAt: null });
    while (w.net.length > 0) w.act({ t: "deliver", k: 0, crashAt: null });
    w.act({ t: "write", c: 0, path: "Nota.md", hash: "1".repeat(64) });
    w.act({ t: "write", c: 1, path: "nota.md", hash: "2".repeat(64) });
    expect(w.settle()).toBe(true);
    expect(w.check()).toEqual([]);
    expect(w.store.hasContent("1".repeat(64)) && w.store.hasContent("2".repeat(64))).toBe(true);
    expect(w.store.conflicts.size).toBe(1);
  });
});
```

- [ ] **Step 3: Esecuzione e correzioni** — `pnpm --filter @kamino/sync-core test`. Le proprietà troveranno con buona probabilità dei controesempi: per ognuno (1) capire se il difetto è nel client, nell'arbitro o nel simulatore, (2) correggere la causa, (3) aggiungere il caso minimo come test in `client.test.ts` o `sim.test.ts` con il seme di fast-check nel commento. Ripetere finché `pnpm --filter @kamino/sync-core test:deep` (3000 esecuzioni) è verde. Commit (anche più d'uno): `feat(sync-core): add the multi-client simulator and its properties`, `fix(sync-core): …`.

---

### Task 7: Documenti e verifica

- [ ] `docs/02-architecture.md` §5: nota che l'outbox è ricavata dall'indice (Z8) e che i moduli sono `paths`, `exclusions`, `arbiter`, `store`, `client`, `sim`.
- [ ] HANDOVER: M1a completata sul branch; decisioni Z1–Z9; prossimo passo M1b (crypto + auth vera) con R16 all'inizio; punti aperti: cartelle sul client (M1d), riconciliazione con indice esistente (M2).
- [ ] Nessun changeset (pacchetti interni in `ignore`; nessuna modifica rilasciabile).
- [ ] Verifica completa (build, typecheck, lint, test, format, release-names, Docker), push, CI, revisione finale (un subagente), PR.
