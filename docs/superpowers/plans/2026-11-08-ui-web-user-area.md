# Fase UI, sotto-fase 4b — Web app: area utente — piano di implementazione

> **For agentic workers:** standard del progetto (`CLAUDE.md`): superpowers:executing-plans nella sessione corrente, a blocchi; checkpoint solo per le prove del committente. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** panoramica, vault (dettaglio a schede, impostazioni, ZIP, eliminazione), dispositivi (D-06, rinomina, revoca), aggiungi dispositivo con QR e approvazione, centro conflitti con `ui-diff`, storico dei file e cestino; più lingua/tema da `me` e bundle diviso.

**Architecture:** come la 4a: contratto zod in `@kamino/protocol` (`vaults.ts`, `devices.ts`, `conflicts.ts`, `history.ts`), funzioni in `src/api/endpoints.ts`, MSW con dati in memoria (`src/mocks/userdata.ts`, `src/mocks/user-handlers.ts`), pagine in `src/pages/{overview,vaults,devices,conflicts}/`. `DiffView` è un adattatore React di `createDiffView`. Le route pesanti usano `lazyRouteComponent`.

**Tech Stack:** React 19, TanStack Router/Query, zod 4, MSW 3, `@kamino/ui-diff` (CodeMirror merge), `uqr`, shadcn/ui, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-08-ui-web-user-area-design.md`.

**Blocchi:** (A) Task 1–2 contratto e MSW; (B) Task 3–4 panoramica, vault, dispositivi, aggiungi dispositivo; (C) Task 5–6 centro conflitti, storico e cestino, impostazioni del vault; (D) Task 7–8 rinvii 4a, documenti → **prova del committente**.

## Global Constraints

- TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- Testi solo da i18n (`apps/web/src/i18n/locales/{it,en}.json`, stesse chiavi), nome prodotto da `@kamino/brand`, lessico a tema vietato.
- Azioni che scrivono: bottone disattivato durante l'invio, errore sempre mostrato (mai silenzioso), nessun aggiornamento di stato dopo lo smontaggio/chiusura.
- Mai bordi laterali colorati; stato con icona + testo (`LevelBadge`), pallino accanto ai nomi.
- shadcn: `cn` da `@/lib/utils`; se il CLI aggiunge il pacchetto `cn` o `next-themes`, rimuoverli.
- Prima di ogni push: `pnpm format:check`.

## Review Focus

1. Eliminazione del vault solo digitando il nome esatto; nome sbagliato → `confirm_mismatch`, niente cancellato. → Task 2, Task 6.
2. Revoca di un dispositivo: conferma che spiega che i file restano sul dispositivo. → Task 3.
3. Risoluzione di un conflitto con risposta `stale_resolution` → diff ricaricato, avviso, nessun toast di successo; unione manuale conservata. → Task 5.
4. Finestra "Aggiungi un dispositivo" chiusa durante l'attesa → `cancel` inviato, polling fermo. → Task 4.
5. Nessun chunk della build > 500 KB; MSW assente. → Task 7.

---

### Task 1: Contratto

**Files:** Create `packages/protocol/src/{vaults,devices,conflicts,history}.ts`, `packages/protocol/src/user-area.test.ts`; Modify `packages/protocol/src/errors.ts`, `packages/protocol/src/index.ts`.

**Interfaces — Produces:** `Vault`, `Quota`, `VaultList`, `VaultPatch`, `VaultDelete`, `PairingOffer`, `PairingStatus`, `PairingState`; `Device`, `DeviceList`, `DevicePatch`; `VersionRef`, `ConflictSummary`, `ConflictList`, `BinaryMeta`, `ConflictDetail`, `Resolution`, `ResolveRequest`, `BulkStrategy`, `ResolveAllRequest`, `ResolveAllResponse`; `FileList`, `FileVersions`, `VersionContent`, `TrashList`; codici `confirm_mismatch`, `history_window`, `pairing_closed`.

- [ ] **Step 1: Test (falliscono)** — `packages/protocol/src/user-area.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ConflictDetail, Device, ErrorCode, PairingState, Resolution, ResolveAllRequest, Vault, VaultPatch } from "./index.js";

const vault = {
  id: "v1", name: "Note", fileCount: 128, deviceCount: 3, level: "decision", conflicts: 2,
  usedBytes: 1, historyBytes: 1, trashBytes: 1, retentionDays: 30, maxRetentionDays: 90, historyFrom: "2026-10-09T00:00:00Z",
};
const base = { id: "c1", vaultId: "v1", vaultName: "Note", path: "Spesa.md", kind: "concurrent_edit", mine: { device: "Mac", at: "x" }, incoming: { device: "iPhone", at: "y" } };

describe("user area contract", () => {
  it("vaults and retention bounds", () => {
    expect(Vault.parse(vault).name).toBe("Note");
    expect(VaultPatch.safeParse({ retentionDays: 91 }).success).toBe(false);
    expect(VaultPatch.safeParse({ name: "  " }).success).toBe(false);
  });

  it("devices", () => {
    const d = { id: "d", vaultId: "v1", vaultName: "Note", name: "Mac", platform: "macOS", pluginVersion: "0.1.0", lastSeenAt: "x", lastSyncAt: null, lag: 0, pending: 0, lastError: null, level: "safe", revoked: false };
    expect(Device.parse(d).revoked).toBe(false);
  });

  it("pairing state carries a 4-char code when requested", () => {
    expect(PairingState.safeParse({ status: "requested", request: { deviceName: "Pixel", platform: "Android", pluginVersion: "0.1.0", code: "K7RX" } }).success).toBe(true);
    expect(PairingState.safeParse({ status: "requested", request: { deviceName: "P", platform: "A", pluginVersion: "0", code: "K7" } }).success).toBe(false);
  });

  it("conflict detail: text or binary", () => {
    expect(ConflictDetail.parse({ ...base, binary: false, mineText: "a", incomingText: "b" }).binary).toBe(false);
    const meta = { size: 1, mime: "image/svg+xml", previewUrl: null };
    expect(ConflictDetail.parse({ ...base, binary: true, mineFile: meta, incomingFile: meta }).binary).toBe(true);
    expect(ConflictDetail.safeParse({ ...base, binary: false, mineFile: meta }).success).toBe(false);
  });

  it("resolutions", () => {
    for (const r of ["keep_mine", "keep_incoming", "keep_both", { manual: "x" }]) expect(Resolution.safeParse(r).success).toBe(true);
    expect(Resolution.safeParse("keep_all").success).toBe(false);
    expect(ResolveAllRequest.safeParse({ strategy: "keep_both", ids: [] }).success).toBe(false);
  });

  it("new error codes", () => {
    for (const c of ["confirm_mismatch", "history_window", "pairing_closed"]) expect(ErrorCode.options).toContain(c);
  });
});
```

- [ ] **Step 2: Implementazione**

`packages/protocol/src/vaults.ts`:

```ts
import { z } from "zod";
import { Level } from "./account.js";

export const Vault = z.object({
  id: z.string(),
  name: z.string(),
  fileCount: z.number().int().min(0),
  deviceCount: z.number().int().min(0),
  level: Level,
  conflicts: z.number().int().min(0),
  usedBytes: z.number().min(0),
  historyBytes: z.number().min(0),
  trashBytes: z.number().min(0),
  /** H-02: user choice within the admin maximum. */
  retentionDays: z.number().int().min(0).max(90),
  maxRetentionDays: z.number().int().min(0).max(90),
  /** Oldest restorable point in time (ISO). */
  historyFrom: z.string(),
});
export type Vault = z.infer<typeof Vault>;

export const Quota = z.object({ usedBytes: z.number().min(0), limitBytes: z.number().min(0).nullable() });
export type Quota = z.infer<typeof Quota>;
export const VaultList = z.object({ vaults: z.array(Vault), quota: Quota });
export type VaultList = z.infer<typeof VaultList>;

export const VaultPatch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  retentionDays: z.number().int().min(0).max(90).optional(),
});
export type VaultPatch = z.infer<typeof VaultPatch>;
/** V-03: deletion is confirmed by typing the vault name. */
export const VaultDelete = z.object({ confirmName: z.string() });

export const PairingOffer = z.object({ pairingId: z.string(), link: z.string(), expiresAt: z.string() });
export type PairingOffer = z.infer<typeof PairingOffer>;
export const PairingStatus = z.enum(["waiting", "requested", "approved", "denied", "expired", "cancelled"]);
export const PairingState = z.object({
  status: PairingStatus,
  request: z
    .object({ deviceName: z.string(), platform: z.string(), pluginVersion: z.string(), code: z.string().length(4) })
    .optional(),
});
export type PairingState = z.infer<typeof PairingState>;
```

`packages/protocol/src/devices.ts`:

```ts
import { z } from "zod";
import { Level } from "./account.js";

/** D-06: everything the user sees about a device. */
export const Device = z.object({
  id: z.string(),
  vaultId: z.string(),
  vaultName: z.string(),
  name: z.string(),
  platform: z.string(),
  pluginVersion: z.string(),
  lastSeenAt: z.string(),
  lastSyncAt: z.string().nullable(),
  /** Changes behind the vault head. */
  lag: z.number().int().min(0),
  /** Local changes not yet on the server. */
  pending: z.number().int().min(0),
  lastError: z.string().nullable(),
  level: Level,
  revoked: z.boolean(),
});
export type Device = z.infer<typeof Device>;
export const DeviceList = z.array(Device);
export const DevicePatch = z.object({ name: z.string().trim().min(1).max(100) });
```

`packages/protocol/src/conflicts.ts`:

```ts
import { z } from "zod";

export const VersionRef = z.object({ device: z.string(), at: z.string() });
export const ConflictSummary = z.object({
  id: z.string(),
  vaultId: z.string(),
  vaultName: z.string(),
  path: z.string(),
  kind: z.enum(["concurrent_edit", "both_created"]),
  binary: z.boolean(),
  mine: VersionRef,
  incoming: VersionRef,
});
export type ConflictSummary = z.infer<typeof ConflictSummary>;
export const ConflictList = z.array(ConflictSummary);

export const BinaryMeta = z.object({ size: z.number().min(0), mime: z.string(), previewUrl: z.string().nullable() });
export type BinaryMeta = z.infer<typeof BinaryMeta>;

const base = ConflictSummary.omit({ binary: true });
export const ConflictDetail = z.discriminatedUnion("binary", [
  base.extend({ binary: z.literal(false), mineText: z.string(), incomingText: z.string() }),
  base.extend({ binary: z.literal(true), mineFile: BinaryMeta, incomingFile: BinaryMeta }),
]);
export type ConflictDetail = z.infer<typeof ConflictDetail>;

export const Resolution = z.union([
  z.literal("keep_mine"),
  z.literal("keep_incoming"),
  z.literal("keep_both"),
  z.object({ manual: z.string() }),
]);
export type Resolution = z.infer<typeof Resolution>;
/** expectedIncomingAt: the incoming version the user looked at (protocol §9.3, stale_resolution). */
export const ResolveRequest = z.object({ resolution: Resolution, expectedIncomingAt: z.string() });

export const BulkStrategy = z.enum(["keep_mine", "keep_incoming", "keep_both"]);
export type BulkStrategy = z.infer<typeof BulkStrategy>;
export const ResolveAllRequest = z.object({ strategy: BulkStrategy, ids: z.array(z.string()).min(1) });
export const ResolveAllResponse = z.object({ resolved: z.number().int().min(0) });
```

`packages/protocol/src/history.ts`:

```ts
import { z } from "zod";

export const FileList = z.object({
  files: z.array(z.object({ fileId: z.string(), path: z.string(), versions: z.number().int().min(1), lastChangedAt: z.string() })),
});
export type FileList = z.infer<typeof FileList>;

export const FileVersions = z.object({
  fileId: z.string(),
  path: z.string(),
  versions: z.array(z.object({ id: z.string(), at: z.string(), device: z.string(), size: z.number().min(0), current: z.boolean() })),
});
export type FileVersions = z.infer<typeof FileVersions>;

export const VersionContent = z.object({
  id: z.string(),
  path: z.string(),
  at: z.string(),
  mime: z.string(),
  size: z.number().min(0),
  text: z.string().nullable(),
  previewUrl: z.string().nullable(),
});
export type VersionContent = z.infer<typeof VersionContent>;

export const TrashList = z.object({
  items: z.array(z.object({ fileId: z.string(), path: z.string(), deletedAt: z.string(), expiresAt: z.string(), size: z.number().min(0) })),
});
export type TrashList = z.infer<typeof TrashList>;
```

`errors.ts`: aggiungere `"confirm_mismatch", "history_window", "pairing_closed",` prima di `"unauthorized"`. `index.ts`: esportare i quattro file.

Run: `pnpm --filter @kamino/protocol test && pnpm --filter @kamino/protocol build && pnpm --filter @kamino/protocol typecheck && pnpm --filter @kamino/protocol lint`.

```bash
git add packages/protocol && git commit -m "feat(protocol): add user area contract (vaults, devices, conflicts, history)"
```

---

### Task 2: Endpoint e MSW

**Files:** Modify `apps/web/src/api/http.ts` (`requestBlob`), `apps/web/src/api/endpoints.ts`, `apps/web/src/mocks/handlers.ts` (rinomina in `authHandlers`, rimozione di `/vaults/summary`), `apps/web/src/mocks/db.ts` (chiamata a `seedUserData`); Create `apps/web/src/mocks/userdata.ts`, `apps/web/src/mocks/user-handlers.ts`; Test `apps/web/src/mocks/user-handlers.test.ts`.

**Interfaces — Produces:** in `api`: `vaults()`, `vault(id)`, `updateVault(id, patch)`, `deleteVault(id, confirmName)`, `downloadZip(id, at?)` → `Promise<Blob>`, `devices()`, `device(id)`, `renameDevice(id, name)`, `revokeDevice(id)`, `startPairing(vaultId)`, `pairing(id)`, `approvePairing(id)`, `denyPairing(id)`, `cancelPairing(id)`, `conflicts()`, `conflict(id)`, `resolveConflict(id, resolution, expectedIncomingAt)`, `resolveAll(strategy, ids)`, `files(vaultId, q)`, `fileVersions(fileId)`, `version(id)`, `restoreVersion(id)`, `trash(vaultId)`, `restoreTrash(fileId)`. Mock: `ud` (stato), `seedUserData(preset?: "default" | "quota-almost-full")`, `simulatePairingRequest()`, `simulateStaleNext()`.

- [ ] **Step 1: Client**

In `apps/web/src/api/http.ts` aggiungere:

```ts
/** Binary response (e.g. ZIP download). Errors are ApiError like every other call. */
export async function requestBlob(path: string, opts: RequestOptions = {}): Promise<Blob> {
  const res = await send(path, opts);
  return res.blob();
}
```

In `apps/web/src/api/endpoints.ts` importare i nuovi schemi (`ConflictDetail`, `ConflictList`, `Device`, `DeviceList`, `FileList`, `FileVersions`, `PairingOffer`, `PairingState`, `ResolveAllResponse`, `TrashList`, `Vault`, `VaultList`, `VersionContent`, `type BulkStrategy`, `type Resolution`, `type VaultPatch`), `requestBlob`, e aggiungere all'oggetto `api`:

```ts
  vaults: () => request(VaultList, "/vaults"),
  vault: (id: string) => request(Vault, `/vaults/${encodeURIComponent(id)}`),
  updateVault: (id: string, body: VaultPatch) => request(Vault, `/vaults/${encodeURIComponent(id)}`, { method: "PATCH", body }),
  deleteVault: (id: string, confirmName: string) =>
    requestVoid(`/vaults/${encodeURIComponent(id)}`, { method: "DELETE", body: { confirmName } }),
  downloadZip: (id: string, at?: string) =>
    requestBlob(`/vaults/${encodeURIComponent(id)}/zip${at ? `?at=${encodeURIComponent(at)}` : ""}`),
  devices: () => request(DeviceList, "/devices"),
  device: (id: string) => request(Device, `/devices/${encodeURIComponent(id)}`),
  renameDevice: (id: string, name: string) =>
    request(Device, `/devices/${encodeURIComponent(id)}`, { method: "PATCH", body: { name } }),
  revokeDevice: (id: string) => request(Device, `/devices/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
  startPairing: (vaultId: string) => request(PairingOffer, `/vaults/${encodeURIComponent(vaultId)}/pairings`, { method: "POST" }),
  pairing: (id: string) => request(PairingState, `/pairings/${encodeURIComponent(id)}`),
  approvePairing: (id: string) => requestVoid(`/pairings/${encodeURIComponent(id)}/approve`, { method: "POST" }),
  denyPairing: (id: string) => requestVoid(`/pairings/${encodeURIComponent(id)}/deny`, { method: "POST" }),
  cancelPairing: (id: string) => requestVoid(`/pairings/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  conflicts: () => request(ConflictList, "/conflicts"),
  conflict: (id: string) => request(ConflictDetail, `/conflicts/${encodeURIComponent(id)}`),
  resolveConflict: (id: string, resolution: Resolution, expectedIncomingAt: string) =>
    requestVoid(`/conflicts/${encodeURIComponent(id)}/resolve`, { method: "POST", body: { resolution, expectedIncomingAt } }),
  resolveAll: (strategy: BulkStrategy, ids: string[]) =>
    request(ResolveAllResponse, "/conflicts/resolve-all", { method: "POST", body: { strategy, ids } }),
  files: (vaultId: string, q: string) =>
    request(FileList, `/vaults/${encodeURIComponent(vaultId)}/files?q=${encodeURIComponent(q)}`),
  fileVersions: (fileId: string) => request(FileVersions, `/files/${encodeURIComponent(fileId)}/versions`),
  version: (id: string) => request(VersionContent, `/versions/${encodeURIComponent(id)}`),
  restoreVersion: (id: string) => requestVoid(`/versions/${encodeURIComponent(id)}/restore`, { method: "POST" }),
  trash: (vaultId: string) => request(TrashList, `/vaults/${encodeURIComponent(vaultId)}/trash`),
  restoreTrash: (fileId: string) => requestVoid(`/trash/${encodeURIComponent(fileId)}/restore`, { method: "POST" }),
```

- [ ] **Step 2: Dati finti**

`apps/web/src/mocks/userdata.ts`:

```ts
import type { BinaryMeta, ConflictDetail, Device, Vault } from "@kamino/protocol";

// Fake user-area data (dev/tests only), shared by every signed-in user.
const NOW = Date.UTC(2026, 10, 8, 10, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const GB = 1024 ** 3;
const MB = 1024 ** 2;

export interface FakeVersion { id: string; fileId: string; at: string; device: string; size: number; text: string | null; previewUrl: string | null; mime: string }
export interface FakeFile { fileId: string; vaultId: string; path: string; versions: FakeVersion[] }
export interface FakeTrash { fileId: string; vaultId: string; path: string; deletedAt: string; expiresAt: string; size: number }
export interface FakePairing { id: string; vaultId: string; status: "waiting" | "requested" | "approved" | "denied" | "expired" | "cancelled"; expiresAt: number; request?: { deviceName: string; platform: string; pluginVersion: string; code: string } }

interface UserData {
  vaults: Vault[];
  baseLevel: Map<string, Vault["level"]>;
  quota: { usedBytes: number; limitBytes: number | null };
  devices: Device[];
  conflicts: ConflictDetail[];
  files: FakeFile[];
  trash: FakeTrash[];
  pairings: FakePairing[];
  staleNext: boolean;
  seq: number;
}

export const ud: UserData = {
  vaults: [], baseLevel: new Map(), quota: { usedBytes: 0, limitBytes: null }, devices: [], conflicts: [], files: [], trash: [], pairings: [], staleNext: false, seq: 0,
};

const swatch = (color: string): BinaryMeta => ({
  size: 48_213,
  mime: "image/svg+xml",
  previewUrl: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="${color}"/></svg>`)}`,
});

function longNote(incoming: boolean): string {
  const lines = ["# Piano", ""];
  for (let i = 1; i <= 120; i++) lines.push(`- Punto ${i}: descrizione del passo ${i}.${incoming && (i === 12 || i === 80) ? " (aggiornato)" : ""}`);
  return `${lines.join("\n")}\n`;
}

export function seedUserData(preset: "default" | "quota-almost-full" = "default"): void {
  ud.seq = 0;
  ud.staleNext = false;
  ud.pairings = [];
  const vault = (id: string, name: string, level: Vault["level"], o: Partial<Vault>): Vault => ({
    id, name, level, fileCount: 0, deviceCount: 0, conflicts: 0, usedBytes: 0, historyBytes: 0, trashBytes: 0,
    retentionDays: 30, maxRetentionDays: 90, historyFrom: iso(30 * DAY), ...o,
  });
  ud.vaults = [
    vault("v-notes", "Note", "decision", { fileCount: 128, deviceCount: 3, conflicts: 2, usedBytes: 1.2 * GB, historyBytes: 300 * MB, trashBytes: 12 * MB }),
    vault("v-work", "Lavoro", "decision", { fileCount: 512, deviceCount: 1, conflicts: 1, usedBytes: 0.9 * GB, historyBytes: 120 * MB, trashBytes: 0 }),
  ];
  ud.baseLevel = new Map([["v-notes", "attention"], ["v-work", "safe"]]);
  ud.quota = { usedBytes: preset === "quota-almost-full" ? 9.4 * GB : 2.1 * GB, limitBytes: 10 * GB };
  const dev = (o: Partial<Device> & Pick<Device, "id" | "vaultId" | "vaultName" | "name" | "platform">): Device => ({
    pluginVersion: "0.1.0", lastSeenAt: iso(2 * MIN), lastSyncAt: iso(2 * MIN), lag: 0, pending: 0, lastError: null, level: "safe", revoked: false, ...o,
  });
  ud.devices = [
    dev({ id: "d-mac", vaultId: "v-notes", vaultName: "Note", name: "MacBook", platform: "macOS" }),
    dev({ id: "d-iphone", vaultId: "v-notes", vaultName: "Note", name: "iPhone", platform: "iOS", lastSeenAt: iso(2 * DAY), lastSyncAt: iso(2 * DAY), pending: 3, lag: 14, level: "attention" }),
    dev({ id: "d-ipad", vaultId: "v-notes", vaultName: "Note", name: "iPad", platform: "iPadOS", lastError: "quota_exceeded", level: "blocked", pending: 2 }),
    dev({ id: "d-pc", vaultId: "v-work", vaultName: "Lavoro", name: "PC ufficio", platform: "Windows" }),
    dev({ id: "d-old", vaultId: "v-notes", vaultName: "Note", name: "Vecchio portatile", platform: "Linux", revoked: true, lastSeenAt: iso(40 * DAY), lastSyncAt: iso(40 * DAY) }),
  ];
  ud.conflicts = [
    { id: "c-shopping", vaultId: "v-notes", vaultName: "Note", path: "Spesa.md", kind: "concurrent_edit", binary: false,
      mine: { device: "MacBook", at: iso(20 * MIN) }, incoming: { device: "iPhone", at: iso(15 * MIN) },
      mineText: "# Spesa\n\n- latte\n- pane\n- uova (6)\n- caffè\n", incomingText: "# Spesa\n\n- latte\n- pane\n- uova (12)\n- caffè\n- mele\n" },
    { id: "c-plan", vaultId: "v-notes", vaultName: "Note", path: "Progetti/Piano.md", kind: "concurrent_edit", binary: false,
      mine: { device: "MacBook", at: iso(26 * HOUR) }, incoming: { device: "iPad", at: iso(25 * HOUR) }, mineText: longNote(false), incomingText: longNote(true) },
    { id: "c-photo", vaultId: "v-work", vaultName: "Lavoro", path: "Foto/vacanza.svg", kind: "both_created", binary: true,
      mine: { device: "PC ufficio", at: iso(2 * HOUR) }, incoming: { device: "iPhone", at: iso(HOUR) }, mineFile: swatch("teal"), incomingFile: swatch("orange") },
  ];
  const ver = (fileId: string, n: number, text: string): FakeVersion => ({
    id: `${fileId}-v${n}`, fileId, at: iso((5 - n) * DAY + HOUR), device: n % 2 ? "MacBook" : "iPhone", size: text.length, text, previewUrl: null, mime: "text/markdown",
  });
  ud.files = [
    { fileId: "f-idee", vaultId: "v-notes", path: "Idee.md", versions: [1, 2, 3, 4].map((n) => ver("f-idee", n, `# Idee\n\nVersione ${n} delle idee.\n`)) },
    { fileId: "f-diario", vaultId: "v-notes", path: "Diario/2026-11-07.md", versions: [1, 2, 3].map((n) => ver("f-diario", n, `Giornata, bozza ${n}.\n`)) },
    { fileId: "f-logo", vaultId: "v-work", path: "Loghi/logo.svg", versions: [1, 2].map((n) => ({ ...ver("f-logo", n, ""), text: null, mime: "image/svg+xml", previewUrl: swatch(n === 1 ? "navy" : "teal").previewUrl })) },
  ];
  ud.trash = [
    { fileId: "t-old", vaultId: "v-notes", path: "Vecchie note/bozza.md", deletedAt: iso(2 * DAY), expiresAt: iso(-5 * DAY), size: 2_048 },
    { fileId: "t-img", vaultId: "v-notes", path: "Allegati/scontrino.jpg", deletedAt: iso(DAY), expiresAt: iso(-6 * DAY), size: 340_000 },
    { fileId: "t-tmp", vaultId: "v-work", path: "tmp.md", deletedAt: iso(3 * HOUR), expiresAt: iso(-7 * DAY), size: 120 },
  ];
}

export const nextUd = (prefix: string) => `${prefix}-${++ud.seq}`;

/** Recomputes conflict counters and levels after a change. */
export function refreshVaults(): void {
  for (const v of ud.vaults) {
    v.conflicts = ud.conflicts.filter((c) => c.vaultId === v.id).length;
    v.deviceCount = ud.devices.filter((d) => d.vaultId === v.id && !d.revoked).length;
    v.level = v.conflicts > 0 ? "decision" : (ud.baseLevel.get(v.id) ?? "safe");
  }
}

/** Dev panel: the most recent waiting pairing receives a request from a new device. */
export function simulatePairingRequest(): void {
  const p = [...ud.pairings].reverse().find((x) => x.status === "waiting");
  if (!p) return;
  p.status = "requested";
  p.request = { deviceName: "Pixel", platform: "Android", pluginVersion: "0.1.0", code: "K7RX" };
}

/** Dev panel / tests: the next conflict resolution answers stale_resolution. */
export function simulateStaleNext(): void {
  ud.staleNext = true;
}

seedUserData();
```

In `apps/web/src/mocks/db.ts`, alla fine di `resetDb` (prima del `return` del preset `empty` e in fondo alla funzione), chiamare `seedUserData()` (import da `./userdata.js`).

- [ ] **Step 3: Test degli handler (falliscono)** — `apps/web/src/mocks/user-handlers.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { api } from "../api/endpoints.js";
import { ApiError } from "../api/http.js";
import { signInAs } from "./db.js";
import { simulatePairingRequest, simulateStaleNext, ud } from "./userdata.js";

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ApiError ? e.code : "?"));

describe("user area fake API", () => {
  it("vaults, rename, retention, delete with confirmation", async () => {
    signInAs("demo");
    const list = await api.vaults();
    expect(list.vaults.map((v) => v.name)).toEqual(["Note", "Lavoro"]);
    expect(list.quota.limitBytes).not.toBeNull();
    expect((await api.updateVault("v-notes", { name: "Appunti", retentionDays: 60 })).retentionDays).toBe(60);
    expect(await code(api.deleteVault("v-work", "lavoro"))).toBe("confirm_mismatch");
    await api.deleteVault("v-work", "Lavoro");
    expect((await api.vaults()).vaults).toHaveLength(1);
  });

  it("ZIP now and within the history window; outside → history_window", async () => {
    signInAs("demo");
    expect((await api.downloadZip("v-notes")).size).toBeGreaterThan(0);
    expect(await code(api.downloadZip("v-notes", "2020-01-01T00:00:00Z"))).toBe("history_window");
  });

  it("devices: rename and revoke", async () => {
    signInAs("demo");
    expect((await api.devices()).length).toBe(5);
    expect((await api.renameDevice("d-mac", "Studio")).name).toBe("Studio");
    expect((await api.revokeDevice("d-iphone")).revoked).toBe(true);
  });

  it("pairing from the web: waiting → requested → approved; answering twice → pairing_closed", async () => {
    signInAs("demo");
    const offer = await api.startPairing("v-notes");
    expect(offer.link).toContain("obsidian://");
    expect((await api.pairing(offer.pairingId)).status).toBe("waiting");
    simulatePairingRequest();
    const st = await api.pairing(offer.pairingId);
    expect(st).toMatchObject({ status: "requested", request: { code: "K7RX" } });
    await api.approvePairing(offer.pairingId);
    expect((await api.pairing(offer.pairingId)).status).toBe("approved");
    expect(await code(api.denyPairing(offer.pairingId))).toBe("pairing_closed");
  });

  it("conflicts: resolve, stale, gone, resolve all", async () => {
    signInAs("demo");
    const list = await api.conflicts();
    expect(list).toHaveLength(3);
    const c = await api.conflict("c-shopping");
    simulateStaleNext();
    expect(await code(api.resolveConflict("c-shopping", "keep_mine", c.incoming.at))).toBe("stale_resolution");
    const fresh = await api.conflict("c-shopping");
    expect(fresh.incoming.at).not.toBe(c.incoming.at);
    await api.resolveConflict("c-shopping", { manual: "merged" }, fresh.incoming.at);
    expect(await code(api.resolveConflict("c-shopping", "keep_mine", fresh.incoming.at))).toBe("not_found");
    expect(await api.resolveAll("keep_both", ["c-plan", "c-photo"])).toEqual({ resolved: 2 });
    expect(ud.vaults.every((v) => v.conflicts === 0)).toBe(true);
  });

  it("history and trash", async () => {
    signInAs("demo");
    const files = await api.files("v-notes", "idee");
    expect(files.files.map((f) => f.path)).toEqual(["Idee.md"]);
    const versions = await api.fileVersions("f-idee");
    expect(versions.versions.filter((v) => v.current)).toHaveLength(1);
    const old = versions.versions.find((v) => !v.current)!;
    expect((await api.version(old.id)).text).toContain("Versione");
    await api.restoreVersion(old.id);
    expect((await api.fileVersions("f-idee")).versions).toHaveLength(versions.versions.length + 1);
    const trash = await api.trash("v-notes");
    await api.restoreTrash(trash.items[0]!.fileId);
    expect((await api.trash("v-notes")).items).toHaveLength(trash.items.length - 1);
  });
});
```

- [ ] **Step 4: Handler** — `apps/web/src/mocks/user-handlers.ts`:

```ts
import { PROTOCOL_ACTION } from "@kamino/brand";
import { ResolveAllRequest, ResolveRequest, VaultDelete, VaultPatch, DevicePatch, type ErrorCode } from "@kamino/protocol";
import { http, HttpResponse } from "msw";
import { currentUser } from "./db.js";
import { nextUd, refreshVaults, ud } from "./userdata.js";

const API = "*/api/v1";
const fail = (status: number, code: ErrorCode) =>
  HttpResponse.json({ error: { code, message: code, retryable: false } }, { status });
const noContent = () => new HttpResponse(null, { status: 204 });
const unauthorized = () => (currentUser() ? null : fail(401, "unauthorized"));
async function json(req: Request): Promise<unknown> {
  return req.json().catch(() => undefined);
}

export const userHandlers = [
  http.get(`${API}/vaults/summary`, () =>
    unauthorized() ?? HttpResponse.json({ vaults: ud.vaults.map(({ id, name, level, conflicts }) => ({ id, name, level, conflicts })) }),
  ),
  http.get(`${API}/vaults`, () => unauthorized() ?? HttpResponse.json({ vaults: ud.vaults, quota: ud.quota })),
  http.get(`${API}/vaults/:id`, ({ params }) => {
    const v = ud.vaults.find((x) => x.id === params["id"]);
    return unauthorized() ?? (v ? HttpResponse.json(v) : fail(404, "not_found"));
  }),
  http.patch(`${API}/vaults/:id`, async ({ request, params }) => {
    const v = ud.vaults.find((x) => x.id === params["id"]);
    if (!v) return unauthorized() ?? fail(404, "not_found");
    const b = VaultPatch.safeParse(await json(request));
    if (!b.success) return fail(400, "internal");
    if (b.data.name !== undefined) v.name = b.data.name;
    if (b.data.retentionDays !== undefined) v.retentionDays = Math.min(b.data.retentionDays, v.maxRetentionDays);
    return unauthorized() ?? HttpResponse.json(v);
  }),
  http.delete(`${API}/vaults/:id`, async ({ request, params }) => {
    const v = ud.vaults.find((x) => x.id === params["id"]);
    if (!v) return unauthorized() ?? fail(404, "not_found");
    const b = VaultDelete.safeParse(await json(request));
    if (!b.success || b.data.confirmName !== v.name) return fail(400, "confirm_mismatch");
    ud.vaults = ud.vaults.filter((x) => x !== v);
    ud.devices = ud.devices.filter((d) => d.vaultId !== v.id);
    ud.conflicts = ud.conflicts.filter((c) => c.vaultId !== v.id);
    return unauthorized() ?? noContent();
  }),
  http.get(`${API}/vaults/:id/zip`, ({ request, params }) => {
    const v = ud.vaults.find((x) => x.id === params["id"]);
    if (!v) return unauthorized() ?? fail(404, "not_found");
    const at = new URL(request.url).searchParams.get("at");
    if (at && Date.parse(at) < Date.parse(v.historyFrom)) return fail(410, "history_window");
    // String body: a jsdom Blob is not accepted by MSW under Node; the client reads it as a blob anyway.
    return new HttpResponse("PK\u0003\u0004 fake zip", {
      headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${v.name}.zip"` },
    });
  }),
  http.get(`${API}/devices`, () => unauthorized() ?? HttpResponse.json(ud.devices)),
  http.get(`${API}/devices/:id`, ({ params }) => {
    const d = ud.devices.find((x) => x.id === params["id"]);
    return unauthorized() ?? (d ? HttpResponse.json(d) : fail(404, "not_found"));
  }),
  http.patch(`${API}/devices/:id`, async ({ request, params }) => {
    const d = ud.devices.find((x) => x.id === params["id"]);
    if (!d) return unauthorized() ?? fail(404, "not_found");
    const b = DevicePatch.safeParse(await json(request));
    if (!b.success) return fail(400, "internal");
    d.name = b.data.name;
    return unauthorized() ?? HttpResponse.json(d);
  }),
  http.post(`${API}/devices/:id/revoke`, ({ params }) => {
    const d = ud.devices.find((x) => x.id === params["id"]);
    if (!d) return unauthorized() ?? fail(404, "not_found");
    d.revoked = true;
    d.level = "blocked";
    refreshVaults();
    return unauthorized() ?? HttpResponse.json(d);
  }),
  http.post(`${API}/vaults/:id/pairings`, ({ params }) => {
    const v = ud.vaults.find((x) => x.id === params["id"]);
    if (!v) return unauthorized() ?? fail(404, "not_found");
    const p = { id: nextUd("p"), vaultId: v.id, status: "waiting" as const, expiresAt: Date.now() + 10 * 60_000 };
    ud.pairings.push(p);
    const link = `obsidian://${PROTOCOL_ACTION}?server=${encodeURIComponent(location.origin)}&token=${p.id}-token`;
    return unauthorized() ?? HttpResponse.json({ pairingId: p.id, link, expiresAt: new Date(p.expiresAt).toISOString() });
  }),
  http.get(`${API}/pairings/:id`, ({ params }) => {
    const p = ud.pairings.find((x) => x.id === params["id"]);
    if (!p) return unauthorized() ?? fail(404, "not_found");
    if ((p.status === "waiting" || p.status === "requested") && Date.now() > p.expiresAt) p.status = "expired";
    return unauthorized() ?? HttpResponse.json({ status: p.status, ...(p.request ? { request: p.request } : {}) });
  }),
  ...(["approve", "deny", "cancel"] as const).map((action) =>
    http.post(`${API}/pairings/:id/${action}`, ({ params }) => {
      const p = ud.pairings.find((x) => x.id === params["id"]);
      if (!p) return unauthorized() ?? fail(404, "not_found");
      const open = action === "cancel" ? p.status === "waiting" || p.status === "requested" : p.status === "requested";
      if (!open) return fail(409, "pairing_closed");
      p.status = action === "approve" ? "approved" : action === "deny" ? "denied" : "cancelled";
      if (action === "approve" && p.request) {
        const v = ud.vaults.find((x) => x.id === p.vaultId)!;
        ud.devices.push({
          id: nextUd("d"), vaultId: v.id, vaultName: v.name, name: p.request.deviceName, platform: p.request.platform,
          pluginVersion: p.request.pluginVersion, lastSeenAt: new Date().toISOString(), lastSyncAt: null, lag: 0, pending: 0,
          lastError: null, level: "working", revoked: false,
        });
        refreshVaults();
      }
      return unauthorized() ?? noContent();
    }),
  ),
  http.get(`${API}/conflicts`, () =>
    unauthorized() ??
    HttpResponse.json(
      ud.conflicts.map(({ id, vaultId, vaultName, path, kind, binary, mine, incoming }) => ({ id, vaultId, vaultName, path, kind, binary, mine, incoming })),
    ),
  ),
  http.get(`${API}/conflicts/:id`, ({ params }) => {
    const c = ud.conflicts.find((x) => x.id === params["id"]);
    return unauthorized() ?? (c ? HttpResponse.json(c) : fail(404, "not_found"));
  }),
  http.post(`${API}/conflicts/resolve-all`, async ({ request }) => {
    const b = ResolveAllRequest.safeParse(await json(request));
    if (!b.success) return fail(400, "internal");
    const before = ud.conflicts.length;
    ud.conflicts = ud.conflicts.filter((c) => !b.data.ids.includes(c.id));
    refreshVaults();
    return unauthorized() ?? HttpResponse.json({ resolved: before - ud.conflicts.length });
  }),
  http.post(`${API}/conflicts/:id/resolve`, async ({ request, params }) => {
    const c = ud.conflicts.find((x) => x.id === params["id"]);
    if (!c) return unauthorized() ?? fail(404, "not_found");
    const b = ResolveRequest.safeParse(await json(request));
    if (!b.success) return fail(400, "internal");
    if (ud.staleNext || b.data.expectedIncomingAt !== c.incoming.at) {
      ud.staleNext = false;
      c.incoming = { ...c.incoming, at: new Date().toISOString() };
      if (!c.binary) c.incomingText = `${c.incomingText}- newer line\n`;
      return fail(409, "stale_resolution");
    }
    ud.conflicts = ud.conflicts.filter((x) => x !== c);
    refreshVaults();
    return unauthorized() ?? noContent();
  }),
  http.get(`${API}/vaults/:id/files`, ({ request, params }) => {
    const q = (new URL(request.url).searchParams.get("q") ?? "").toLowerCase();
    const files = ud.files
      .filter((f) => f.vaultId === params["id"] && f.path.toLowerCase().includes(q))
      .map((f) => ({ fileId: f.fileId, path: f.path, versions: f.versions.length, lastChangedAt: f.versions.at(-1)!.at }));
    return unauthorized() ?? HttpResponse.json({ files });
  }),
  http.get(`${API}/files/:id/versions`, ({ params }) => {
    const f = ud.files.find((x) => x.fileId === params["id"]);
    if (!f) return unauthorized() ?? fail(404, "not_found");
    const versions = [...f.versions].reverse().map((v, i) => ({ id: v.id, at: v.at, device: v.device, size: v.size, current: i === 0 }));
    return unauthorized() ?? HttpResponse.json({ fileId: f.fileId, path: f.path, versions });
  }),
  http.get(`${API}/versions/:id`, ({ params }) => {
    const v = ud.files.flatMap((f) => f.versions.map((x) => ({ ...x, path: f.path }))).find((x) => x.id === params["id"]);
    if (!v) return unauthorized() ?? fail(404, "not_found");
    return unauthorized() ?? HttpResponse.json({ id: v.id, path: v.path, at: v.at, mime: v.mime, size: v.size, text: v.text, previewUrl: v.previewUrl });
  }),
  http.post(`${API}/versions/:id/restore`, ({ params }) => {
    const f = ud.files.find((x) => x.versions.some((v) => v.id === params["id"]));
    const v = f?.versions.find((x) => x.id === params["id"]);
    if (!f || !v) return unauthorized() ?? fail(404, "not_found");
    f.versions.push({ ...v, id: nextUd(`${f.fileId}-v`), at: new Date().toISOString(), device: "Web" });
    return unauthorized() ?? noContent();
  }),
  http.get(`${API}/vaults/:id/trash`, ({ params }) =>
    unauthorized() ??
    HttpResponse.json({
      items: ud.trash
        .filter((t) => t.vaultId === params["id"])
        .map(({ fileId, path, deletedAt, expiresAt, size }) => ({ fileId, path, deletedAt, expiresAt, size })),
    }),
  ),
  http.post(`${API}/trash/:id/restore`, ({ params }) => {
    const t = ud.trash.find((x) => x.fileId === params["id"]);
    if (!t) return unauthorized() ?? fail(404, "not_found");
    ud.trash = ud.trash.filter((x) => x !== t);
    return unauthorized() ?? noContent();
  }),
];
```

(Se il lint segnala `_v` inutilizzato nel cestino, mappare i campi in modo esplicito come per il registro di sicurezza.) Ordine delle rotte: `/vaults/summary` e `/conflicts/resolve-all` prima delle rotte con `:id`.

In `apps/web/src/mocks/handlers.ts`: rinominare l'array in `authHandlers`, togliere l'handler di `/vaults/summary` e aggiungere in fondo `export const handlers = [...authHandlers, ...userHandlers];` (import da `./user-handlers.js`).

Run: `pnpm --filter @kamino/web test` → PASS; typecheck, lint, format.

```bash
git add apps/web && git commit -m "feat(web): add user area API calls and fake data"
```

---

### Task 3: Panoramica, vault, dispositivi

**Files:** Create `apps/web/src/lib/format.ts`, `apps/web/src/components/status/LevelBadge.tsx`, `apps/web/src/pages/overview/OverviewPage.tsx`, `apps/web/src/pages/vaults/{VaultsPage,VaultCard,VaultPage,VaultDevicesTab,VaultConflictsTab}.tsx`, `apps/web/src/pages/devices/{DevicesPage,DevicePage}.tsx`, `apps/web/src/components/ConfirmDialog.tsx`; Test `apps/web/src/pages/overview/overview.test.tsx`, `apps/web/src/pages/vaults/vaults.test.tsx`, `apps/web/src/pages/devices/devices.test.tsx`; Modify `apps/web/src/app/AppShell.tsx` (usa `LevelBadge`), `apps/web/src/router.tsx`, i18n.

**Interfaces — Produces:** `formatBytes(n, lang)`, `formatDateTime(iso, lang)`, `formatAgo(iso, lang, now?)`; `LevelBadge({ level })`, `worstLevel(levels)`; `ConfirmDialog({ open, title, text, confirmText, onConfirm, onOpenChange, destructive?, children? })`; route `vaultRoute` (`/vaults/$vaultId`, ricerca `{ tab: "devices" | "conflicts" | "history" | "settings" }`), `deviceRoute` (`/devices/$deviceId`); `VaultCard({ vault })`; `openAddDevice` arriva nel Task 4 (qui i bottoni "Aggiungi un dispositivo" aprono `AddDeviceDialog` importato dal Task 4: in questo task il bottone c'è ma è collegato a uno stato `addOpen` e alla finestra creata nel Task 4; fino ad allora renderizza `null`).

- [ ] **Step 1: Testi** — aggiungere a `it.json` / `en.json` (oggetti di primo livello):

```json
"overview": {
  "title": "Panoramica",
  "space": "Spazio",
  "spaceOf": "{{used}} di {{limit}}",
  "spaceUnlimited": "{{used}}, nessun limite",
  "spaceWarning": "Spazio quasi esaurito: libera spazio o chiedi all'amministratore di aumentare la quota.",
  "vaults": "Vault",
  "noVaults": "Nessun vault. Il primo si crea da Obsidian, con il plugin.",
  "attention": "Dispositivi da guardare",
  "allDevices": "Tutti i dispositivi",
  "addDevice": "Aggiungi un dispositivo"
},
"vault": {
  "files": "{{count}} file",
  "devices": "{{count}} dispositivi",
  "conflicts": "{{count}} conflitti",
  "space": "{{total}} · storico {{history}} · cestino {{trash}}",
  "tabs": { "devices": "Dispositivi", "conflicts": "Conflitti", "history": "Storico e cestino", "settings": "Impostazioni" },
  "noConflicts": "Nessun conflitto in questo vault.",
  "openConflicts": "Apri nel centro conflitti",
  "notFound": "Vault non trovato."
},
"device": {
  "title": "Dispositivi",
  "vault": "Vault",
  "platform": "Piattaforma",
  "pluginVersion": "Versione del plugin",
  "lastSeen": "Ultimo contatto",
  "lastSync": "Ultimo sync riuscito",
  "never": "mai",
  "lag": "Ritardo",
  "lagValue": "{{count}} modifiche indietro",
  "pending": "Modifiche in attesa",
  "lastError": "Ultimo errore",
  "noError": "nessuno",
  "revoked": "Revocato",
  "rename": "Rinomina",
  "name": "Nome",
  "save": "Salva",
  "revoke": "Revoca il dispositivo",
  "revokeTitle": "Revocare “{{name}}”?",
  "revokeText": "Il dispositivo smette subito di sincronizzare. I file già presenti sul dispositivo non vengono cancellati.",
  "revokeConfirm": "Revoca",
  "revokedDone": "Dispositivo revocato.",
  "renamed": "Nome aggiornato.",
  "notFound": "Dispositivo non trovato.",
  "cancel": "Annulla"
}
```

```json
"overview": {
  "title": "Overview",
  "space": "Storage",
  "spaceOf": "{{used}} of {{limit}}",
  "spaceUnlimited": "{{used}}, no limit",
  "spaceWarning": "Storage almost full: free some space or ask the administrator to raise the quota.",
  "vaults": "Vaults",
  "noVaults": "No vaults yet. The first one is created from Obsidian, with the plugin.",
  "attention": "Devices to check",
  "allDevices": "All devices",
  "addDevice": "Add a device"
},
"vault": {
  "files": "{{count}} files",
  "devices": "{{count}} devices",
  "conflicts": "{{count}} conflicts",
  "space": "{{total}} · history {{history}} · trash {{trash}}",
  "tabs": { "devices": "Devices", "conflicts": "Conflicts", "history": "History and trash", "settings": "Settings" },
  "noConflicts": "No conflicts in this vault.",
  "openConflicts": "Open in the conflict center",
  "notFound": "Vault not found."
},
"device": {
  "title": "Devices",
  "vault": "Vault",
  "platform": "Platform",
  "pluginVersion": "Plugin version",
  "lastSeen": "Last seen",
  "lastSync": "Last successful sync",
  "never": "never",
  "lag": "Lag",
  "lagValue": "{{count}} changes behind",
  "pending": "Pending changes",
  "lastError": "Last error",
  "noError": "none",
  "revoked": "Revoked",
  "rename": "Rename",
  "name": "Name",
  "save": "Save",
  "revoke": "Revoke the device",
  "revokeTitle": "Revoke “{{name}}”?",
  "revokeText": "The device stops syncing right away. Files already on the device are not deleted.",
  "revokeConfirm": "Revoke",
  "revokedDone": "Device revoked.",
  "renamed": "Name updated.",
  "notFound": "Device not found.",
  "cancel": "Cancel"
}
```

- [ ] **Step 2: Utilità e componenti condivisi**

`apps/web/src/lib/format.ts`:

```ts
import { formatAge, type Lang } from "@kamino/status";

export function formatBytes(bytes: number, lang: string): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${new Intl.NumberFormat(lang, { maximumFractionDigits: i === 0 ? 0 : 1 }).format(v)} ${units[i]}`;
}

export function formatDateTime(iso: string, lang: string): string {
  return new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

/** "2 min", "3 h", "2 g" (same compact ages as the plugin, from @kamino/status). */
export function formatAgo(iso: string, lang: string, now = Date.now()): string {
  return formatAge(Math.max(0, now - Date.parse(iso)), (lang === "en" ? "en" : "it") as Lang);
}
```

`apps/web/src/components/status/LevelBadge.tsx` (spostato da `AppShell.tsx`):

```tsx
import type { Level } from "@kamino/status";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { LEVEL_CLASSES, LEVEL_DOT_CLASSES, STATUS_ICONS } from "./status-icons.js";

const SEVERITY: Level[] = ["safe", "working", "attention", "decision", "blocked"];
const LEVEL_ICON = {
  safe: "shield-check",
  working: "refresh-cw",
  attention: "triangle-alert",
  decision: "git-compare-arrows",
  blocked: "octagon-alert",
} as const;

export function worstLevel(levels: Level[]): Level {
  return levels.reduce<Level>((a, b) => (SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a), "safe");
}

export function LevelBadge({ level }: { level: Level }) {
  const { t } = useTranslation();
  const Icon = STATUS_ICONS[LEVEL_ICON[level]];
  return (
    <span role="status" className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", LEVEL_CLASSES[level])}>
      <Icon aria-hidden="true" className="size-3.5" />
      {t(`shell.levels.${level}`)}
    </span>
  );
}

export function LevelDot({ level }: { level: Level }) {
  return <span aria-hidden="true" className={cn("inline-block size-2.5 rounded-full", LEVEL_DOT_CLASSES[level])} />;
}
```

In `AppShell.tsx`: rimuovere `SEVERITY`, `LEVEL_ICON`, `LevelBadge` locali; importare `LevelBadge`, `worstLevel` da `../components/status/LevelBadge.js`; `const overall = worstLevel(summary?.vaults.map((v) => v.level) ?? []);`.

`apps/web/src/components/ConfirmDialog.tsx`:

```tsx
import type { ReactNode } from "react";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";

export function ConfirmDialog({
  open, onOpenChange, title, text, confirmText, cancelText, onConfirm, destructive, busy, children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  text: string;
  confirmText: string;
  cancelText: string;
  onConfirm: () => void;
  destructive?: boolean;
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{text}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{cancelText}</Button>
          <Button variant={destructive ? "destructive" : "default"} disabled={busy} onClick={onConfirm}>{confirmText}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Test (falliscono)**

`apps/web/src/pages/overview/overview.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { signInAs } from "../../mocks/db.js";
import { seedUserData, ud } from "../../mocks/userdata.js";
import { renderRoute } from "../../test/render.js";

afterEach(cleanup);

describe("OverviewPage", () => {
  it("shows space, vault cards and devices to check", async () => {
    signInAs("demo");
    await renderRoute("/");
    expect(await screen.findByText(/di 10 GB/)).toBeDefined();
    expect(screen.queryByText(/Spazio quasi esaurito/)).toBeNull();
    const vaults = screen.getByRole("region", { name: "Vault" });
    expect(within(vaults).getByText("Note")).toBeDefined();
    expect(within(vaults).getByText("Lavoro")).toBeDefined();
    const attention = screen.getByRole("region", { name: "Dispositivi da guardare" });
    expect(within(attention).getByText("iPhone")).toBeDefined();
    expect(within(attention).getByText("iPad")).toBeDefined();
    expect(within(attention).queryByText("MacBook")).toBeNull();
  });

  it("warns at 90% of the quota", async () => {
    seedUserData("quota-almost-full");
    signInAs("demo");
    await renderRoute("/");
    expect(await screen.findByText(/Spazio quasi esaurito/)).toBeDefined();
  });

  it("no vaults: explains to create one from the plugin", async () => {
    ud.vaults = [];
    ud.devices = [];
    signInAs("demo");
    await renderRoute("/");
    expect(await screen.findByText(/Il primo si crea da Obsidian/)).toBeDefined();
  });
});
```

`apps/web/src/pages/vaults/vaults.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { signInAs } from "../../mocks/db.js";
import { renderRoute } from "../../test/render.js";

afterEach(cleanup);

describe("Vaults", () => {
  it("list → detail with header and devices tab", async () => {
    signInAs("demo");
    const { router } = await renderRoute("/vaults");
    fireEvent.click(await screen.findByRole("link", { name: /Note/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/vaults/v-notes"));
    expect(await screen.findByRole("heading", { name: "Note" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Dispositivi" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("MacBook")).toBeDefined();
  });

  it("tabs follow the URL", async () => {
    signInAs("demo");
    const { router } = await renderRoute("/vaults/v-notes?tab=conflicts");
    expect(await screen.findByText("Spesa.md")).toBeDefined();
    fireEvent.click(screen.getByRole("tab", { name: "Impostazioni" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: "settings" }));
  });

  it("unknown vault", async () => {
    signInAs("demo");
    await renderRoute("/vaults/nope");
    expect(await screen.findByText("Vault non trovato.")).toBeDefined();
  });
});
```

`apps/web/src/pages/devices/devices.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { signInAs } from "../../mocks/db.js";
import { ud } from "../../mocks/userdata.js";
import { renderRoute } from "../../test/render.js";

afterEach(cleanup);

describe("Devices", () => {
  it("list shows every device; revoked ones are marked", async () => {
    signInAs("demo");
    await renderRoute("/devices");
    expect(await screen.findByText("MacBook")).toBeDefined();
    expect(screen.getByText("Vecchio portatile")).toBeDefined();
    expect(screen.getAllByText("Revocato").length).toBeGreaterThan(0);
  });

  it("detail shows D-06 fields, renames and revokes with confirmation", async () => {
    signInAs("demo");
    await renderRoute("/devices/d-iphone");
    expect(await screen.findByText("14 modifiche indietro")).toBeDefined();
    expect(screen.getByText("iOS")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Nome", { selector: "input" }), { target: { value: "iPhone 15" } });
    fireEvent.click(screen.getByRole("button", { name: "Salva" }));
    await waitFor(() => expect(ud.devices.find((d) => d.id === "d-iphone")!.name).toBe("iPhone 15"));
    fireEvent.click(screen.getByRole("button", { name: "Revoca il dispositivo" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/non vengono cancellati/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoca" }));
    await waitFor(() => expect(ud.devices.find((d) => d.id === "d-iphone")!.revoked).toBe(true));
  });
});
```

- [ ] **Step 4: Pagine**

`apps/web/src/pages/vaults/VaultCard.tsx`:

```tsx
import type { Vault } from "@kamino/protocol";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { LevelBadge, LevelDot } from "../../components/status/LevelBadge.js";

export function VaultCard({ vault }: { vault: Vault }) {
  const { t } = useTranslation();
  return (
    <Link
      to="/vaults/$vaultId"
      params={{ vaultId: vault.id }}
      search={{ tab: "devices" }}
      className="bg-card hover:border-ring block space-y-2 rounded-xl border p-4"
    >
      <span className="flex items-center gap-2 font-serif text-lg font-semibold">
        <LevelDot level={vault.level} />
        {vault.name}
      </span>
      <span className="text-muted-foreground block text-sm">
        {t("vault.files", { count: vault.fileCount })} · {t("vault.devices", { count: vault.deviceCount })}
      </span>
      <LevelBadge level={vault.level} />
    </Link>
  );
}
```

`apps/web/src/pages/overview/OverviewPage.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { LevelBadge } from "../../components/status/LevelBadge.js";
import { Button } from "../../components/ui/button.js";
import { formatBytes } from "../../lib/format.js";
import { AddDeviceDialog } from "../devices/AddDeviceDialog.js";
import { VaultCard } from "../vaults/VaultCard.js";

const ATTENTION = new Set(["attention", "decision", "blocked"]);

export function OverviewPage() {
  const { t, i18n } = useTranslation();
  useDocumentTitle(t("overview.title"));
  const [addOpen, setAddOpen] = useState(false);
  const vaults = useQuery({ queryKey: ["vaults"], queryFn: api.vaults });
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices });
  const data = vaults.data;
  if (!data) return null;
  const { usedBytes, limitBytes } = data.quota;
  const ratio = limitBytes ? usedBytes / limitBytes : 0;
  const watch = (devices.data ?? []).filter((d) => !d.revoked && ATTENTION.has(d.level)).slice(0, 5);
  const lang = i18n.language;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-2xl font-semibold">{t("overview.title")}</h1>
        {data.vaults.length > 0 && <Button onClick={() => setAddOpen(true)}>{t("overview.addDevice")}</Button>}
      </div>

      <section aria-label={t("overview.space")} className="bg-card space-y-2 rounded-xl border p-4">
        <p className="text-sm font-medium">{t("overview.space")}</p>
        <p>
          {limitBytes
            ? t("overview.spaceOf", { used: formatBytes(usedBytes, lang), limit: formatBytes(limitBytes, lang) })
            : t("overview.spaceUnlimited", { used: formatBytes(usedBytes, lang) })}
        </p>
        {limitBytes ? <progress className="w-full" max={limitBytes} value={usedBytes} /> : null}
        {ratio >= 0.9 && (
          <p role="alert" className="bg-status-attention-surface text-status-attention rounded-md p-2 text-sm">
            {t("overview.spaceWarning")}
          </p>
        )}
      </section>

      <section aria-label={t("overview.vaults")} className="space-y-3">
        <h2 className="font-serif text-lg font-semibold">{t("overview.vaults")}</h2>
        {data.vaults.length === 0 ? (
          <p className="text-muted-foreground">{t("overview.noVaults")}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {data.vaults.map((v) => <VaultCard key={v.id} vault={v} />)}
          </div>
        )}
      </section>

      {watch.length > 0 && (
        <section aria-label={t("overview.attention")} className="space-y-3">
          <h2 className="font-serif text-lg font-semibold">{t("overview.attention")}</h2>
          <ul className="bg-card divide-y rounded-xl border">
            {watch.map((d) => (
              <li key={d.id}>
                <Link to="/devices/$deviceId" params={{ deviceId: d.id }} className="hover:bg-muted flex flex-wrap items-center justify-between gap-2 p-3">
                  <span>
                    <span className="font-medium">{d.name}</span> <span className="text-muted-foreground text-sm">· {d.vaultName}</span>
                  </span>
                  <LevelBadge level={d.level} />
                </Link>
              </li>
            ))}
          </ul>
          <Link to="/devices" className="text-link text-sm underline">{t("overview.allDevices")}</Link>
        </section>
      )}
      <AddDeviceDialog open={addOpen} onOpenChange={setAddOpen} vaults={data.vaults} />
    </div>
  );
}
```

`apps/web/src/pages/vaults/VaultsPage.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { VaultCard } from "./VaultCard.js";

export function VaultsPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("nav.vaults"));
  const vaults = useQuery({ queryKey: ["vaults"], queryFn: api.vaults }).data?.vaults;
  return (
    <div className="space-y-4">
      <h1 className="font-serif text-2xl font-semibold">{t("nav.vaults")}</h1>
      {vaults && vaults.length === 0 && <p className="text-muted-foreground">{t("overview.noVaults")}</p>}
      <div className="grid gap-3 sm:grid-cols-2">{vaults?.map((v) => <VaultCard key={v.id} vault={v} />)}</div>
    </div>
  );
}
```

`apps/web/src/pages/vaults/VaultPage.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { LevelBadge } from "../../components/status/LevelBadge.js";
import { formatBytes } from "../../lib/format.js";
import { vaultRoute, VAULT_TABS, type VaultTab } from "../../router.js";
import { VaultConflictsTab } from "./VaultConflictsTab.js";
import { VaultDevicesTab } from "./VaultDevicesTab.js";
import { VaultHistoryTab } from "./VaultHistoryTab.js";
import { VaultSettingsTab } from "./VaultSettingsTab.js";

export function VaultPage() {
  const { t, i18n } = useTranslation();
  const { vaultId } = vaultRoute.useParams();
  const { tab } = vaultRoute.useSearch();
  const navigate = useNavigate();
  const vault = useQuery({ queryKey: ["vault", vaultId], queryFn: () => api.vault(vaultId) });
  useDocumentTitle(vault.data?.name ?? t("nav.vaults"));
  if (vault.isError) return <p>{t("vault.notFound")}</p>;
  const v = vault.data;
  if (!v) return null;
  const lang = i18n.language;
  const select = (next: VaultTab) => void navigate({ to: "/vaults/$vaultId", params: { vaultId }, search: { tab: next }, replace: true });

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="font-serif text-2xl font-semibold">{v.name}</h1>
          <LevelBadge level={v.level} />
        </div>
        <p className="text-muted-foreground text-sm">
          {t("vault.files", { count: v.fileCount })} · {t("vault.devices", { count: v.deviceCount })} ·{" "}
          {t("vault.space", { total: formatBytes(v.usedBytes, lang), history: formatBytes(v.historyBytes, lang), trash: formatBytes(v.trashBytes, lang) })}
        </p>
      </header>
      <div role="tablist" aria-label={v.name} className="flex flex-wrap gap-1 border-b">
        {VAULT_TABS.map((id) => (
          <button
            key={id}
            role="tab"
            id={`vault-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="vault-tabpanel"
            onClick={() => select(id)}
            className={tab === id ? "px-3 py-2 text-sm font-semibold shadow-[inset_0_-2px_0_var(--link)]" : "text-muted-foreground px-3 py-2 text-sm"}
          >
            {t(`vault.tabs.${id}`)}
            {id === "conflicts" && v.conflicts > 0 ? ` · ${v.conflicts}` : ""}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="vault-tabpanel" aria-labelledby={`vault-tab-${tab}`}>
        {tab === "devices" && <VaultDevicesTab vault={v} />}
        {tab === "conflicts" && <VaultConflictsTab vault={v} />}
        {tab === "history" && <VaultHistoryTab vault={v} />}
        {tab === "settings" && <VaultSettingsTab vault={v} />}
      </div>
    </div>
  );
}
```

Nota: il nome accessibile della scheda Conflitti include il contatore ("Conflitti · 2"); nei test usare `getByRole("tab", { name: /Conflitti/ })` se serve.

`apps/web/src/pages/vaults/VaultDevicesTab.tsx`:

```tsx
import type { Vault } from "@kamino/protocol";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { LevelBadge } from "../../components/status/LevelBadge.js";
import { Button } from "../../components/ui/button.js";
import { formatAgo } from "../../lib/format.js";
import { AddDeviceDialog } from "../devices/AddDeviceDialog.js";

export function VaultDevicesTab({ vault }: { vault: Vault }) {
  const { t, i18n } = useTranslation();
  const [addOpen, setAddOpen] = useState(false);
  const devices = (useQuery({ queryKey: ["devices"], queryFn: api.devices }).data ?? []).filter((d) => d.vaultId === vault.id);
  return (
    <div className="space-y-3">
      <ul className="bg-card divide-y rounded-xl border">
        {devices.map((d) => (
          <li key={d.id}>
            <Link to="/devices/$deviceId" params={{ deviceId: d.id }} className={`hover:bg-muted flex flex-wrap items-center justify-between gap-2 p-3 ${d.revoked ? "opacity-60" : ""}`}>
              <span>
                <span className="font-medium">{d.name}</span>{" "}
                <span className="text-muted-foreground text-sm">
                  · {d.platform} · {d.lastSyncAt ? formatAgo(d.lastSyncAt, i18n.language) : t("device.never")}
                </span>
              </span>
              {d.revoked ? <span className="text-sm">{t("device.revoked")}</span> : <LevelBadge level={d.level} />}
            </Link>
          </li>
        ))}
      </ul>
      <Button onClick={() => setAddOpen(true)}>{t("overview.addDevice")}</Button>
      <AddDeviceDialog open={addOpen} onOpenChange={setAddOpen} vaults={[vault]} />
    </div>
  );
}
```

`apps/web/src/pages/vaults/VaultConflictsTab.tsx`:

```tsx
import type { Vault } from "@kamino/protocol";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";

export function VaultConflictsTab({ vault }: { vault: Vault }) {
  const { t } = useTranslation();
  const conflicts = (useQuery({ queryKey: ["conflicts"], queryFn: api.conflicts }).data ?? []).filter((c) => c.vaultId === vault.id);
  if (conflicts.length === 0) return <p className="text-muted-foreground">{t("vault.noConflicts")}</p>;
  return (
    <ul className="bg-card divide-y rounded-xl border">
      {conflicts.map((c) => (
        <li key={c.id}>
          <Link to="/conflicts/$conflictId" params={{ conflictId: c.id }} className="hover:bg-muted flex justify-between gap-2 p-3">
            <span className="font-medium">{c.path}</span>
            <span className="text-muted-foreground text-sm">{c.incoming.device}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
```

`apps/web/src/pages/devices/DevicesPage.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { LevelBadge } from "../../components/status/LevelBadge.js";
import { formatAgo } from "../../lib/format.js";

export function DevicesPage() {
  const { t, i18n } = useTranslation();
  useDocumentTitle(t("device.title"));
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices }).data ?? [];
  const sorted = [...devices].sort((a, b) => Number(a.revoked) - Number(b.revoked));
  return (
    <div className="space-y-4">
      <h1 className="font-serif text-2xl font-semibold">{t("device.title")}</h1>
      <ul className="bg-card divide-y rounded-xl border">
        {sorted.map((d) => (
          <li key={d.id}>
            <Link to="/devices/$deviceId" params={{ deviceId: d.id }} className={`hover:bg-muted flex flex-wrap items-center justify-between gap-2 p-3 ${d.revoked ? "opacity-60" : ""}`}>
              <span>
                <span className="font-medium">{d.name}</span>{" "}
                <span className="text-muted-foreground text-sm">
                  · {d.vaultName} · {d.platform} · {d.lastSyncAt ? formatAgo(d.lastSyncAt, i18n.language) : t("device.never")}
                </span>
              </span>
              {d.revoked ? <span className="text-sm">{t("device.revoked")}</span> : <LevelBadge level={d.level} />}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

`apps/web/src/pages/devices/DevicePage.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { LevelBadge } from "../../components/status/LevelBadge.js";
import { TextField } from "../../components/TextField.js";
import { Button } from "../../components/ui/button.js";
import { formatDateTime } from "../../lib/format.js";
import { deviceRoute } from "../../router.js";

export function DevicePage() {
  const { t, i18n } = useTranslation();
  const { deviceId } = deviceRoute.useParams();
  const qc = useQueryClient();
  const device = useQuery({ queryKey: ["device", deviceId], queryFn: () => api.device(deviceId) });
  const d = device.data;
  useDocumentTitle(d?.name ?? t("device.title"));
  const [name, setName] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  useEffect(() => {
    if (d) setName(d.name);
  }, [d?.id]); // only when another device is loaded
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["device", deviceId] }), qc.invalidateQueries({ queryKey: ["devices"] }), qc.invalidateQueries({ queryKey: ["vaults"] })]);
  const onError = (err: unknown) => toast.error(errorMessage(err, t));
  const rename = useMutation({ mutationFn: () => api.renameDevice(deviceId, name), onSuccess: () => { toast(t("device.renamed")); void refresh(); }, onError });
  const revoke = useMutation({ mutationFn: () => api.revokeDevice(deviceId), onSuccess: () => { setConfirmOpen(false); toast(t("device.revokedDone")); void refresh(); }, onError });

  if (device.isError) return <p>{t("device.notFound")}</p>;
  if (!d) return null;
  const lang = i18n.language;
  const rows: Array<[string, string]> = [
    [t("device.vault"), d.vaultName],
    [t("device.platform"), d.platform],
    [t("device.pluginVersion"), d.pluginVersion],
    [t("device.lastSeen"), formatDateTime(d.lastSeenAt, lang)],
    [t("device.lastSync"), d.lastSyncAt ? formatDateTime(d.lastSyncAt, lang) : t("device.never")],
    [t("device.lag"), t("device.lagValue", { count: d.lag })],
    [t("device.pending"), String(d.pending)],
    [t("device.lastError"), d.lastError ? t(`errors.${d.lastError}`, { defaultValue: d.lastError }) : t("device.noError")],
  ];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!rename.isPending && name.trim()) rename.mutate();
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-serif text-2xl font-semibold">{d.name}</h1>
        {d.revoked ? <span>{t("device.revoked")}</span> : <LevelBadge level={d.level} />}
      </div>
      <dl className="bg-card grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-xl border p-4 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {!d.revoked && (
        <>
          <form onSubmit={submit} className="bg-card flex flex-wrap items-end gap-2 rounded-xl border p-4">
            <div className="min-w-56 flex-1">
              <TextField label={t("device.name")} value={name} onChange={setName} />
            </div>
            <Button type="submit" disabled={rename.isPending}>{t("device.save")}</Button>
          </form>
          <Button variant="destructive" onClick={() => setConfirmOpen(true)}>{t("device.revoke")}</Button>
          <ConfirmDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            title={t("device.revokeTitle", { name: d.name })}
            text={t("device.revokeText")}
            confirmText={t("device.revokeConfirm")}
            cancelText={t("device.cancel")}
            destructive
            busy={revoke.isPending}
            onConfirm={() => revoke.mutate()}
          />
        </>
      )}
    </div>
  );
}
```

(Se la regola `react-hooks/exhaustive-deps` non è configurata, togliere il commento `eslint-disable`.)

- [ ] **Step 5: Route**

In `apps/web/src/router.tsx`:

```tsx
export const VAULT_TABS = ["devices", "conflicts", "history", "settings"] as const;
export type VaultTab = (typeof VAULT_TABS)[number];

export const overviewRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: OverviewPage });
export const vaultsRoute = createRoute({ getParentRoute: () => appRoute, path: "/vaults", component: VaultsPage });
export const vaultRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/vaults/$vaultId",
  validateSearch: (s: Record<string, unknown>): { tab: VaultTab } => ({
    tab: VAULT_TABS.includes(s["tab"] as VaultTab) ? (s["tab"] as VaultTab) : "devices",
  }),
  component: VaultPage,
});
export const devicesRoute = createRoute({ getParentRoute: () => appRoute, path: "/devices", component: DevicesPage });
export const deviceRoute = createRoute({ getParentRoute: () => appRoute, path: "/devices/$deviceId", component: DevicePage });
```

sostituendo le route segnaposto `overviewRoute`, `vaultsRoute`, `devicesRoute` e aggiungendo `vaultRoute`, `deviceRoute` a `appRoute.addChildren([...])`. `VaultHistoryTab`, `VaultSettingsTab` e `AddDeviceDialog` arrivano nei Task 4 e 6: per far compilare questo task, creare subito i file con un componente che restituisce `null` (`export function VaultHistoryTab(_: { vault: Vault }) { return null; }` ecc.), sostituiti poi.

Run: `pnpm --filter @kamino/web test` → PASS; typecheck, lint, format.

```bash
git add apps/web && git commit -m "feat(web): add overview, vaults and devices pages"
```

---

### Task 4: Aggiungi un dispositivo

**Files:** Create (sostituisce il segnaposto) `apps/web/src/pages/devices/AddDeviceDialog.tsx`; Test `apps/web/src/pages/devices/add-device.test.tsx`; Modify i18n, `apps/web/src/mocks/DevPanel.tsx` (bottoni di simulazione).

**Interfaces — Produces:** `AddDeviceDialog({ open, onOpenChange, vaults: Vault[] })`.

- [ ] **Step 1: Testi**

`it.json`:

```json
"pairing": {
  "title": "Aggiungi un dispositivo",
  "chooseVault": "Quale vault?",
  "next": "Avanti",
  "intro": "Inquadra il codice con la fotocamera del nuovo dispositivo, dove Obsidian e il plugin sono già installati in un vault vuoto.",
  "qrAlt": "Codice QR per collegare un dispositivo",
  "link": "Link di collegamento",
  "copy": "Copia link",
  "copied": "Link copiato.",
  "validFor": "Valido ancora {{left}} · usabile una volta sola",
  "waiting": "In attesa del nuovo dispositivo…",
  "requestTitle": "Nuovo dispositivo: “{{name}}”",
  "requestMeta": "{{platform}} · plugin {{version}}",
  "requestHint": "Approva solo se sul nuovo dispositivo vedi lo stesso codice. Se non sei stato tu, rifiuta.",
  "approve": "Approva",
  "deny": "Rifiuta",
  "approved": "Dispositivo collegato.",
  "denied": "Richiesta rifiutata.",
  "expired": "Codice scaduto: generane uno nuovo.",
  "closed": "Questa richiesta non è più valida.",
  "regenerate": "Genera di nuovo",
  "close": "Chiudi"
}
```

`en.json`:

```json
"pairing": {
  "title": "Add a device",
  "chooseVault": "Which vault?",
  "next": "Next",
  "intro": "Scan the code with the camera of the new device, where Obsidian and the plugin are already installed in an empty vault.",
  "qrAlt": "QR code to link a device",
  "link": "Pairing link",
  "copy": "Copy link",
  "copied": "Link copied.",
  "validFor": "Valid for {{left}} · usable once",
  "waiting": "Waiting for the new device…",
  "requestTitle": "New device: “{{name}}”",
  "requestMeta": "{{platform}} · plugin {{version}}",
  "requestHint": "Approve only if you see the same code on the new device. If it wasn't you, deny.",
  "approve": "Approve",
  "deny": "Deny",
  "approved": "Device linked.",
  "denied": "Request denied.",
  "expired": "Code expired: generate a new one.",
  "closed": "This request is no longer valid.",
  "regenerate": "Generate again",
  "close": "Close"
}
```

Aggiungere a `dev` (it/en): `"pairingRequest": "Richiesta di collegamento in arrivo"` / `"Incoming pairing request"`, `"staleNext": "Versione più recente in arrivo"` / `"Newer incoming version"`, `"quotaFull": "Quota quasi piena"` / `"Quota almost full"`.

- [ ] **Step 2: Test (falliscono)** — `apps/web/src/pages/devices/add-device.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/endpoints.js";
import { signInAs } from "../../mocks/db.js";
import { simulatePairingRequest, ud } from "../../mocks/userdata.js";
import { renderRoute } from "../../test/render.js";

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function openDialog() {
  signInAs("demo");
  await renderRoute("/vaults/v-notes?tab=devices");
  fireEvent.click(await screen.findByRole("button", { name: "Aggiungi un dispositivo" }));
  return screen.findByRole("dialog");
}

describe("AddDeviceDialog", () => {
  it("shows QR and link, then the request with the code; approve", async () => {
    const dialog = await openDialog();
    expect(await within(dialog).findByAltText("Codice QR per collegare un dispositivo")).toBeDefined();
    expect((within(dialog).getByLabelText("Link di collegamento") as HTMLInputElement).value).toContain("obsidian://");
    act(() => simulatePairingRequest());
    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(await within(dialog).findByText("K7RX")).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Approva" }));
    expect(await within(dialog).findByText("Dispositivo collegato.")).toBeDefined();
    expect(ud.devices.some((d) => d.name === "Pixel")).toBe(true);
  });

  it("deny", async () => {
    const dialog = await openDialog();
    await within(dialog).findByAltText("Codice QR per collegare un dispositivo");
    act(() => simulatePairingRequest());
    await act(() => vi.advanceTimersByTimeAsync(2100));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Rifiuta" }));
    expect(await within(dialog).findByText("Richiesta rifiutata.")).toBeDefined();
  });

  it("closing while waiting cancels the pairing and stops polling", async () => {
    const dialog = await openDialog();
    await within(dialog).findByAltText("Codice QR per collegare un dispositivo");
    const cancel = vi.spyOn(api, "cancelPairing");
    const poll = vi.spyOn(api, "pairing");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(cancel).toHaveBeenCalled());
    poll.mockClear();
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(poll).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Implementazione** — `apps/web/src/pages/devices/AddDeviceDialog.tsx`:

```tsx
import type { PairingOffer, PairingState, Vault } from "@kamino/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { renderSVG } from "uqr";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { ApiError } from "../../api/http.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";

type Result = "approved" | "denied" | "expired" | "closed" | null;

/** Origin side of pairing from the web (protocol §10, spec §4.4). */
export function AddDeviceDialog({ open, onOpenChange, vaults }: { open: boolean; onOpenChange: (o: boolean) => void; vaults: Vault[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [vaultId, setVaultId] = useState<string | null>(vaults.length === 1 ? vaults[0]!.id : null);
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [state, setState] = useState<PairingState | null>(null);
  const [result, setResult] = useState<Result>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const alive = useRef(false);

  // Start/stop with the dialog; nothing is applied after close.
  useEffect(() => {
    if (!open || !vaultId) return;
    alive.current = true;
    let current: PairingOffer | null = null;
    void api.startPairing(vaultId).then(
      (o) => {
        if (!alive.current) return void api.cancelPairing(o.pairingId).catch(() => undefined);
        current = o;
        setOffer(o);
      },
      (err: unknown) => alive.current && toast.error(errorMessage(err, t)),
    );
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (!current) return;
      const id = current.pairingId;
      void api.pairing(id).then((s) => {
        if (!alive.current || current?.pairingId !== id) return;
        setState(s);
        if (s.status === "expired") setResult("expired");
      }, () => undefined);
    }, 2000);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      if (current) void api.cancelPairing(current.pairingId).catch(() => undefined);
      setOffer(null);
      setState(null);
      setResult(null);
    };
  }, [open, vaultId, t]);

  const answer = async (approve: boolean) => {
    if (!offer || busy) return;
    setBusy(true);
    try {
      await (approve ? api.approvePairing(offer.pairingId) : api.denyPairing(offer.pairingId));
      if (alive.current) setResult(approve ? "approved" : "denied");
      await qc.invalidateQueries();
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && err.code === "pairing_closed") setResult("closed");
      else toast.error(errorMessage(err, t));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const left = offer ? Math.max(0, Math.ceil((Date.parse(offer.expiresAt) - now) / 1000)) : 0;
  const leftText = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  const request = state?.status === "requested" ? state.request : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{request && !result ? t("pairing.requestTitle", { name: request.deviceName }) : t("pairing.title")}</DialogTitle>
        </DialogHeader>
        {!vaultId ? (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("pairing.chooseVault")}</legend>
            {vaults.map((v) => (
              <Button key={v.id} variant="outline" className="w-full" onClick={() => setVaultId(v.id)}>{v.name}</Button>
            ))}
          </fieldset>
        ) : result ? (
          <div className="space-y-3">
            <p role="status">{t(`pairing.${result}`)}</p>
            <Button onClick={() => onOpenChange(false)}>{t("pairing.close")}</Button>
          </div>
        ) : request ? (
          <div className="space-y-3">
            <p className="text-muted-foreground text-sm">{t("pairing.requestMeta", { platform: request.platform, version: request.pluginVersion })}</p>
            <p className="bg-muted rounded-lg py-3 text-center font-mono text-3xl tracking-[0.3em]" aria-label={request.code.split("").join(" ")}>{request.code}</p>
            <p className="text-sm">{t("pairing.requestHint")}</p>
            <div className="flex gap-2">
              <Button disabled={busy} onClick={() => void answer(true)}>{t("pairing.approve")}</Button>
              <Button variant="outline" disabled={busy} onClick={() => void answer(false)}>{t("pairing.deny")}</Button>
            </div>
          </div>
        ) : offer ? (
          <div className="space-y-3">
            <p className="text-sm">{t("pairing.intro")}</p>
            <img
              src={`data:image/svg+xml,${encodeURIComponent(renderSVG(offer.link, { border: 2, whiteColor: "#ffffff", blackColor: "#000000" }))}`}
              alt={t("pairing.qrAlt")}
              width={220}
              height={220}
              className="mx-auto rounded-md"
            />
            <Label htmlFor="pairing-link">{t("pairing.link")}</Label>
            <Input id="pairing-link" readOnly value={offer.link} className="font-mono text-xs" />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(offer.link).then(() => toast(t("pairing.copied")))}>
                {t("pairing.copy")}
              </Button>
              <span className="text-muted-foreground text-sm">{t("pairing.validFor", { left: leftText })}</span>
            </div>
            <p className="text-muted-foreground text-sm" aria-live="polite">{t("pairing.waiting")}</p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
```

`DevPanel.tsx`: aggiungere bottoni che chiamano `simulatePairingRequest()`, `simulateStaleNext()`, `seedUserData("quota-almost-full")` (import da `./userdata.js`) con i testi `dev.pairingRequest`, `dev.staleNext`, `dev.quotaFull`.

Run: test, typecheck, lint, format.

```bash
git add apps/web && git commit -m "feat(web): add device pairing from the web with approval"
```

---

### Task 5: Centro conflitti

**Files:** Modify `apps/web/package.json` (`@kamino/ui-diff`, `@codemirror/state`, `@codemirror/view`, `@codemirror/merge`); Create `apps/web/src/components/DiffView.tsx` (+ `DiffView.test.tsx`), `apps/web/src/lib/useMediaQuery.ts`, `apps/web/src/pages/conflicts/{ConflictCenter,ConflictList,ConflictDetailPane,BulkResolveDialog}.tsx`; Test `apps/web/src/pages/conflicts/conflicts.test.tsx`; Modify `apps/web/src/router.tsx` (`conflictsRoute`, `conflictRoute` con `lazyRouteComponent`), `apps/web/src/index.css` (stile del diff), i18n.

**Interfaces — Produces:** `DiffView` (`{ mine, incoming, layout, editable, labels, phrases?, ref?: Ref<DiffViewApi> }`, `DiffViewApi { getMerged(): string | null }`); `useIsNarrow(): boolean` (`max-width: 1023px`); `ConflictCenter({ selectedId?: string })`.

- [ ] **Step 1: Dipendenze** — `pnpm --filter @kamino/web add '@kamino/ui-diff@workspace:*' @codemirror/state @codemirror/view @codemirror/merge`.

- [ ] **Step 2: Testi**

`it.json`:

```json
"conflicts": {
  "title": "Conflitti",
  "none": "Nessun conflitto da risolvere.",
  "choose": "Scegli un conflitto dall'elenco.",
  "back": "Tutti i conflitti",
  "summaryEdit": "Modificata su {{mineDevice}} ({{mine}}) e su {{device}} ({{incoming}}). Entrambe le versioni sono salvate.",
  "summaryCreated": "Due file con lo stesso nome creati su {{mineDevice}} ({{mine}}) e su {{device}} ({{incoming}}). Entrambi sono salvati.",
  "changes": "Differenze: {{count}}",
  "labelMine": "La tua versione · {{device}}",
  "labelIncoming": "In arrivo · {{device}}, {{when}}",
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
  "unchangedLines": "$ righe invariate",
  "doneMine": "Hai tenuto la tua versione. Quella di {{device}} resta nello storico.",
  "doneIncoming": "Hai tenuto la versione di {{device}}. La tua resta nello storico.",
  "doneBoth": "Hai tenuto entrambe: la tua è salvata come file affiancato.",
  "doneMerge": "Unione salvata.",
  "stale": "È arrivata una versione più recente: controlla di nuovo prima di scegliere.",
  "gone": "Questo conflitto è già stato risolto.",
  "unsavedMerge": "La tua unione non è stata salvata: eccola, puoi copiarla.",
  "noPreview": "Anteprima non disponibile",
  "fileSize": "Dimensione",
  "fileType": "Tipo",
  "resolveAll": "Risolvi tutti…",
  "bulkTitle": "Risolvi tutti i conflitti",
  "bulkMine": "Tieni tutte le mie",
  "bulkIncoming": "Tieni tutte quelle in arrivo",
  "bulkBoth": "Tieni entrambe per tutti",
  "bulkAppliesTo": "Si applica a {{count}} file",
  "bulkApply": "Applica",
  "bulkDone": "Conflitti risolti: {{count}}"
}
```

`en.json`:

```json
"conflicts": {
  "title": "Conflicts",
  "none": "No conflicts to resolve.",
  "choose": "Choose a conflict from the list.",
  "back": "All conflicts",
  "summaryEdit": "Edited on {{mineDevice}} ({{mine}}) and on {{device}} ({{incoming}}). Both versions are saved.",
  "summaryCreated": "Two files with the same name created on {{mineDevice}} ({{mine}}) and on {{device}} ({{incoming}}). Both are saved.",
  "changes": "Differences: {{count}}",
  "labelMine": "Your version · {{device}}",
  "labelIncoming": "Incoming · {{device}}, {{when}}",
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
  "unchangedLines": "$ unchanged lines",
  "doneMine": "You kept your version. The one from {{device}} stays in the history.",
  "doneIncoming": "You kept the version from {{device}}. Yours stays in the history.",
  "doneBoth": "You kept both: yours is saved as a separate file.",
  "doneMerge": "Merge saved.",
  "stale": "A newer version arrived: check again before choosing.",
  "gone": "This conflict has already been resolved.",
  "unsavedMerge": "Your merge was not saved: here it is, you can copy it.",
  "noPreview": "No preview available",
  "fileSize": "Size",
  "fileType": "Type",
  "resolveAll": "Resolve all…",
  "bulkTitle": "Resolve all conflicts",
  "bulkMine": "Keep all mine",
  "bulkIncoming": "Keep all incoming",
  "bulkBoth": "Keep both for all",
  "bulkAppliesTo": "Applies to {{count}} files",
  "bulkApply": "Apply",
  "bulkDone": "Conflicts resolved: {{count}}"
}
```

- [ ] **Step 3: `DiffView` e `useIsNarrow`**

`apps/web/src/lib/useMediaQuery.ts`:

```ts
import { useEffect, useState } from "react";

/** True below the desktop breakpoint (1024 px). jsdom without matchMedia → desktop. */
export function useIsNarrow(): boolean {
  const query = "(max-width: 1023px)";
  const get = () => typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}
```

`apps/web/src/components/DiffView.tsx`:

```tsx
import { createDiffView, type DiffViewHandle } from "@kamino/ui-diff";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

export interface DiffViewApi {
  /** Your version with the edits; null if the view is not mounted (never save an empty merge). */
  getMerged(): string | null;
}

/** React adapter for @kamino/ui-diff (CodeMirror merge). Destroyed on unmount or input change. */
export function DiffView({
  mine, incoming, layout, editable, labels, phrases, ref,
}: {
  mine: string;
  incoming: string;
  layout: "split" | "unified";
  editable: boolean;
  labels: { mine: string; incoming: string };
  phrases?: Record<string, string>;
  ref?: Ref<DiffViewApi>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<DiffViewHandle | null>(null);
  const phrasesKey = JSON.stringify(phrases ?? {});
  useEffect(() => {
    if (!host.current) return;
    const h = createDiffView(host.current, { mine, incoming, layout, editable, labels, ...(phrases ? { phrases } : {}) });
    handle.current = h;
    return () => {
      h.destroy();
      handle.current = null;
    };
    // labels/phrases compared by value
  }, [mine, incoming, layout, editable, labels.mine, labels.incoming, phrasesKey]);
  useImperativeHandle(ref, () => ({ getMerged: () => handle.current?.getMerged() ?? null }), []);
  return <div ref={host} className="kamino-diff overflow-hidden rounded-lg border" />;
}
```

(Se la regola `react-hooks/exhaustive-deps` non è attiva nel progetto, rimuovere il commento `eslint-disable`.)

`apps/web/src/components/DiffView.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DiffView, type DiffViewApi } from "./DiffView.js";

afterEach(cleanup);
const labels = { mine: "Mine", incoming: "Incoming" };

describe("DiffView", () => {
  it("mounts CodeMirror, returns the merged text, cleans up on unmount", () => {
    const ref = createRef<DiffViewApi>();
    const { container, unmount } = render(<DiffView ref={ref} mine={"a\nb\n"} incoming={"a\nc\n"} layout="split" editable={false} labels={labels} />);
    expect(container.querySelector(".cm-mergeView")).not.toBeNull();
    expect(ref.current?.getMerged()).toBe("a\nb\n");
    unmount();
    expect(container.querySelector(".cm-editor")).toBeNull();
  });

  it("unified layout", () => {
    const { container } = render(<DiffView mine="a" incoming="b" layout="unified" editable labels={labels} />);
    expect(container.querySelector(".diff-view--unified .cm-editor")).not.toBeNull();
  });
});
```

Aggiungere a `apps/web/src/index.css` (in fondo):

```css
/* Diff (@kamino/ui-diff): code font; unified view recolored so mine = blocked tint, incoming = safe tint, as in the plugin. */
.kamino-diff .cm-editor {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 13px;
  background: var(--card);
}
.kamino-diff .diff-view--unified .cm-changedLine,
.kamino-diff .diff-view--unified .cm-inlineChangedLine {
  background-color: var(--status-blocked-surface);
}
.kamino-diff .diff-view--unified .cm-deletedChunk {
  background-color: var(--status-safe-surface);
}
.kamino-diff .diff-view--unified .cm-deletedChunk .cm-deletedText {
  background: transparent;
}
```

- [ ] **Step 4: Test del centro conflitti (falliscono)** — `apps/web/src/pages/conflicts/conflicts.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const diffCalls: Array<{ layout: string; editable: boolean }> = [];
vi.mock("@kamino/ui-diff", () => ({
  diffSummary: () => ({ changes: 2 }),
  createDiffView: (parent: HTMLElement, o: { layout: string; editable: boolean }) => {
    diffCalls.push({ layout: o.layout, editable: o.editable });
    const el = parent.ownerDocument.createElement("div");
    el.className = "fake-diff";
    parent.append(el);
    return { getMerged: () => "merged text", destroy: () => el.remove() };
  },
}));

import { signInAs } from "../../mocks/db.js";
import { simulateStaleNext, ud } from "../../mocks/userdata.js";
import { renderRoute } from "../../test/render.js";

afterEach(() => {
  cleanup();
  diffCalls.length = 0;
  vi.unstubAllGlobals();
});

const list = () => screen.getByRole("navigation", { name: "Conflitti" });

describe("ConflictCenter (desktop)", () => {
  it("groups by vault and shows the first conflict", async () => {
    signInAs("demo");
    await renderRoute("/conflicts");
    await screen.findByText("Foto/vacanza.svg");
    expect(within(list()).getByText("Note")).toBeDefined();
    expect(within(list()).getByText("Lavoro")).toBeDefined();
    expect(await screen.findByRole("heading", { name: "Spesa.md" })).toBeDefined();
    expect(diffCalls.at(-1)).toEqual({ layout: "split", editable: false });
  });

  it("keep mine: request, toast, next conflict", async () => {
    signInAs("demo");
    const { router } = await renderRoute("/conflicts/c-shopping");
    fireEvent.click(await screen.findByRole("button", { name: "Tieni la mia" }));
    expect(await screen.findByText("Hai tenuto la tua versione. Quella di iPhone resta nello storico.")).toBeDefined();
    await waitFor(() => expect(router.state.location.pathname).toBe("/conflicts/c-plan"));
    expect(ud.conflicts.some((c) => c.id === "c-shopping")).toBe(false);
  });

  it("edit and merge saves the merged text", async () => {
    signInAs("demo");
    await renderRoute("/conflicts/c-shopping");
    fireEvent.click(await screen.findByRole("button", { name: "Modifica e unisci…" }));
    expect(diffCalls.at(-1)).toEqual({ layout: "split", editable: true });
    fireEvent.click(screen.getByRole("button", { name: "Salva l'unione" }));
    expect(await screen.findByText("Unione salvata.")).toBeDefined();
  });

  it("stale: reload and warning, no success", async () => {
    signInAs("demo");
    await renderRoute("/conflicts/c-shopping");
    simulateStaleNext();
    fireEvent.click(await screen.findByRole("button", { name: "Tieni la mia" }));
    expect(await screen.findByText(/È arrivata una versione più recente/)).toBeDefined();
    expect(screen.queryByText(/Hai tenuto la tua versione/)).toBeNull();
    expect(ud.conflicts.some((c) => c.id === "c-shopping")).toBe(true);
  });

  it("binary: previews, no edit", async () => {
    signInAs("demo");
    await renderRoute("/conflicts/c-photo");
    expect(await screen.findAllByRole("img")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Modifica e unisci…" })).toBeNull();
  });

  it("resolve all needs an explicit choice", async () => {
    signInAs("demo");
    await renderRoute("/conflicts");
    fireEvent.click(await screen.findByRole("button", { name: "Risolvi tutti…" }));
    const dialog = await screen.findByRole("dialog");
    const apply = within(dialog).getByRole("button", { name: "Applica" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(within(dialog).getByLabelText("Tieni entrambe per tutti"));
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    expect(await screen.findByText("Conflitti risolti: 3")).toBeDefined();
    expect(await screen.findByText("Nessun conflitto da risolvere.")).toBeDefined();
  });
});

describe("ConflictCenter (phone)", () => {
  it("list and detail are separate pages; detail uses tabs + unified diff", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), addEventListener() {}, removeEventListener() {} }));
    signInAs("demo");
    await renderRoute("/conflicts");
    await screen.findByText("Spesa.md");
    expect(screen.queryByRole("heading", { name: "Spesa.md" })).toBeNull();
    cleanup();
    await renderRoute("/conflicts/c-shopping");
    expect(await screen.findByRole("tab", { name: "Differenze" })).toBeDefined();
    expect(diffCalls.at(-1)).toEqual({ layout: "unified", editable: false });
    expect(screen.getByRole("link", { name: "Tutti i conflitti" })).toBeDefined();
  });
});
```

- [ ] **Step 5: Implementazione**

`apps/web/src/pages/conflicts/ConflictList.tsx`:

```tsx
import type { ConflictSummary } from "@kamino/protocol";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { formatAgo } from "../../lib/format.js";
import { cn } from "../../lib/utils.js";

export function ConflictList({ conflicts, selectedId }: { conflicts: ConflictSummary[]; selectedId: string | null }) {
  const { t, i18n } = useTranslation();
  const groups = new Map<string, ConflictSummary[]>();
  for (const c of conflicts) groups.set(c.vaultName, [...(groups.get(c.vaultName) ?? []), c]);
  return (
    <nav aria-label={t("conflicts.title")} className="bg-card space-y-3 rounded-xl border p-2">
      {[...groups].map(([vault, items]) => (
        <div key={vault}>
          <p className="text-muted-foreground px-2 pt-1 text-xs font-medium">{vault}</p>
          <ul>
            {items.map((c) => (
              <li key={c.id}>
                <Link
                  to="/conflicts/$conflictId"
                  params={{ conflictId: c.id }}
                  aria-current={c.id === selectedId ? "page" : undefined}
                  className={cn("block rounded-md px-2 py-2 text-sm", c.id === selectedId ? "bg-accent font-semibold" : "hover:bg-muted")}
                >
                  <span className="block break-all">{c.path}</span>
                  <span className="text-muted-foreground text-xs">{c.incoming.device} · {formatAgo(c.incoming.at, i18n.language)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
```

`apps/web/src/pages/conflicts/BulkResolveDialog.tsx`:

```tsx
import type { BulkStrategy } from "@kamino/protocol";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";

export function BulkResolveDialog({
  open, onOpenChange, count, busy, onApply,
}: { open: boolean; onOpenChange: (o: boolean) => void; count: number; busy: boolean; onApply: (s: BulkStrategy) => void }) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<BulkStrategy | null>(null);
  const options: Array<[BulkStrategy, string]> = [
    ["keep_mine", t("conflicts.bulkMine")],
    ["keep_incoming", t("conflicts.bulkIncoming")],
    ["keep_both", t("conflicts.bulkBoth")],
  ];
  return (
    <Dialog open={open} onOpenChange={(o) => { setChoice(null); onOpenChange(o); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("conflicts.bulkTitle")}</DialogTitle></DialogHeader>
        <div role="radiogroup" aria-label={t("conflicts.bulkTitle")} className="space-y-2">
          {options.map(([value, label]) => (
            <label key={value} className="flex items-center gap-2">
              <input type="radio" name="bulk" value={value} checked={choice === value} onChange={() => setChoice(value)} />
              {label}
            </label>
          ))}
        </div>
        <p className="text-muted-foreground text-sm">{t("conflicts.bulkAppliesTo", { count })}</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("conflicts.cancel")}</Button>
          <Button disabled={!choice || busy} onClick={() => choice && onApply(choice)}>{t("conflicts.bulkApply")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

`apps/web/src/pages/conflicts/ConflictDetailPane.tsx`:

```tsx
import type { BinaryMeta, ConflictDetail, Resolution } from "@kamino/protocol";
import { diffSummary } from "@kamino/ui-diff";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { ApiError } from "../../api/http.js";
import { DiffView, type DiffViewApi } from "../../components/DiffView.js";
import { Button } from "../../components/ui/button.js";
import { formatBytes, formatDateTime } from "../../lib/format.js";
import { useIsNarrow } from "../../lib/useMediaQuery.js";

type Tab = "mine" | "diff" | "incoming";

/** One conflict (spec §4.7): diff/previews, actions, stale and "already resolved". */
export function ConflictDetailPane({ id, onResolved }: { id: string; onResolved: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const narrow = useIsNarrow();
  const detail = useQuery({ queryKey: ["conflict", id], queryFn: () => api.conflict(id), retry: false });
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<Tab>("diff");
  const [stale, setStale] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const diff = useRef<DiffViewApi>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    setEditing(false); setTab("diff"); setStale(false); setDraft(null);
    return () => { alive.current = false; };
  }, [id]);

  const lang = i18n.language;
  const d = detail.data;
  const gone = detail.isError && detail.error instanceof ApiError && detail.error.code === "not_found";
  if (gone || (!d && detail.isError)) {
    return (
      <section className="space-y-3">
        <p role="status">{t("conflicts.gone")}</p>
        {draft !== null && (<><p className="text-sm">{t("conflicts.unsavedMerge")}</p><pre className="bg-muted overflow-auto rounded p-3 text-sm whitespace-pre-wrap">{draft}</pre></>)}
      </section>
    );
  }
  if (!d) return null;

  const when = (iso: string) => formatDateTime(iso, lang);
  const apply = async (resolution: Resolution) => {
    if (busy) return;
    if (typeof resolution === "object") setDraft(resolution.manual);
    setBusy(true);
    try {
      await api.resolveConflict(d.id, resolution, d.incoming.at);
      const key = typeof resolution === "object" ? "doneMerge" : resolution === "keep_mine" ? "doneMine" : resolution === "keep_incoming" ? "doneIncoming" : "doneBoth";
      toast(t(`conflicts.${key}`, { device: d.incoming.device }));
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ["conflicts"] });
      void qc.invalidateQueries({ queryKey: ["vaults"] });
      void qc.invalidateQueries({ queryKey: ["vaults-summary"] });
      if (alive.current) onResolved();
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && err.code === "stale_resolution") {
        setStale(true);
        await qc.invalidateQueries({ queryKey: ["conflict", id] });
      } else if (err instanceof ApiError && err.code === "not_found") {
        await qc.invalidateQueries({ queryKey: ["conflict", id] });
      } else toast.error(errorMessage(err, t));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const labels = {
    mine: t("conflicts.labelMine", { device: d.mine.device }),
    incoming: t("conflicts.labelIncoming", { device: d.incoming.device, when: when(d.incoming.at) }),
  };
  const phrases = {
    Accept: t("conflicts.chunkKeepMine"),
    Reject: t("conflicts.chunkTakeIncoming"),
    "Revert this chunk": t("conflicts.chunkTakeIncoming"),
    "$ unchanged lines": t("conflicts.unchangedLines"),
  };
  const summaryKey = d.kind === "both_created" ? "conflicts.summaryCreated" : "conflicts.summaryEdit";
  const mineBase = editing && draft !== null ? draft : d.binary ? "" : d.mineText;

  return (
    <section className="space-y-4">
      {narrow && <Link to="/conflicts" className="text-link text-sm underline">{t("conflicts.back")}</Link>}
      <h2 className="font-serif text-xl font-semibold break-all">{d.path}</h2>
      <p className="text-muted-foreground text-sm">
        {d.vaultName} · {t(summaryKey, { mineDevice: d.mine.device, mine: when(d.mine.at), device: d.incoming.device, incoming: when(d.incoming.at) })}
      </p>
      {stale && <p role="alert" className="bg-status-attention-surface text-status-attention rounded-md p-2 text-sm">{t("conflicts.stale")}</p>}
      {d.binary ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {([[t("conflicts.tabMine"), d.mineFile, d.mine.device], [t("conflicts.tabIncoming"), d.incomingFile, d.incoming.device]] as Array<[string, BinaryMeta, string]>).map(([title, f, device]) => (
            <figure key={title} className="bg-card space-y-2 rounded-xl border p-3">
              <figcaption className="font-medium">{title} · {device}</figcaption>
              {f.previewUrl ? <img src={f.previewUrl} alt={title} className="max-w-full rounded" /> : <p className="text-muted-foreground text-sm">{t("conflicts.noPreview")}</p>}
              <p className="text-muted-foreground text-sm">{t("conflicts.fileSize")}: {formatBytes(f.size, lang)} · {t("conflicts.fileType")}: {f.mime}</p>
            </figure>
          ))}
        </div>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">{t("conflicts.changes", { count: diffSummary(d.mineText, d.incomingText).changes })}</p>
          {narrow ? (
            <>
              <div role="tablist" className="flex border-b">
                {(["mine", "diff", "incoming"] as const).map((x) => (
                  <button key={x} role="tab" aria-selected={tab === x} disabled={editing && x !== "diff"} onClick={() => setTab(x)}
                    className={tab === x ? "flex-1 py-2 text-sm font-semibold shadow-[inset_0_-2px_0_var(--link)]" : "text-muted-foreground flex-1 py-2 text-sm"}>
                    {t(`conflicts.tab${x === "mine" ? "Mine" : x === "diff" ? "Diff" : "Incoming"}`)}
                  </button>
                ))}
              </div>
              {tab === "diff" ? (
                <DiffView ref={diff} mine={mineBase} incoming={d.incomingText} layout="unified" editable={editing} labels={labels} phrases={phrases} />
              ) : (
                <pre className="bg-card overflow-auto rounded-lg border p-3 text-sm whitespace-pre-wrap">{tab === "mine" ? d.mineText : d.incomingText}</pre>
              )}
            </>
          ) : (
            <DiffView ref={diff} mine={mineBase} incoming={d.incomingText} layout="split" editable={editing} labels={labels} phrases={phrases} />
          )}
        </>
      )}
      <div className={narrow ? "flex flex-col gap-2" : "flex flex-wrap gap-2"}>
        {editing ? (
          <>
            <Button disabled={busy} onClick={() => { const merged = diff.current?.getMerged(); if (merged !== null && merged !== undefined) void apply({ manual: merged }); }}>{t("conflicts.saveMerge")}</Button>
            <Button variant="outline" disabled={busy} onClick={() => { setEditing(false); setDraft(null); }}>{t("conflicts.cancel")}</Button>
          </>
        ) : (
          <>
            <Button variant="outline" disabled={busy} onClick={() => void apply("keep_mine")}>{t("conflicts.keepMine")}</Button>
            <Button variant="outline" disabled={busy} onClick={() => void apply("keep_incoming")}>{t("conflicts.keepIncoming")}</Button>
            <Button variant="outline" disabled={busy} onClick={() => void apply("keep_both")}>{t("conflicts.keepBoth")}</Button>
            {!d.binary && <Button disabled={busy} onClick={() => { setEditing(true); setTab("diff"); }}>{t("conflicts.edit")}</Button>}
          </>
        )}
      </div>
    </section>
  );
}
```

`apps/web/src/pages/conflicts/ConflictCenter.tsx`:

```tsx
import type { BulkStrategy } from "@kamino/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { LevelBadge } from "../../components/status/LevelBadge.js";
import { Button } from "../../components/ui/button.js";
import { useIsNarrow } from "../../lib/useMediaQuery.js";
import { BulkResolveDialog } from "./BulkResolveDialog.js";
import { ConflictDetailPane } from "./ConflictDetailPane.js";
import { ConflictList } from "./ConflictList.js";

/** Conflict center (spec §4.7): list + detail on desktop; two pages on a phone. */
export function ConflictCenter({ selectedId }: { selectedId?: string }) {
  const { t } = useTranslation();
  useDocumentTitle(t("conflicts.title"));
  const narrow = useIsNarrow();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const conflicts = useQuery({ queryKey: ["conflicts"], queryFn: api.conflicts });
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const list = conflicts.data ?? [];
  const current = selectedId ?? (narrow ? undefined : list[0]?.id);

  const goNext = async () => {
    const fresh = await qc.fetchQuery({ queryKey: ["conflicts"], queryFn: api.conflicts });
    const next = fresh[0];
    if (next) await navigate({ to: "/conflicts/$conflictId", params: { conflictId: next.id }, replace: true });
    else await navigate({ to: "/conflicts", replace: true });
  };

  const applyBulk = async (strategy: BulkStrategy) => {
    setBulkBusy(true);
    try {
      const { resolved } = await api.resolveAll(strategy, list.map((c) => c.id));
      toast(t("conflicts.bulkDone", { count: resolved }));
      setBulkOpen(false);
      await qc.invalidateQueries();
      await navigate({ to: "/conflicts", replace: true });
    } catch (err) {
      toast.error(errorMessage(err, t));
    } finally {
      setBulkBusy(false);
    }
  };

  if (!conflicts.data) return null;
  if (list.length === 0) {
    return (
      <div className="space-y-3">
        <h1 className="font-serif text-2xl font-semibold">{t("conflicts.title")}</h1>
        <p>{t("conflicts.none")}</p>
        <LevelBadge level="safe" />
      </div>
    );
  }

  const showList = !narrow || !selectedId;
  const showDetail = !!current && (!narrow || !!selectedId);
  return (
    <div className="space-y-4">
      {showList && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="font-serif text-2xl font-semibold">{t("conflicts.title")}</h1>
          {list.length >= 2 && <Button variant="outline" onClick={() => setBulkOpen(true)}>{t("conflicts.resolveAll")}</Button>}
        </div>
      )}
      <div className={narrow ? "" : "grid grid-cols-[260px_1fr] gap-4"}>
        {showList && <ConflictList conflicts={list} selectedId={current ?? null} />}
        {showDetail && current && <ConflictDetailPane key={current} id={current} onResolved={() => void goNext()} />}
      </div>
      <BulkResolveDialog open={bulkOpen} onOpenChange={setBulkOpen} count={list.length} busy={bulkBusy} onApply={(s) => void applyBulk(s)} />
    </div>
  );
}

export function ConflictsIndexPage() {
  return <ConflictCenter />;
}
```

Route in `router.tsx` (caricate a richiesta):

```tsx
import { lazyRouteComponent } from "@tanstack/react-router";

export const conflictsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/conflicts",
  component: lazyRouteComponent(() => import("./pages/conflicts/ConflictCenter.js"), "ConflictsIndexPage"),
});
export const conflictRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/conflicts/$conflictId",
  component: lazyRouteComponent(() => import("./pages/conflicts/ConflictRoutePage.js"), "ConflictRoutePage"),
});
```

`apps/web/src/pages/conflicts/ConflictRoutePage.tsx`:

```tsx
import { useParams } from "@tanstack/react-router";
import { ConflictCenter } from "./ConflictCenter.js";

export function ConflictRoutePage() {
  const { conflictId } = useParams({ from: "/app/conflicts/$conflictId" });
  return <ConflictCenter selectedId={conflictId} />;
}
```

(Se l'id della route generato da TanStack è diverso da `/app/conflicts/$conflictId`, usare `useParams({ strict: false })` e leggere `conflictId`.)

Run: test, typecheck, lint, format.

```bash
git add apps/web pnpm-lock.yaml && git commit -m "feat(web): add the conflict center with diff, merge and bulk resolution"
```

---

### Task 6: Storico, cestino, impostazioni del vault

**Files:** Create (sostituiscono i segnaposto) `apps/web/src/pages/vaults/VaultHistoryTab.tsx`, `apps/web/src/pages/vaults/VaultSettingsTab.tsx`, `apps/web/src/pages/vaults/FileHistoryDialog.tsx`; Test `apps/web/src/pages/vaults/vault-tabs.test.tsx`; Modify i18n.

**Interfaces — Produces:** `VaultHistoryTab({ vault })`, `VaultSettingsTab({ vault })`, `FileHistoryDialog({ fileId: string | null, onOpenChange })`.

- [ ] **Step 1: Testi**

`it.json`:

```json
"history": {
  "search": "Cerca un file",
  "noFiles": "Nessun file trovato.",
  "versions": "{{count}} versioni",
  "changed": "modificato {{when}}",
  "title": "Storico di {{path}}",
  "current": "attuale",
  "preview": "Anteprima",
  "noPreview": "Anteprima non disponibile",
  "restore": "Ripristina questa versione",
  "restoreHint": "Diventa la versione attuale; quella di adesso resta nello storico.",
  "restored": "Versione ripristinata.",
  "trash": "Cestino",
  "trashHint": "I file eliminati restano qui almeno 7 giorni.",
  "trashEmpty": "Il cestino è vuoto.",
  "deletedOn": "eliminato il {{when}} · si cancella definitivamente il {{expires}}",
  "restoreFile": "Ripristina",
  "fileRestored": "File ripristinato."
},
"vaultSettings": {
  "name": "Nome del vault",
  "rename": "Rinomina",
  "renamed": "Nome aggiornato.",
  "retention": "Storico delle versioni",
  "retentionHint": "Quanti giorni conservare le versioni precedenti (massimo {{max}}).",
  "days": "{{count}} giorni",
  "save": "Salva",
  "saved": "Salvato.",
  "zip": "Scarica il vault (ZIP)",
  "zipNow": "Stato attuale",
  "zipAt": "Com'era il…",
  "zipAtLabel": "Data e ora",
  "zipHint": "Puoi scegliere un momento dal {{from}} in poi.",
  "download": "Scarica",
  "danger": "Zona pericolosa",
  "delete": "Elimina il vault",
  "deleteTitle": "Eliminare “{{name}}”?",
  "deleteText": "Il vault viene eliminato dal server in modo definitivo, compresi storico e cestino: i dati cifrati diventano illeggibili. I file sui dispositivi restano dove sono.",
  "deleteConfirmLabel": "Scrivi il nome del vault per confermare",
  "deleteConfirm": "Elimina definitivamente",
  "deleted": "Vault eliminato.",
  "cancel": "Annulla"
}
```

`en.json`:

```json
"history": {
  "search": "Search a file",
  "noFiles": "No files found.",
  "versions": "{{count}} versions",
  "changed": "changed {{when}}",
  "title": "History of {{path}}",
  "current": "current",
  "preview": "Preview",
  "noPreview": "No preview available",
  "restore": "Restore this version",
  "restoreHint": "It becomes the current version; the current one stays in the history.",
  "restored": "Version restored.",
  "trash": "Trash",
  "trashHint": "Deleted files stay here for at least 7 days.",
  "trashEmpty": "The trash is empty.",
  "deletedOn": "deleted on {{when}} · permanently removed on {{expires}}",
  "restoreFile": "Restore",
  "fileRestored": "File restored."
},
"vaultSettings": {
  "name": "Vault name",
  "rename": "Rename",
  "renamed": "Name updated.",
  "retention": "Version history",
  "retentionHint": "How many days to keep previous versions (up to {{max}}).",
  "days": "{{count}} days",
  "save": "Save",
  "saved": "Saved.",
  "zip": "Download the vault (ZIP)",
  "zipNow": "Current state",
  "zipAt": "As it was on…",
  "zipAtLabel": "Date and time",
  "zipHint": "You can pick a moment from {{from}} on.",
  "download": "Download",
  "danger": "Danger zone",
  "delete": "Delete the vault",
  "deleteTitle": "Delete “{{name}}”?",
  "deleteText": "The vault is permanently deleted from the server, history and trash included: the encrypted data becomes unreadable. Files on the devices stay where they are.",
  "deleteConfirmLabel": "Type the vault name to confirm",
  "deleteConfirm": "Delete permanently",
  "deleted": "Vault deleted.",
  "cancel": "Cancel"
}
```

Aggiungere a `errors` (it/en): `"confirm_mismatch": "Il nome non coincide."` / `"The name doesn't match."`, `"history_window": "Quel momento è fuori dallo storico disponibile."` / `"That moment is outside the available history."`, `"pairing_closed": "Questa richiesta non è più valida."` / `"This request is no longer valid."`, `"stale_resolution": "È arrivata una versione più recente."` / `"A newer version arrived."`, `"not_found": "Non trovato."` / `"Not found."`, `"quota_exceeded": "Spazio esaurito"` / `"Storage full"`.

- [ ] **Step 2: Test (falliscono)** — `apps/web/src/pages/vaults/vault-tabs.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/endpoints.js";
import { signInAs } from "../../mocks/db.js";
import { ud } from "../../mocks/userdata.js";
import { renderRoute } from "../../test/render.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("History and trash", () => {
  it("search, open a file history, preview and restore a version", async () => {
    signInAs("demo");
    await renderRoute("/vaults/v-notes?tab=history");
    fireEvent.change(await screen.findByLabelText("Cerca un file"), { target: { value: "idee" } });
    fireEvent.click(await screen.findByRole("button", { name: /Idee\.md/ }));
    const dialog = await screen.findByRole("dialog");
    const items = await within(dialog).findAllByRole("button", { name: /MacBook|iPhone/ });
    fireEvent.click(items[1]!);
    expect(await within(dialog).findByText(/Versione 3 delle idee/)).toBeDefined();
    const before = ud.files.find((f) => f.fileId === "f-idee")!.versions.length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Ripristina questa versione" }));
    await waitFor(() => expect(ud.files.find((f) => f.fileId === "f-idee")!.versions.length).toBe(before + 1));
  });

  it("trash: restore a file", async () => {
    signInAs("demo");
    await renderRoute("/vaults/v-notes?tab=history");
    const trash = await screen.findByRole("region", { name: "Cestino" });
    expect(within(trash).getByText(/almeno 7 giorni/)).toBeDefined();
    fireEvent.click((await within(trash).findAllByRole("button", { name: "Ripristina" }))[0]!);
    await waitFor(() => expect(ud.trash.filter((x) => x.vaultId === "v-notes")).toHaveLength(1));
  });
});

describe("Vault settings", () => {
  it("rename and retention", async () => {
    signInAs("demo");
    await renderRoute("/vaults/v-notes?tab=settings");
    fireEvent.change(await screen.findByLabelText("Nome del vault"), { target: { value: "Appunti" } });
    fireEvent.click(screen.getByRole("button", { name: "Rinomina" }));
    await waitFor(() => expect(ud.vaults.find((v) => v.id === "v-notes")!.name).toBe("Appunti"));
    fireEvent.change(screen.getByLabelText("Storico delle versioni"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Salva" }));
    await waitFor(() => expect(ud.vaults.find((v) => v.id === "v-notes")!.retentionDays).toBe(60));
  });

  it("ZIP: outside the history window shows the error", async () => {
    signInAs("demo");
    const spy = vi.spyOn(api, "downloadZip");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
    await renderRoute("/vaults/v-notes?tab=settings");
    fireEvent.click(await screen.findByLabelText("Com'era il…"));
    fireEvent.change(screen.getByLabelText("Data e ora"), { target: { value: "2020-01-01T10:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Scarica" }));
    expect(await screen.findByText("Quel momento è fuori dallo storico disponibile.")).toBeDefined();
    expect(spy).toHaveBeenCalledWith("v-notes", expect.stringContaining("2020-01-01"));
  });

  it("delete requires the exact name", async () => {
    signInAs("demo");
    const { router } = await renderRoute("/vaults/v-work?tab=settings");
    fireEvent.click(await screen.findByRole("button", { name: "Elimina il vault" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Elimina definitivamente" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Scrivi il nome del vault per confermare"), { target: { value: "lavoro" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Scrivi il nome del vault per confermare"), { target: { value: "Lavoro" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(router.state.location.pathname).toBe("/vaults"));
    expect(ud.vaults.some((v) => v.id === "v-work")).toBe(false);
  });
});
```

- [ ] **Step 3: Implementazione**

`apps/web/src/pages/vaults/FileHistoryDialog.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { formatBytes, formatDateTime } from "../../lib/format.js";
import { cn } from "../../lib/utils.js";

export function FileHistoryDialog({ fileId, onOpenChange }: { fileId: string | null; onOpenChange: (o: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const lang = i18n.language;
  const versions = useQuery({ queryKey: ["file-versions", fileId], queryFn: () => api.fileVersions(fileId!), enabled: !!fileId });
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setSelected(null), [fileId]);
  const content = useQuery({ queryKey: ["version", selected], queryFn: () => api.version(selected!), enabled: !!selected });
  const restore = useMutation({
    mutationFn: (id: string) => api.restoreVersion(id),
    onSuccess: async () => {
      toast(t("history.restored"));
      setSelected(null);
      await qc.invalidateQueries({ queryKey: ["file-versions", fileId] });
      void qc.invalidateQueries({ queryKey: ["files"] });
    },
    onError: (err) => toast.error(errorMessage(err, t)),
  });
  const data = versions.data;
  const chosen = data?.versions.find((v) => v.id === selected);

  return (
    <Dialog open={!!fileId} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="break-all">{data ? t("history.title", { path: data.path }) : ""}</DialogTitle>
          <DialogDescription>{t("history.restoreHint")}</DialogDescription>
        </DialogHeader>
        <ul className="max-h-48 divide-y overflow-auto rounded-lg border">
          {data?.versions.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                onClick={() => setSelected(v.id)}
                aria-pressed={selected === v.id}
                className={cn("flex w-full justify-between gap-2 p-2 text-left text-sm", selected === v.id ? "bg-accent" : "hover:bg-muted")}
              >
                <span>{formatDateTime(v.at, lang)} · {v.device}{v.current ? ` · ${t("history.current")}` : ""}</span>
                <span className="text-muted-foreground">{formatBytes(v.size, lang)}</span>
              </button>
            </li>
          ))}
        </ul>
        {content.data && (
          <section aria-label={t("history.preview")} className="space-y-2">
            {content.data.text !== null ? (
              <pre className="bg-muted max-h-64 overflow-auto rounded p-3 text-sm whitespace-pre-wrap">{content.data.text}</pre>
            ) : content.data.previewUrl ? (
              <img src={content.data.previewUrl} alt={t("history.preview")} className="max-h-64 rounded" />
            ) : (
              <p className="text-muted-foreground text-sm">{t("history.noPreview")}</p>
            )}
            {chosen && !chosen.current && (
              <Button disabled={restore.isPending} onClick={() => restore.mutate(chosen.id)}>{t("history.restore")}</Button>
            )}
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

`apps/web/src/pages/vaults/VaultHistoryTab.tsx`:

```tsx
import type { Vault } from "@kamino/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { formatAgo, formatBytes, formatDateTime } from "../../lib/format.js";
import { FileHistoryDialog } from "./FileHistoryDialog.js";

export function VaultHistoryTab({ vault }: { vault: Vault }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const lang = i18n.language;
  const [q, setQ] = useState("");
  const [fileId, setFileId] = useState<string | null>(null);
  const files = useQuery({ queryKey: ["files", vault.id, q], queryFn: () => api.files(vault.id, q) });
  const trash = useQuery({ queryKey: ["trash", vault.id], queryFn: () => api.trash(vault.id) });
  const restore = useMutation({
    mutationFn: (id: string) => api.restoreTrash(id),
    onSuccess: () => {
      toast(t("history.fileRestored"));
      void qc.invalidateQueries({ queryKey: ["trash", vault.id] });
    },
    onError: (err) => toast.error(errorMessage(err, t)),
  });

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="history-search">{t("history.search")}</Label>
        <Input id="history-search" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="bg-card divide-y rounded-xl border">
          {files.data?.files.length === 0 && <li className="text-muted-foreground p-3 text-sm">{t("history.noFiles")}</li>}
          {files.data?.files.map((f) => (
            <li key={f.fileId}>
              <button type="button" onClick={() => setFileId(f.fileId)} className="hover:bg-muted flex w-full flex-wrap justify-between gap-2 p-3 text-left">
                <span className="font-medium break-all">{f.path}</span>
                <span className="text-muted-foreground text-sm">
                  {t("history.versions", { count: f.versions })} · {t("history.changed", { when: formatAgo(f.lastChangedAt, lang) })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <section aria-label={t("history.trash")} className="space-y-2">
        <h2 className="font-serif text-lg font-semibold">{t("history.trash")}</h2>
        <p className="text-muted-foreground text-sm">{t("history.trashHint")}</p>
        <ul className="bg-card divide-y rounded-xl border">
          {trash.data?.items.length === 0 && <li className="text-muted-foreground p-3 text-sm">{t("history.trashEmpty")}</li>}
          {trash.data?.items.map((item) => (
            <li key={item.fileId} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <span>
                <span className="font-medium break-all">{item.path}</span>
                <span className="text-muted-foreground block text-sm">
                  {t("history.deletedOn", { when: formatDateTime(item.deletedAt, lang), expires: formatDateTime(item.expiresAt, lang) })} · {formatBytes(item.size, lang)}
                </span>
              </span>
              <Button size="sm" variant="outline" disabled={restore.isPending} onClick={() => restore.mutate(item.fileId)}>
                {t("history.restoreFile")}
              </Button>
            </li>
          ))}
        </ul>
      </section>
      <FileHistoryDialog fileId={fileId} onOpenChange={(o) => !o && setFileId(null)} />
    </div>
  );
}
```

`apps/web/src/pages/vaults/VaultSettingsTab.tsx`:

```tsx
import type { Vault } from "@kamino/protocol";
import { PRODUCT_SLUG } from "@kamino/brand";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { TextField } from "../../components/TextField.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { formatDateTime } from "../../lib/format.js";
import { ErrorText } from "../auth/AuthCard.js";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-card space-y-3 rounded-xl border p-4">
      <h2 className="font-serif text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function VaultSettingsTab({ vault }: { vault: Vault }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const lang = i18n.language;
  const [name, setName] = useState(vault.name);
  const [retention, setRetention] = useState(String(vault.retentionDays));
  const [zipMode, setZipMode] = useState<"now" | "at">("now");
  const [zipAt, setZipAt] = useState("");
  const [zipError, setZipError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["vault", vault.id] }), qc.invalidateQueries({ queryKey: ["vaults"] }), qc.invalidateQueries({ queryKey: ["vaults-summary"] })]);

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
      if (done) toast(t(done));
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  };

  const download = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setZipError(null);
    setBusy("zip");
    try {
      const at = zipMode === "at" && zipAt ? new Date(zipAt).toISOString() : undefined;
      const blob = await api.downloadZip(vault.id, at);
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: `${PRODUCT_SLUG}-${vault.name}.zip` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setZipError(errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy("delete");
    try {
      await api.deleteVault(vault.id, confirmName);
      toast(t("vaultSettings.deleted"));
      setDeleteOpen(false);
      await qc.invalidateQueries();
      await navigate({ to: "/vaults" });
    } catch (err) {
      toast.error(errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <Section title={t("vaultSettings.rename")}>
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run("name", () => api.updateVault(vault.id, { name }), "vaultSettings.renamed"); }} className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1"><TextField label={t("vaultSettings.name")} value={name} onChange={setName} /></div>
          <Button type="submit" disabled={busy !== null}>{t("vaultSettings.rename")}</Button>
        </form>
      </Section>

      <Section title={t("vaultSettings.retention")}>
        <form onSubmit={(e) => { e.preventDefault(); void run("retention", () => api.updateVault(vault.id, { retentionDays: Number(retention) }), "vaultSettings.saved"); }} className="space-y-2">
          <Label htmlFor="retention">{t("vaultSettings.retention")}</Label>
          <p className="text-muted-foreground text-sm">{t("vaultSettings.retentionHint", { max: vault.maxRetentionDays })}</p>
          <div className="flex gap-2">
            <select id="retention" value={retention} onChange={(e) => setRetention(e.target.value)} className="bg-background rounded-md border px-2">
              {[0, 7, 14, 30, 60, 90].filter((d) => d <= vault.maxRetentionDays).map((d) => (
                <option key={d} value={d}>{t("vaultSettings.days", { count: d })}</option>
              ))}
            </select>
            <Button type="submit" disabled={busy !== null}>{t("vaultSettings.save")}</Button>
          </div>
        </form>
      </Section>

      <Section title={t("vaultSettings.zip")}>
        <form onSubmit={(e) => void download(e)} className="space-y-2">
          <div role="radiogroup" className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2"><input type="radio" name="zip" checked={zipMode === "now"} onChange={() => setZipMode("now")} />{t("vaultSettings.zipNow")}</label>
            <label className="flex items-center gap-2"><input type="radio" name="zip" checked={zipMode === "at"} onChange={() => setZipMode("at")} />{t("vaultSettings.zipAt")}</label>
          </div>
          {zipMode === "at" && (
            <div className="space-y-1">
              <Label htmlFor="zip-at">{t("vaultSettings.zipAtLabel")}</Label>
              <Input id="zip-at" type="datetime-local" value={zipAt} onChange={(e) => setZipAt(e.target.value)} />
              <p className="text-muted-foreground text-sm">{t("vaultSettings.zipHint", { from: formatDateTime(vault.historyFrom, lang) })}</p>
            </div>
          )}
          <ErrorText>{zipError}</ErrorText>
          <Button type="submit" disabled={busy !== null || (zipMode === "at" && !zipAt)}>{t("vaultSettings.download")}</Button>
        </form>
      </Section>

      <Section title={t("vaultSettings.danger")}>
        <Button variant="destructive" onClick={() => { setConfirmName(""); setDeleteOpen(true); }}>{t("vaultSettings.delete")}</Button>
      </Section>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("vaultSettings.deleteTitle", { name: vault.name })}
        text={t("vaultSettings.deleteText")}
        confirmText={t("vaultSettings.deleteConfirm")}
        cancelText={t("vaultSettings.cancel")}
        destructive
        busy={busy === "delete" || confirmName !== vault.name}
        onConfirm={() => void remove()}
      >
        <TextField label={t("vaultSettings.deleteConfirmLabel")} value={confirmName} onChange={setConfirmName} autoComplete="off" />
      </ConfirmDialog>
    </div>
  );
}
```

Run: test, typecheck, lint, format.

```bash
git add apps/web && git commit -m "feat(web): add file history, trash and vault settings"
```

---

### Task 7: Rinvii della 4a e build

**Files:** Modify `apps/web/src/app/AppShell.tsx` (lingua e tema da `me`), `apps/web/test/build.test.ts` (dimensione dei chunk); Test `apps/web/src/app/AppShell.test.tsx` (nuovo caso).

- [ ] **Step 1: Test (falliscono)**

In `AppShell.test.tsx`:

```tsx
  it("applies language and theme saved on the server", async () => {
    signInAs("demo"); // demo: lang "en"
    await renderRoute("/account", "it");
    expect(await screen.findByRole("navigation", { name: "Main navigation" })).toBeDefined();
  });
```

In `apps/web/test/build.test.ts`:

```ts
  it("keeps every chunk under 500 KB (heavy routes are lazy)", () => {
    for (const f of files.filter((x) => x.endsWith(".js"))) {
      expect(statSync(f).size, f).toBeLessThan(500 * 1024);
    }
  });
```

- [ ] **Step 2: Implementazione** — in `AppShell.tsx`:

```tsx
  const { i18n } = useTranslation();
  const { setTheme } = useTheme();
  // Language and theme saved on the server win at sign-in (and when the user changes).
  useEffect(() => {
    if (!me) return;
    if (i18n.language !== me.lang) {
      void i18n.changeLanguage(me.lang);
      document.documentElement.lang = me.lang;
    }
    setTheme(me.theme);
  }, [me?.id]);
```

(import di `useEffect` e `useTheme`; unire con l'`useTranslation` esistente.) Se dopo le route lazy un chunk resta > 500 KB (CodeMirror), aggiungere a `vite.config.ts` `build.rollupOptions.output.manualChunks: { codemirror: ["@codemirror/state", "@codemirror/view", "@codemirror/merge"] }` e ricontrollare.

Run: `pnpm --filter @kamino/web test` → PASS.

```bash
git add apps/web && git commit -m "feat(web): apply saved language and theme; split heavy routes"
```

---

### Task 8: Documentazione e verifica

- [ ] `docs/ui/design-system.md` §10 "Web app: area utente": panoramica (quota e avviso 90%), vault a schede, dispositivi (D-06, revoca), aggiungi dispositivo dal web, centro conflitti (elenco + dettaglio; telefono a due pagine; stesse regole del plugin), storico e cestino, impostazioni del vault (ZIP alla data, eliminazione col nome), simulazioni del pannello "Dati finti".
- [ ] HANDOVER (stato, decisioni X1–X4, punti aperti); `CLAUDE.md` invariato salvo necessità; changeset `.changeset/web-user-area.md` (`"@kamino/web": minor` — "Add the user area: overview, vaults with history, trash and settings, devices, pairing from the web and the conflict center.").
- [ ] Verifica completa (`pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm release-names:check`, build Docker), commit, push, CI, revisione finale (un subagente), PR, prova del committente.
