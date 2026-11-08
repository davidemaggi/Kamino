# Fase UI, sotto-fase 3 — Onboarding, collegamento e impostazioni: piano di implementazione

> **For agentic workers:** standard del progetto (`CLAUDE.md`): eseguire con superpowers:executing-plans nella sessione corrente, a blocchi con checkpoint; subagent-driven-development solo su richiesta del committente. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** scheda di benvenuto, collegamento (primo dispositivo, vault esistente, QR/link con approvazione), trasferimento iniziale e impostazioni complete del plugin, su interfacce di servizio con un server finto.

**Architecture:** `ConnectionService` + `InitialTransfer` (in `src/connection/`) descrivono ciò che il server farà; `FakeServer` li implementa in memoria con orologio, attese e casualità iniettabili. Le viste ricevono tutto da `UiContext`. Le impostazioni sono un modello puro (`normalizeSettings`, `validateGlob`) salvato da `SettingsStore` con `loadData`/`saveData`. Il link `obsidian://<PROTOCOL_ACTION>` è gestito da `registerObsidianProtocolHandler`; il QR è un SVG generato con `uqr`.

**Tech Stack:** TypeScript strict, API di Obsidian (`ItemView`, `Modal`, `PluginSettingTab`, `Setting`, protocol handler), `uqr`, Vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-11-08-ui-onboarding-design.md`.

**Blocchi e checkpoint:** (A) Task 1 → **checkpoint col committente: link `obsidian://` e QR**; (B) Task 2–4 (modelli); (C) Task 5–6 (benvenuto, collegamento, trasferimento) → prova; (D) Task 7–8 (pairing, impostazioni) → prova; (E) Task 9.

## Global Constraints

- TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- Plugin: niente API Node/Electron; solo API di Obsidian, DOM standard, `@kamino/*`, `@codemirror/merge`, `uqr`.
- Nessun testo UI scritto a mano: `src/i18n/{it,en}.json` (stesse chiavi), placeholder `{name}` con `fmt`; nome prodotto da `@kamino/brand`. Lessico a tema vietato nei testi UI.
- Mai loggare password, token, path o nomi di file. La password non viene mai salvata né lasciata nel DOM dopo la chiusura della finestra.
- Su mobile un server `http://` è sempre bloccato; su desktop è ammesso con avviso.
- Nessun membro privato con un nome già usato da `Component`/`View`/`Modal`/`PluginSettingTab` di Obsidian (`load`, `unload`, `register*`, `open`, `close`, `display`, `hide`…): il typecheck lo segnala (TS2415), va rinominato.
- CSS: solo variabili di Obsidian (ammesso `rgba(var(--color-*-rgb), …)`), prefisso `kamino-` (`CLASS_PREFIX`), mai bordi laterali colorati.
- Comandi di sviluppo (id `dev-*`) solo con `__DEV__`.
- Commit Conventional Commits in inglese; documentazione in italiano.

## Review Focus

1. Link `obsidian://` malformato (server mancante, schema `ftp:`, token vuoto) → notice "non valido", mai un'eccezione. → Task 1, Task 7.
2. `http://` su telefono → bloccato sia nel collegamento manuale sia dal link; su desktop passa con l'avviso. → Task 3, 6, 7.
3. Vault con file locali che si collega a un vault esistente (manuale o QR) → avviso di riconciliazione **prima** del trasferimento; "Annulla" dopo l'approvazione scollega. → Task 6, 7.
4. Finestra "Aggiungi un dispositivo" chiusa quando arriva la richiesta → notice + sezione nel pannello; con la finestra aperta nessuna notice doppia. → Task 7.
5. `data.json` assente, vecchio o rovinato → impostazioni di default, nessun crash. → Task 4.

## File Structure

```
packages/brand/src/index.ts                PROTOCOL_ACTION
packages/status/src/{levels,types,describe,examples,messages}.ts   linked?, working.notLinked
apps/plugin/
  src/connection/link.ts (+test)           parsePairingLink, parsePairingUrl, buildPairingLink
  src/connection/qr.ts (+test)             qrDataUrl
  src/connection/types.ts                  ConnectionService, InitialTransfer, …
  src/connection/fake-server.ts (+test)    FakeServer
  src/connection/handle-link.ts            gestione del link obsidian://
  src/connection/pairing-notices.ts        notice di richieste/nuovi dispositivi
  src/settings/model.ts (+test)            PluginSettings, normalizeSettings, validateGlob
  src/settings/store.ts (+test)            SettingsStore
  src/settings/SettingsTab.ts (+test)      riscritta
  src/ui/context.ts                        UiContext esteso
  src/ui/workspace.ts                      WELCOME_VIEW, TRANSFER_VIEW, open*
  src/ui/WelcomeView.ts (+test)
  src/ui/ConnectModal.ts (+test)
  src/ui/TransferView.ts (+test)
  src/ui/PairingClaimModal.ts (+test)
  src/ui/AddDeviceModal.ts (+test)
  src/ui/ConfirmModal.ts
  src/ui/StatusPanelView.ts                "Collega…", richieste di collegamento
  src/state/fake.ts                        setLinked, setTransfer
  src/dev/commands.ts, src/dev/link-test.ts
  src/__mocks__/obsidian.ts                Setting components, vault, loadData/saveData, protocol handler
  src/__mocks__/ui-context.ts              makeCtx esteso
  src/main.ts, src/styles.css, src/i18n/{it,en}.json
```

---

### Task 1: Link `obsidian://` e QR (checkpoint)

**Files:**
- Modify: `packages/brand/src/index.ts`, `packages/brand/src/index.test.ts`
- Create: `apps/plugin/src/connection/link.ts`, `apps/plugin/src/connection/qr.ts`, `apps/plugin/src/dev/link-test.ts`
- Test: `apps/plugin/src/connection/link.test.ts`, `apps/plugin/src/connection/qr.test.ts`
- Modify: `apps/plugin/src/main.ts`, `apps/plugin/src/dev/commands.ts`, `apps/plugin/src/i18n/{it,en}.json`, `apps/plugin/src/__mocks__/obsidian.ts`

**Interfaces:**
- Produces: `PROTOCOL_ACTION: string` (brand); `interface PairingLink { server: string; token: string }`; `parsePairingLink(params: Record<string, string | undefined>): LinkParseResult`; `parsePairingUrl(text: string, action: string): LinkParseResult`; `buildPairingLink(action: string, link: PairingLink): string`; `type LinkParseResult = { ok: true; link: PairingLink } | { ok: false; reason: "missing_server" | "invalid_server" | "missing_token" | "not_a_link" }`; `qrDataUrl(text: string): string`.

- [ ] **Step 1: `PROTOCOL_ACTION`**

In `packages/brand/src/index.ts`, dopo `PRODUCT_SLUG`:

```ts
/** Action of the obsidian:// link handled by the plugin (QR / magic link). */
export const PROTOCOL_ACTION = PRODUCT_SLUG;
```

In `packages/brand/src/index.test.ts` aggiungere:

```ts
it("protocol action is the product slug", () => {
  expect(PROTOCOL_ACTION).toBe(PRODUCT_SLUG);
});
```

(importare `PROTOCOL_ACTION` e `PRODUCT_SLUG` se non già importati). Run: `pnpm --filter @kamino/brand test && pnpm --filter @kamino/brand build`.

- [ ] **Step 2: Test del parsing (falliscono)**

`apps/plugin/src/connection/link.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildPairingLink, parsePairingLink, parsePairingUrl } from "./link.js";

describe("parsePairingLink", () => {
  it("accepts https and http servers and normalizes the trailing slash", () => {
    expect(parsePairingLink({ server: "https://sync.example/", token: "abc" })).toEqual({
      ok: true,
      link: { server: "https://sync.example", token: "abc" },
    });
    expect(parsePairingLink({ server: "http://10.0.0.2:8080/kamino/", token: "t" })).toEqual({
      ok: true,
      link: { server: "http://10.0.0.2:8080/kamino", token: "t" },
    });
  });

  it.each([
    [{ token: "abc" }, "missing_server"],
    [{ server: " ", token: "abc" }, "missing_server"],
    [{ server: "not a url", token: "abc" }, "invalid_server"],
    [{ server: "ftp://sync.example", token: "abc" }, "invalid_server"],
    [{ server: "https://sync.example" }, "missing_token"],
    [{ server: "https://sync.example", token: "  " }, "missing_token"],
  ])("%o -> %s", (params, reason) => {
    expect(parsePairingLink(params)).toEqual({ ok: false, reason });
  });
});

describe("parsePairingUrl / buildPairingLink", () => {
  it("round-trips", () => {
    const text = buildPairingLink("kamino", { server: "https://sync.example", token: "a b&c" });
    expect(text).toBe("obsidian://kamino?server=https%3A%2F%2Fsync.example&token=a%20b%26c");
    expect(parsePairingUrl(text, "kamino")).toEqual({
      ok: true,
      link: { server: "https://sync.example", token: "a b&c" },
    });
  });

  it.each(["", "hello", "https://sync.example?token=x", "obsidian://other?server=https%3A%2F%2Fa&token=x"])(
    "%s is not a pairing link",
    (text) => {
      expect(parsePairingUrl(text, "kamino")).toEqual({ ok: false, reason: "not_a_link" });
    },
  );
});
```

Run: `pnpm --filter @kamino/plugin test -- link` → FAIL.

- [ ] **Step 3: `link.ts`**

`apps/plugin/src/connection/link.ts`:

```ts
/** Pairing link: obsidian://<action>?server=<url>&token=<token> (protocol §10, ADR-0012). */
export interface PairingLink {
  server: string;
  token: string;
}

export type LinkParseResult =
  | { ok: true; link: PairingLink }
  | { ok: false; reason: "missing_server" | "invalid_server" | "missing_token" | "not_a_link" };

/** Validates the parameters Obsidian passes to the protocol handler. Never throws. */
export function parsePairingLink(params: Record<string, string | undefined>): LinkParseResult {
  const server = params["server"]?.trim();
  const token = params["token"]?.trim();
  if (!server) return { ok: false, reason: "missing_server" };
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    return { ok: false, reason: "invalid_server" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "invalid_server" };
  if (!token) return { ok: false, reason: "missing_token" };
  return { ok: true, link: { server: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, token } };
}

/** Parses a pasted link (desktop "paste the link" field). Never throws. */
export function parsePairingUrl(text: string, action: string): LinkParseResult {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return { ok: false, reason: "not_a_link" };
  }
  if (url.protocol !== "obsidian:" || url.hostname !== action) return { ok: false, reason: "not_a_link" };
  return parsePairingLink(Object.fromEntries(url.searchParams));
}

export function buildPairingLink(action: string, link: PairingLink): string {
  return `obsidian://${action}?server=${encodeURIComponent(link.server)}&token=${encodeURIComponent(link.token)}`;
}
```

Run: PASS. (Se `URL` di jsdom/Node non espone `hostname` per lo schema `obsidian:`, usare `url.host`; il test lo verifica.)

- [ ] **Step 4: QR**

Run: `pnpm --filter @kamino/plugin add uqr`. Verificare in `node_modules/uqr` il nome della funzione SVG e delle opzioni (attesi: `renderSVG(text, { border, whiteColor, blackColor })`) e adattare `qr.ts` se diversi.

`apps/plugin/src/connection/qr.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { qrDataUrl } from "./qr.js";

describe("qrDataUrl", () => {
  it("returns an SVG data URL", () => {
    const url = qrDataUrl("obsidian://kamino?server=https%3A%2F%2Fsync.example&token=abc");
    expect(url.startsWith("data:image/svg+xml,")).toBe(true);
    expect(decodeURIComponent(url.slice("data:image/svg+xml,".length))).toContain("<svg");
  });
});
```

`apps/plugin/src/connection/qr.ts`:

```ts
import { renderSVG } from "uqr";

/** QR code as an SVG data URL. Fixed black on white with a quiet zone: cameras read it on any theme. */
export function qrDataUrl(text: string): string {
  const svg = renderSVG(text, { border: 2, whiteColor: "#ffffff", blackColor: "#000000" });
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
```

Run: `pnpm --filter @kamino/plugin test -- qr` → PASS.

- [ ] **Step 5: Testi, handler provvisorio e comando di prova**

`src/i18n/it.json` → oggetto `pairing`: `{ "invalidLink": "Link di collegamento non valido.", "linkReceived": "Link ricevuto da {host}." }`; `dev`: `"linkTest": "Mostra QR di prova (sviluppo)"`, `"linkTestHint": "Inquadra il codice con la fotocamera del telefono, oppure esegui nel terminale: {command}"`.
`en.json` → `pairing`: `{ "invalidLink": "Invalid pairing link.", "linkReceived": "Link received from {host}." }`; `dev`: `"linkTest": "Show test QR (development)"`, `"linkTestHint": "Scan the code with the phone camera, or run in a terminal: {command}"`.

In `src/__mocks__/obsidian.ts`, nella classe `Plugin`:

```ts
  protocolHandlers = new Map<string, (params: Record<string, string>) => unknown>();
  registerObsidianProtocolHandler(action: string, handler: (params: Record<string, string>) => unknown): void {
    this.protocolHandlers.set(action, handler);
  }
```

`apps/plugin/src/dev/link-test.ts`:

```ts
import { PROTOCOL_ACTION } from "@kamino/brand";
import type { Lang } from "@kamino/status";
import { Modal, type App } from "obsidian";
import { buildPairingLink } from "../connection/link.js";
import { qrDataUrl } from "../connection/qr.js";
import { fmt } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import { h } from "../ui/dom.js";

/** Dev-only: shows a QR for a sample link, to check camera recognition and the protocol handler. */
export class LinkTestModal extends Modal {
  constructor(
    app: App,
    private readonly lang: Lang,
  ) {
    super(app);
  }

  override onOpen(): void {
    const m = t(this.lang).dev;
    const link = buildPairingLink(PROTOCOL_ACTION, { server: "https://sync.example", token: "test-token" });
    this.titleEl.textContent = m.linkTest;
    h(this.contentEl, "img", { attrs: { src: qrDataUrl(link), alt: m.linkTest, width: "220", height: "220" } });
    h(this.contentEl, "p", { text: fmt(m.linkTestHint, { command: `open "${link}"` }) });
  }

  override onClose(): void {
    this.contentEl.replaceChildren();
  }
}
```

In `src/dev/commands.ts` registrare:

```ts
  plugin.addCommand({
    id: "dev-link-test",
    name: t(deps.lang).dev.linkTest,
    callback: () => new LinkTestModal(plugin.app, deps.lang).open(),
  });
```

In `src/main.ts` (provvisorio, sostituito nel Task 7), dopo i comandi:

```ts
    // Pairing link handler. Until the claim flow lands (task 7) it only validates and reports.
    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => {
      const parsed = parsePairingLink(params);
      new Notice(
        parsed.ok
          ? fmt(m.pairing.linkReceived, { host: new URL(parsed.link.server).host })
          : m.pairing.invalidLink,
      );
    });
```

(import di `PROTOCOL_ACTION`, `Notice`, `parsePairingLink`, `fmt`.)

Run: `pnpm --filter @kamino/plugin test && pnpm --filter @kamino/plugin typecheck && pnpm --filter @kamino/plugin lint` → verdi.

- [ ] **Step 6: Commit, build:vault, checkpoint**

```bash
git add packages/brand apps/plugin pnpm-lock.yaml
git commit -m "feat(plugin): parse pairing links and render QR codes"
pnpm --filter @kamino/plugin build:vault
```

**Checkpoint col committente** (Obsidian desktop, vault di prova, plugin ricaricato):
1. Comando "Mostra QR di prova (sviluppo)": inquadrare il QR con la fotocamera del telefono → deve proporre di aprire un link `obsidian://kamino?...` (non serve aprirlo).
2. Nel terminale: `open "obsidian://kamino?server=https%3A%2F%2Fsync.example&token=test-token"` → in Obsidian compare "Link ricevuto da sync.example.".
3. `open "obsidian://kamino?token=x"` → "Link di collegamento non valido.".
Se 1 o 2 falliscono: fermarsi e decidere col committente.

---

### Task 2: Stato "Non collegato" in `@kamino/status`

**Files:**
- Modify: `packages/status/src/{types,levels,describe,examples,messages}.ts`
- Test: `packages/status/src/describe.test.ts`, `packages/status/src/describe.property.test.ts`

**Interfaces:**
- Produces: `SyncSnapshot.linked?: boolean` (assente = collegato); chiave `"working.notLinked"` (icona `cloud-off`); esempio `"not-linked"`.

- [ ] **Step 1: Test (falliscono)**

In `describe.test.ts` (describe "describeStatus rules") aggiungere:

```ts
  it("not linked wins over never synced and is never safe", () => {
    const d = describeStatus({ ...synced, linked: false, lastConfirmedAt: null }, DEFAULT_THRESHOLDS, NOW);
    expect(d.level).toBe("working");
    expect(d.message.key).toBe("working.notLinked");
    expect(describeStatus({ ...synced, linked: false }, DEFAULT_THRESHOLDS, NOW).level).toBe("working");
  });
```

In `describe.property.test.ts`: nello `snapshotArb` aggiungere `linked: fc.boolean(),`; in P1 aggiungere `expect(s.linked).not.toBe(false);`; in P4 aggiungere `if (s.queued === 0 && s.linked === false) expect(keys).toContain("working.notLinked");` e cambiare la riga di `neverSynced` in `if (s.queued === 0 && s.linked !== false && s.lastConfirmedAt === null) expect(keys).toContain("working.neverSynced");`.

Run: `pnpm --filter @kamino/status test` → FAIL.

- [ ] **Step 2: Implementazione**

- `types.ts`, in `SyncSnapshot`: `/** false = this vault is not linked to a server yet. Absent = linked. */ linked?: boolean;`
- `levels.ts`: `"working.notLinked"` in `STATUS_KEYS` (dopo `"working.queued"`); `MESSAGE_ICON["working.notLinked"] = "cloud-off"`.
- `describe.ts`: nel ramo `working`:

```ts
  if (s.queued > 0) {
    add("working", s.syncing ? "working.syncing" : "working.queued", { count: s.queued });
  } else if (s.linked === false) {
    add("working", "working.notLinked");
  } else if (s.lastConfirmedAt === null) {
    add("working", "working.neverSynced");
  }
```

- `messages.ts`: it `"working.notLinked": "Non collegato"`, en `"working.notLinked": "Not linked"`.
- `examples.ts`: dopo `never-synced` aggiungere `{ id: "not-linked", snapshot: { ...base, linked: false }, expected: { level: "working", key: "working.notLinked" } },`.

Run: `pnpm --filter @kamino/status test && pnpm --filter @kamino/status build` → PASS; poi `pnpm --filter @kamino/web test && pnpm --filter @kamino/plugin test` (gli esempi crescono di uno; i test che contano gli esempi li leggono da `exampleSnapshots`).

```bash
git add packages/status
git commit -m "feat(status): add not-linked state"
```

---

### Task 3: `ConnectionService`, `InitialTransfer` e `FakeServer`

**Files:**
- Create: `apps/plugin/src/connection/types.ts`, `apps/plugin/src/connection/fake-server.ts`
- Test: `apps/plugin/src/connection/fake-server.test.ts`

**Interfaces:**
- Produces: tutti i tipi di spec §4.1–4.2 (con `InitialTransfer.start(direction)`); `class FakeServer implements ConnectionService, InitialTransfer` con `constructor(opts: FakeServerOptions)` e metodi di simulazione `simulateIncomingClaim(deviceName?, platform?)`, `simulateClaimAnswer(answer: "approved" | "denied")`, `simulateDeviceJoined(name)`, `interruptTransfer()`, `failTransfer()`, `advance(files: number)`; `interface FakeServerOptions { isMobile: boolean; clock: () => number; delay: (ms: number) => Promise<void>; random: () => number; localFileCount: () => number; pluginVersion: string; platform: string; store: LinkStore; autoRun: boolean }`; `interface LinkStore { load(): LinkInfo | null; save(link: LinkInfo | null): void }`; `VERIFICATION_ALPHABET`.

- [ ] **Step 1: Tipi**

`apps/plugin/src/connection/types.ts`:

```ts
import type { PairingLink } from "./link.js";

export type ServerCheck =
  | { ok: true; host: string; insecure: boolean }
  | { ok: false; reason: "invalid_url" | "unreachable" | "incompatible" | "insecure_on_mobile" };

export interface Session {
  server: string;
  user: string;
  expiresAt: number;
}

export type LoginResult =
  | { ok: true; session: Session }
  | { ok: false; reason: "bad_credentials" | "totp_required" | "bad_totp" | "locked" };

export interface VaultSummary {
  id: string;
  name: string;
  fileCount: number;
  deviceCount: number;
}

export interface LinkInfo {
  server: string;
  host: string;
  user: string;
  vaultId: string;
  vaultName: string;
  deviceName: string;
}

export interface PairingOffer {
  pairingId: string;
  link: string;
  expiresAt: number;
}

export interface PairingRequest {
  pairingId: string;
  deviceName: string;
  platform: string;
  pluginVersion: string;
  code: string;
  at: number;
  expiresAt: number;
}

export type ClaimResult =
  | { ok: true; claimId: string; code: string; expiresAt: number; host: string }
  | { ok: false; reason: "invalid" | "expired" | "already_claimed" };

export type ClaimStatus = "pending" | "approved" | "denied" | "expired";

export type ConnectionEvent =
  | { type: "linked" }
  | { type: "unlinked" }
  | { type: "pairing_request"; request: PairingRequest }
  | { type: "pairing_closed"; pairingId: string }
  | { type: "pairing_reused"; pairingId: string }
  | { type: "device_joined"; deviceName: string };

export interface ConnectionService {
  link(): LinkInfo | null;
  checkServer(url: string): Promise<ServerCheck>;
  login(server: string, user: string, password: string, totp?: string): Promise<LoginResult>;
  listVaults(session: Session): Promise<VaultSummary[]>;
  createVault(session: Session, name: string): Promise<VaultSummary>;
  linkDevice(session: Session, vaultId: string, deviceName: string): Promise<LinkInfo>;
  renameDevice(name: string): Promise<void>;
  unlink(): Promise<void>;
  startPairing(): Promise<PairingOffer>;
  pairingRequests(): PairingRequest[];
  approve(pairingId: string): Promise<void>;
  deny(pairingId: string): Promise<void>;
  cancelPairing(pairingId: string): Promise<void>;
  claim(link: PairingLink, deviceName: string): Promise<ClaimResult>;
  claimStatus(claimId: string): Promise<ClaimStatus>;
  cancelClaim(claimId: string): Promise<void>;
  onChange(cb: (event: ConnectionEvent) => void): () => void;
}

export interface TransferProgress {
  direction: "upload" | "download";
  phase: "running" | "paused" | "interrupted" | "failed" | "done";
  files: { done: number; total: number };
  bytes: { done: number; total: number };
}

export interface InitialTransfer {
  start(direction: "upload" | "download"): void;
  progress(): TransferProgress | null;
  pause(): void;
  resume(): void;
  retry(): void;
  onChange(cb: () => void): () => void;
}
```

- [ ] **Step 2: Test del `FakeServer` (falliscono)**

`apps/plugin/src/connection/fake-server.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { FakeServer, VERIFICATION_ALPHABET, type FakeServerOptions } from "./fake-server.js";
import type { ConnectionEvent, LinkInfo } from "./types.js";

const MIN = 60_000;

function make(over: Partial<FakeServerOptions> = {}) {
  let now = Date.UTC(2026, 10, 8, 10, 0);
  let saved: LinkInfo | null = null;
  const events: ConnectionEvent[] = [];
  const server = new FakeServer({
    isMobile: false,
    clock: () => now,
    delay: () => Promise.resolve(),
    random: () => 0.5,
    localFileCount: () => 12,
    pluginVersion: "0.0.0",
    platform: "macOS",
    store: { load: () => saved, save: (l) => (saved = l) },
    autoRun: false,
    ...over,
  });
  server.onChange((e) => events.push(e));
  return { server, events, tick: (ms: number) => (now += ms), saved: () => saved };
}

async function linkedDemo() {
  const ctx = make();
  const login = await ctx.server.login("https://sync.example", "demo", "demo");
  if (!login.ok) throw new Error("login");
  await ctx.server.linkDevice(login.session, "v-notes", "Laptop");
  return ctx;
}

describe("checkServer", () => {
  it.each([
    ["nope", { ok: false, reason: "invalid_url" }],
    ["ftp://sync.example", { ok: false, reason: "invalid_url" }],
    ["https://unreachable.example", { ok: false, reason: "unreachable" }],
    ["https://old.example", { ok: false, reason: "incompatible" }],
    ["https://sync.example", { ok: true, host: "sync.example", insecure: false }],
    ["http://10.0.0.2:8080", { ok: true, host: "10.0.0.2:8080", insecure: true }],
  ])("%s on desktop", async (url, result) => {
    expect(await make().server.checkServer(url)).toEqual(result);
  });

  it("blocks http on mobile", async () => {
    expect(await make({ isMobile: true }).server.checkServer("http://10.0.0.2")).toEqual({
      ok: false,
      reason: "insecure_on_mobile",
    });
  });
});

describe("login", () => {
  const s = "https://sync.example";
  it.each([
    ["demo", "demo", undefined, true],
    ["demo", "wrong", undefined, "bad_credentials"],
    ["nobody", "demo", undefined, "bad_credentials"],
    ["locked", "demo", undefined, "locked"],
    ["demo2fa", "demo", undefined, "totp_required"],
    ["demo2fa", "demo", "000000", "bad_totp"],
    ["demo2fa", "demo", "123456", true],
  ])("%s / %s / %s", async (user, password, totp, expected) => {
    const r = await make().server.login(s, user, password, totp);
    if (expected === true) expect(r.ok).toBe(true);
    else expect(r).toEqual({ ok: false, reason: expected });
  });
});

describe("vaults and linking", () => {
  it("lists vaults for demo, none for demo2fa", async () => {
    const { server } = make();
    const a = await server.login("https://sync.example", "demo", "demo");
    const b = await server.login("https://sync.example", "demo2fa", "demo", "123456");
    if (!a.ok || !b.ok) throw new Error("login");
    expect((await server.listVaults(a.session)).length).toBeGreaterThan(0);
    expect(await server.listVaults(b.session)).toEqual([]);
  });

  it("links, persists, renames and unlinks", async () => {
    const { server, events, saved } = await linkedDemo();
    expect(server.link()).toMatchObject({ host: "sync.example", user: "demo", vaultId: "v-notes", deviceName: "Laptop" });
    expect(saved()).toEqual(server.link());
    expect(events).toContainEqual({ type: "linked" });
    await server.renameDevice("Studio");
    expect(server.link()?.deviceName).toBe("Studio");
    await server.unlink();
    expect(server.link()).toBeNull();
    expect(saved()).toBeNull();
    expect(events).toContainEqual({ type: "unlinked" });
  });

  it("restores the link from the store", () => {
    const link: LinkInfo = { server: "https://s", host: "s", user: "demo", vaultId: "v", vaultName: "V", deviceName: "D" };
    const server = new FakeServer({
      isMobile: false,
      clock: () => 0,
      delay: () => Promise.resolve(),
      random: () => 0,
      localFileCount: () => 0,
      pluginVersion: "0.0.0",
      platform: "macOS",
      store: { load: () => link, save: () => undefined },
      autoRun: false,
    });
    expect(server.link()).toEqual(link);
  });
});

describe("pairing", () => {
  it("full flow on the same instance: offer, claim, request, approve", async () => {
    const { server, events } = await linkedDemo();
    const offer = await server.startPairing();
    expect(offer.link.startsWith("obsidian://kamino?server=")).toBe(true);
    const token = new URL(offer.link).searchParams.get("token")!;
    const claim = await server.claim({ server: "https://sync.example", token }, "iPhone");
    if (!claim.ok) throw new Error("claim");
    expect(claim.code).toHaveLength(4);
    expect([...claim.code].every((c) => VERIFICATION_ALPHABET.includes(c))).toBe(true);
    expect(server.pairingRequests()).toHaveLength(1);
    expect(events.some((e) => e.type === "pairing_request")).toBe(true);
    expect(await server.claimStatus(claim.claimId)).toBe("pending");
    await server.approve(offer.pairingId);
    expect(await server.claimStatus(claim.claimId)).toBe("approved");
    expect(server.pairingRequests()).toEqual([]);
    expect(events).toContainEqual({ type: "pairing_closed", pairingId: offer.pairingId });
  });

  it("deny closes the request and the claim", async () => {
    const { server } = await linkedDemo();
    const offer = await server.startPairing();
    const token = new URL(offer.link).searchParams.get("token")!;
    const claim = await server.claim({ server: "https://sync.example", token }, "iPhone");
    if (!claim.ok) throw new Error("claim");
    await server.deny(offer.pairingId);
    expect(await server.claimStatus(claim.claimId)).toBe("denied");
  });

  it("a second claim is refused and the origin is warned", async () => {
    const { server, events } = await linkedDemo();
    const offer = await server.startPairing();
    const token = new URL(offer.link).searchParams.get("token")!;
    await server.claim({ server: "https://sync.example", token }, "iPhone");
    expect(await server.claim({ server: "https://sync.example", token }, "Other")).toEqual({
      ok: false,
      reason: "already_claimed",
    });
    expect(events).toContainEqual({ type: "pairing_reused", pairingId: offer.pairingId });
  });

  it("offers and claims expire after 10 minutes", async () => {
    const { server, tick } = await linkedDemo();
    const offer = await server.startPairing();
    const token = new URL(offer.link).searchParams.get("token")!;
    const claim = await server.claim({ server: "https://sync.example", token }, "iPhone");
    if (!claim.ok) throw new Error("claim");
    tick(10 * MIN);
    expect(server.pairingRequests()).toEqual([]);
    expect(await server.claimStatus(claim.claimId)).toBe("expired");
  });

  it("special tokens simulate remote errors", async () => {
    const { server } = make();
    expect(await server.claim({ server: "https://s", token: "expired" }, "X")).toEqual({ ok: false, reason: "expired" });
    expect(await server.claim({ server: "https://s", token: "used" }, "X")).toEqual({ ok: false, reason: "already_claimed" });
    expect(await server.claim({ server: "https://s", token: "bad" }, "X")).toEqual({ ok: false, reason: "invalid" });
  });

  it("a remote claim is answered by the dev simulation and approval links the device", async () => {
    const { server, events } = make();
    const claim = await server.claim({ server: "https://sync.example", token: "remote" }, "iPhone");
    if (!claim.ok) throw new Error("claim");
    expect(claim.host).toBe("sync.example");
    server.simulateClaimAnswer("approved");
    expect(await server.claimStatus(claim.claimId)).toBe("approved");
    expect(server.link()).toMatchObject({ host: "sync.example", deviceName: "iPhone" });
    expect(events).toContainEqual({ type: "linked" });
  });

  it("simulateIncomingClaim creates a request for an open offer", async () => {
    const { server } = await linkedDemo();
    await server.startPairing();
    server.simulateIncomingClaim("Pixel", "Android");
    expect(server.pairingRequests()[0]).toMatchObject({ deviceName: "Pixel", platform: "Android" });
  });

  it("cancelPairing closes the offer", async () => {
    const { server, events } = await linkedDemo();
    const offer = await server.startPairing();
    await server.cancelPairing(offer.pairingId);
    expect(events).toContainEqual({ type: "pairing_closed", pairingId: offer.pairingId });
  });
});

describe("initial transfer", () => {
  it("upload of the local files: advance, pause, resume, done", () => {
    const { server } = make();
    const listener = vi.fn();
    server.transfer.onChange(listener);
    expect(server.transfer.progress()).toBeNull();
    server.transfer.start("upload");
    expect(server.transfer.progress()).toMatchObject({
      direction: "upload",
      phase: "running",
      files: { done: 0, total: 12 },
    });
    server.advance(5);
    expect(server.transfer.progress()?.files.done).toBe(5);
    server.transfer.pause();
    expect(server.transfer.progress()?.phase).toBe("paused");
    server.advance(1);
    expect(server.transfer.progress()?.files.done).toBe(5);
    server.transfer.resume();
    server.advance(100);
    expect(server.transfer.progress()).toMatchObject({ phase: "done", files: { done: 12, total: 12 } });
    expect(listener).toHaveBeenCalled();
  });

  it("interruption, failure and retry", () => {
    const { server } = make();
    server.transfer.start("download");
    server.interruptTransfer();
    expect(server.transfer.progress()?.phase).toBe("interrupted");
    server.failTransfer();
    expect(server.transfer.progress()?.phase).toBe("failed");
    server.transfer.retry();
    expect(server.transfer.progress()?.phase).toBe("running");
  });

  it("unlink clears the transfer", async () => {
    const { server } = await linkedDemo();
    server.transfer.start("upload");
    await server.unlink();
    expect(server.transfer.progress()).toBeNull();
  });
});
```

Run: `pnpm --filter @kamino/plugin test -- fake-server` → FAIL.

- [ ] **Step 3: `FakeServer`**

`apps/plugin/src/connection/fake-server.ts`:

```ts
import { PROTOCOL_ACTION } from "@kamino/brand";
import { buildPairingLink, type PairingLink } from "./link.js";
import type {
  ClaimResult,
  ClaimStatus,
  ConnectionEvent,
  ConnectionService,
  InitialTransfer,
  LinkInfo,
  LoginResult,
  PairingOffer,
  PairingRequest,
  ServerCheck,
  Session,
  TransferProgress,
  VaultSummary,
} from "./types.js";

/** 4-character verification codes without ambiguous characters (no 0/O, 1/I/L, 2/Z, 5/S, 8/B). */
export const VERIFICATION_ALPHABET = "ACDEFGHJKMNPQRTUVWXY3479";
const PAIRING_TTL = 10 * 60_000;
const SESSION_TTL = 5 * 60_000;
const BYTES_PER_FILE = 24_000;
const DOWNLOAD_FILES = 128;

export interface LinkStore {
  load(): LinkInfo | null;
  save(link: LinkInfo | null): void;
}

export interface FakeServerOptions {
  isMobile: boolean;
  clock: () => number;
  delay: (ms: number) => Promise<void>;
  random: () => number;
  localFileCount: () => number;
  pluginVersion: string;
  platform: string;
  store: LinkStore;
  /** false in tests: the transfer advances only through advance(). */
  autoRun: boolean;
}

interface Offer {
  pairingId: string;
  token: string;
  expiresAt: number;
  claimId: string | null;
  open: boolean;
}

interface Claim {
  claimId: string;
  server: string;
  deviceName: string;
  status: Exclude<ClaimStatus, "expired">;
  expiresAt: number;
  pairingId: string | null;
}

const DEMO_VAULTS: VaultSummary[] = [
  { id: "v-notes", name: "Note", fileCount: 128, deviceCount: 2 },
  { id: "v-work", name: "Lavoro", fileCount: 512, deviceCount: 1 },
];

/**
 * In-memory stand-in for the server (until M1/M2). Test credentials: demo/demo,
 * demo2fa/demo + TOTP 123456, locked. Hosts containing "unreachable"/"old" simulate errors.
 */
export class FakeServer implements ConnectionService {
  readonly transfer: InitialTransfer;
  private current: LinkInfo | null;
  private readonly listeners = new Set<(e: ConnectionEvent) => void>();
  private readonly transferListeners = new Set<() => void>();
  private offers: Offer[] = [];
  private claims: Claim[] = [];
  private requests: PairingRequest[] = [];
  private createdVaults: VaultSummary[] = [];
  private seq = 0;
  private progressState: TransferProgress | null = null;
  private running = false;

  constructor(private readonly o: FakeServerOptions) {
    this.current = o.store.load();
    // Separate object: InitialTransfer.onChange and ConnectionService.onChange have different signatures.
    this.transfer = {
      start: (direction) => this.startTransfer(direction),
      progress: () => (this.progressState ? structuredClone(this.progressState) : null),
      pause: () => this.setPhase("paused"),
      resume: () => {
        this.setPhase("running");
        this.run();
      },
      retry: () => {
        this.setPhase("running");
        this.run();
      },
      onChange: (cb) => {
        this.transferListeners.add(cb);
        return () => {
          this.transferListeners.delete(cb);
        };
      },
    };
  }

  link(): LinkInfo | null {
    return this.current;
  }

  async checkServer(url: string): Promise<ServerCheck> {
    await this.o.delay(300);
    let u: URL;
    try {
      u = new URL(url.trim());
    } catch {
      return { ok: false, reason: "invalid_url" };
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "invalid_url" };
    if (u.host.includes("unreachable")) return { ok: false, reason: "unreachable" };
    if (u.host.includes("old")) return { ok: false, reason: "incompatible" };
    const insecure = u.protocol === "http:";
    if (insecure && this.o.isMobile) return { ok: false, reason: "insecure_on_mobile" };
    return { ok: true, host: u.host, insecure };
  }

  async login(server: string, user: string, password: string, totp?: string): Promise<LoginResult> {
    await this.o.delay(300);
    if (user === "locked") return { ok: false, reason: "locked" };
    if (!["demo", "demo2fa"].includes(user) || password !== "demo") return { ok: false, reason: "bad_credentials" };
    if (user === "demo2fa") {
      if (totp === undefined || totp === "") return { ok: false, reason: "totp_required" };
      if (totp !== "123456") return { ok: false, reason: "bad_totp" };
    }
    return { ok: true, session: { server, user, expiresAt: this.o.clock() + SESSION_TTL } };
  }

  async listVaults(session: Session): Promise<VaultSummary[]> {
    await this.o.delay(200);
    return session.user === "demo" ? [...DEMO_VAULTS, ...this.createdVaults] : [...this.createdVaults];
  }

  async createVault(session: Session, name: string): Promise<VaultSummary> {
    void session;
    await this.o.delay(200);
    const vault = { id: `v-new-${++this.seq}`, name, fileCount: 0, deviceCount: 0 };
    this.createdVaults.push(vault);
    return vault;
  }

  async linkDevice(session: Session, vaultId: string, deviceName: string): Promise<LinkInfo> {
    await this.o.delay(200);
    const vault = [...DEMO_VAULTS, ...this.createdVaults].find((v) => v.id === vaultId);
    this.setLink({
      server: session.server,
      host: new URL(session.server).host,
      user: session.user,
      vaultId,
      vaultName: vault?.name ?? vaultId,
      deviceName,
    });
    return this.current!;
  }

  async renameDevice(name: string): Promise<void> {
    await this.o.delay(100);
    if (this.current) {
      this.current = { ...this.current, deviceName: name };
      this.o.store.save(this.current);
    }
  }

  async unlink(): Promise<void> {
    await this.o.delay(100);
    this.progressState = null;
    this.running = false;
    this.current = null;
    this.o.store.save(null);
    this.emit({ type: "unlinked" });
    this.emitTransfer();
  }

  async startPairing(): Promise<PairingOffer> {
    await this.o.delay(100);
    const pairingId = `p-${++this.seq}`;
    const token = `t-${this.seq}-${Math.floor(this.o.random() * 1e9)}`;
    const expiresAt = this.o.clock() + PAIRING_TTL;
    this.offers.push({ pairingId, token, expiresAt, claimId: null, open: true });
    const server = this.current?.server ?? "https://sync.example";
    return { pairingId, link: buildPairingLink(PROTOCOL_ACTION, { server, token }), expiresAt };
  }

  pairingRequests(): PairingRequest[] {
    const now = this.o.clock();
    return this.requests.filter((r) => r.expiresAt > now);
  }

  async approve(pairingId: string): Promise<void> {
    await this.answer(pairingId, "approved");
  }

  async deny(pairingId: string): Promise<void> {
    await this.answer(pairingId, "denied");
  }

  async cancelPairing(pairingId: string): Promise<void> {
    await this.o.delay(50);
    this.closeOffer(pairingId);
  }

  async claim(link: PairingLink, deviceName: string): Promise<ClaimResult> {
    await this.o.delay(300);
    const now = this.o.clock();
    const host = new URL(link.server).host;
    if (link.token === "expired") return { ok: false, reason: "expired" };
    if (link.token === "used") return { ok: false, reason: "already_claimed" };
    if (link.token === "bad") return { ok: false, reason: "invalid" };
    const offer = this.offers.find((x) => x.token === link.token);
    if (offer) {
      if (offer.expiresAt <= now || !offer.open) return { ok: false, reason: "expired" };
      if (offer.claimId) {
        this.emit({ type: "pairing_reused", pairingId: offer.pairingId });
        return { ok: false, reason: "already_claimed" };
      }
    }
    const claimId = `c-${++this.seq}`;
    const code = this.code();
    const expiresAt = offer?.expiresAt ?? now + PAIRING_TTL;
    this.claims.push({ claimId, server: link.server, deviceName, status: "pending", expiresAt, pairingId: offer?.pairingId ?? null });
    if (offer) {
      offer.claimId = claimId;
      const request: PairingRequest = {
        pairingId: offer.pairingId,
        deviceName,
        platform: this.o.platform,
        pluginVersion: this.o.pluginVersion,
        code,
        at: now,
        expiresAt,
      };
      this.requests.push(request);
      this.emit({ type: "pairing_request", request });
    }
    return { ok: true, claimId, code, expiresAt, host };
  }

  async claimStatus(claimId: string): Promise<ClaimStatus> {
    await this.o.delay(50);
    const claim = this.claims.find((c) => c.claimId === claimId);
    if (!claim) return "expired";
    if (claim.status === "pending" && claim.expiresAt <= this.o.clock()) return "expired";
    return claim.status;
  }

  async cancelClaim(claimId: string): Promise<void> {
    await this.o.delay(50);
    this.claims = this.claims.filter((c) => c.claimId !== claimId);
  }

  onChange(cb: (event: ConnectionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  // ---- Dev / test simulation -------------------------------------------------------------

  /** A new device claims the most recent open offer (creates one if none). */
  simulateIncomingClaim(deviceName = "iPhone", platform = "iOS"): void {
    const now = this.o.clock();
    let offer = [...this.offers].reverse().find((x) => x.open && !x.claimId && x.expiresAt > now);
    if (!offer) {
      offer = { pairingId: `p-${++this.seq}`, token: `t-${this.seq}`, expiresAt: now + PAIRING_TTL, claimId: null, open: true };
      this.offers.push(offer);
    }
    offer.claimId = `c-${++this.seq}`;
    const request: PairingRequest = {
      pairingId: offer.pairingId,
      deviceName,
      platform,
      pluginVersion: this.o.pluginVersion,
      code: this.code(),
      at: now,
      expiresAt: offer.expiresAt,
    };
    this.requests.push(request);
    this.emit({ type: "pairing_request", request });
  }

  /** The (remote) origin answers the most recent pending claim of this device. */
  simulateClaimAnswer(answer: "approved" | "denied"): void {
    const claim = [...this.claims].reverse().find((c) => c.status === "pending");
    if (!claim) return;
    claim.status = answer;
    if (answer === "approved") this.linkFromClaim(claim);
  }

  simulateDeviceJoined(deviceName: string): void {
    this.emit({ type: "device_joined", deviceName });
  }

  interruptTransfer(): void {
    this.setPhase("interrupted");
    if (this.o.autoRun) {
      void this.o.delay(2000).then(() => {
        if (this.progressState?.phase === "interrupted") this.transfer.resume();
      });
    }
  }

  failTransfer(): void {
    this.setPhase("failed");
  }

  /** Advances the running transfer by some files (used by run() and by tests). */
  advance(files: number): void {
    const p = this.progressState;
    if (!p || p.phase !== "running") return;
    p.files.done = Math.min(p.files.total, p.files.done + files);
    p.bytes.done = p.files.done * BYTES_PER_FILE;
    if (p.files.done >= p.files.total) p.phase = "done";
    this.emitTransfer();
  }

  // ---- internals --------------------------------------------------------------------------

  private async answer(pairingId: string, status: "approved" | "denied"): Promise<void> {
    await this.o.delay(100);
    const offer = this.offers.find((x) => x.pairingId === pairingId);
    const claim = this.claims.find((c) => c.claimId === offer?.claimId);
    if (claim && claim.status === "pending") {
      claim.status = status;
      // Same instance on both sides (dev): the approved device is this one only if not linked yet.
      if (status === "approved" && !this.current) this.linkFromClaim(claim);
    }
    this.closeOffer(pairingId);
  }

  private closeOffer(pairingId: string): void {
    const offer = this.offers.find((x) => x.pairingId === pairingId);
    if (offer) offer.open = false;
    this.requests = this.requests.filter((r) => r.pairingId !== pairingId);
    this.emit({ type: "pairing_closed", pairingId });
  }

  private linkFromClaim(claim: Claim): void {
    this.setLink({
      server: claim.server,
      host: new URL(claim.server).host,
      user: "demo",
      vaultId: "v-notes",
      vaultName: "Note",
      deviceName: claim.deviceName,
    });
  }

  private setLink(link: LinkInfo): void {
    this.current = link;
    this.o.store.save(link);
    this.emit({ type: "linked" });
  }

  private code(): string {
    let out = "";
    for (let i = 0; i < 4; i++) {
      out += VERIFICATION_ALPHABET[Math.floor(this.o.random() * VERIFICATION_ALPHABET.length) % VERIFICATION_ALPHABET.length];
    }
    return out;
  }

  private startTransfer(direction: "upload" | "download"): void {
    const total = direction === "upload" ? this.o.localFileCount() : DOWNLOAD_FILES;
    this.progressState = {
      direction,
      phase: total === 0 ? "done" : "running",
      files: { done: 0, total },
      bytes: { done: 0, total: total * BYTES_PER_FILE },
    };
    this.emitTransfer();
    this.run();
  }

  private setPhase(phase: TransferProgress["phase"]): void {
    if (!this.progressState || this.progressState.phase === "done") return;
    this.progressState.phase = phase;
    this.emitTransfer();
  }

  private run(): void {
    if (!this.o.autoRun || this.running) return;
    this.running = true;
    const step = async () => {
      while (this.progressState?.phase === "running") {
        await this.o.delay(150);
        this.advance(1);
      }
      this.running = false;
    };
    void step();
  }

  private emit(e: ConnectionEvent): void {
    for (const cb of [...this.listeners]) cb(e);
  }

  private emitTransfer(): void {
    for (const cb of [...this.transferListeners]) cb();
  }
}
```

Run: `pnpm --filter @kamino/plugin test -- fake-server` → PASS.

- [ ] **Step 4: Verifica e commit**

Run: `pnpm --filter @kamino/plugin typecheck && pnpm --filter @kamino/plugin lint`

```bash
git add apps/plugin
git commit -m "feat(plugin): add connection service interfaces and fake server"
```

---

### Task 4: Modello e salvataggio delle impostazioni

**Files:**
- Create: `apps/plugin/src/settings/model.ts`, `apps/plugin/src/settings/store.ts`
- Test: `apps/plugin/src/settings/model.test.ts`, `apps/plugin/src/settings/store.test.ts`

**Interfaces:**
- Produces: `PluginSettings`, `ConfigCategory`, `CONFIG_CATEGORIES: readonly ConfigCategory[]`, `LIMITS`, `defaultSettings(isMobile: boolean): PluginSettings`, `normalizeSettings(raw: unknown, isMobile: boolean): PluginSettings`, `validateGlob(pattern: string): boolean`; `class SettingsStore { constructor(io: DataIO, isMobile: boolean); load(): Promise<void>; get(): PluginSettings; update(fn: (s: PluginSettings) => PluginSettings): Promise<void>; linkStore: LinkStore; onChange(cb): () => void }` con `interface DataIO { loadData(): Promise<unknown>; saveData(data: unknown): Promise<void> }`.

- [ ] **Step 1: Test del modello (falliscono)**

`apps/plugin/src/settings/model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { defaultSettings, normalizeSettings, validateGlob } from "./model.js";

describe("defaultSettings", () => {
  it("live mode, Wi-Fi only on mobile", () => {
    expect(defaultSettings(false)).toEqual({
      sync: { mode: "live", liveDebounceSec: 5, periodicMinutes: 15 },
      largeFiles: { wifiOnly: false, thresholdMb: 10 },
      exclusions: [],
      configDir: {
        useVaultDefault: true,
        categories: { core: false, appearance: false, hotkeys: false, enabledPlugins: false, installedPlugins: false },
      },
    });
    expect(defaultSettings(true).largeFiles.wifiOnly).toBe(true);
  });
});

describe("normalizeSettings", () => {
  it.each([undefined, null, "garbage", 42, [], { sync: "x" }])("%o -> defaults", (raw) => {
    expect(normalizeSettings(raw, false)).toEqual(defaultSettings(false));
  });

  it("keeps valid values and clamps out-of-range ones", () => {
    const s = normalizeSettings(
      {
        sync: { mode: "periodic", liveDebounceSec: 99, periodicMinutes: 0 },
        largeFiles: { wifiOnly: true, thresholdMb: -3 },
        exclusions: ["Archivio/**", 7, "  ", "[bad"],
        configDir: { useVaultDefault: false, categories: { core: true, hotkeys: "yes" } },
      },
      false,
    );
    expect(s.sync).toEqual({ mode: "periodic", liveDebounceSec: 30, periodicMinutes: 1 });
    expect(s.largeFiles).toEqual({ wifiOnly: true, thresholdMb: 1 });
    expect(s.exclusions).toEqual(["Archivio/**"]);
    expect(s.configDir.useVaultDefault).toBe(false);
    expect(s.configDir.categories).toMatchObject({ core: true, hotkeys: false });
  });

  it("rejects unknown modes", () => {
    expect(normalizeSettings({ sync: { mode: "turbo" } }, false).sync.mode).toBe("live");
  });
});

describe("validateGlob", () => {
  it.each(["*.md", "Archivio/**", "**/tmp/**", "Foto/*.{jpg,png}", "Note [old]/*", "a?.md"])("%s is valid", (p) => {
    expect(validateGlob(p)).toBe(true);
  });
  it.each(["", "   ", "[abc", "{a,b", "a]", "x**", "**y/z", "a/***/b"])("%s is invalid", (p) => {
    expect(validateGlob(p)).toBe(false);
  });
});
```

- [ ] **Step 2: `model.ts`**

`apps/plugin/src/settings/model.ts`:

```ts
export type SyncMode = "live" | "periodic" | "manual";
export type ConfigCategory = "core" | "appearance" | "hotkeys" | "enabledPlugins" | "installedPlugins";
export const CONFIG_CATEGORIES: readonly ConfigCategory[] = [
  "core",
  "appearance",
  "hotkeys",
  "enabledPlugins",
  "installedPlugins",
];

export interface PluginSettings {
  sync: { mode: SyncMode; liveDebounceSec: number; periodicMinutes: number };
  largeFiles: { wifiOnly: boolean; thresholdMb: number };
  exclusions: string[];
  configDir: { useVaultDefault: boolean; categories: Record<ConfigCategory, boolean> };
}

export const LIMITS = {
  liveDebounceSec: { min: 2, max: 30 },
  periodicMinutes: { min: 1, max: 1440 },
  thresholdMb: { min: 1, max: 10_000 },
} as const;

export function defaultSettings(isMobile: boolean): PluginSettings {
  return {
    sync: { mode: "live", liveDebounceSec: 5, periodicMinutes: 15 },
    largeFiles: { wifiOnly: isMobile, thresholdMb: 10 },
    exclusions: [],
    configDir: {
      useVaultDefault: true,
      categories: { core: false, appearance: false, hotkeys: false, enabledPlugins: false, installedPlugins: false },
    },
  };
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function num(v: unknown, fallback: number, range: { min: number; max: number }): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(v)));
}

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

/** Fills defaults and fixes out-of-range values: an old or broken data.json never breaks loading. */
export function normalizeSettings(raw: unknown, isMobile: boolean): PluginSettings {
  const d = defaultSettings(isMobile);
  const r = obj(raw);
  const sync = obj(r["sync"]);
  const large = obj(r["largeFiles"]);
  const cfg = obj(r["configDir"]);
  const cats = obj(cfg["categories"]);
  const mode = sync["mode"];
  return {
    sync: {
      mode: mode === "live" || mode === "periodic" || mode === "manual" ? mode : d.sync.mode,
      liveDebounceSec: num(sync["liveDebounceSec"], d.sync.liveDebounceSec, LIMITS.liveDebounceSec),
      periodicMinutes: num(sync["periodicMinutes"], d.sync.periodicMinutes, LIMITS.periodicMinutes),
    },
    largeFiles: {
      wifiOnly: bool(large["wifiOnly"], d.largeFiles.wifiOnly),
      thresholdMb: num(large["thresholdMb"], d.largeFiles.thresholdMb, LIMITS.thresholdMb),
    },
    exclusions: Array.isArray(r["exclusions"])
      ? r["exclusions"].filter((x): x is string => typeof x === "string" && validateGlob(x)).map((x) => x.trim())
      : d.exclusions,
    configDir: {
      useVaultDefault: bool(cfg["useVaultDefault"], d.configDir.useVaultDefault),
      categories: Object.fromEntries(
        CONFIG_CATEGORIES.map((c) => [c, bool(cats[c], d.configDir.categories[c])]),
      ) as Record<ConfigCategory, boolean>,
    },
  };
}

/** Syntax check of an exclusion glob: not empty, balanced [] and {}, "**" only as a whole path segment. */
export function validateGlob(pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  const stack: string[] = [];
  for (const ch of p) {
    if (ch === "[" || ch === "{") {
      if (stack.at(-1) === "[") return false;
      stack.push(ch);
    } else if (ch === "]" || ch === "}") {
      if (stack.pop() !== (ch === "]" ? "[" : "{")) return false;
    }
  }
  if (stack.length > 0) return false;
  for (const m of p.matchAll(/\*{2,}/g)) {
    if (m[0].length > 2) return false;
    const before = p[m.index - 1];
    const after = p[m.index + 2];
    if ((before !== undefined && before !== "/") || (after !== undefined && after !== "/")) return false;
  }
  return true;
}
```

Run: `pnpm --filter @kamino/plugin test -- settings/model` → PASS.

- [ ] **Step 3: `SettingsStore` (test → implementazione)**

`apps/plugin/src/settings/store.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "./model.js";
import { SettingsStore } from "./store.js";

function io(initial: unknown = null) {
  let data: unknown = initial;
  return {
    loadData: () => Promise.resolve(structuredClone(data)),
    saveData: vi.fn((d: unknown) => {
      data = structuredClone(d);
      return Promise.resolve();
    }),
    data: () => data,
  };
}

describe("SettingsStore", () => {
  it("defaults when data.json is missing", async () => {
    const s = new SettingsStore(io(), false);
    await s.load();
    expect(s.get()).toEqual(defaultSettings(false));
    expect(s.linkStore.load()).toBeNull();
  });

  it("update normalizes, saves and notifies, keeping the link", async () => {
    const file = io({ link: { server: "https://s", host: "s", user: "u", vaultId: "v", vaultName: "V", deviceName: "D" } });
    const s = new SettingsStore(file, false);
    await s.load();
    const cb = vi.fn();
    s.onChange(cb);
    await s.update((x) => ({ ...x, sync: { ...x.sync, liveDebounceSec: 100 } }));
    expect(s.get().sync.liveDebounceSec).toBe(30);
    expect(cb).toHaveBeenCalled();
    expect(file.data()).toMatchObject({ settings: { sync: { liveDebounceSec: 30 } }, link: { vaultId: "v" } });
  });

  it("linkStore saves under its own key and survives a reload", async () => {
    const file = io();
    const s = new SettingsStore(file, false);
    await s.load();
    s.linkStore.save({ server: "https://s", host: "s", user: "u", vaultId: "v", vaultName: "V", deviceName: "D" });
    await Promise.resolve();
    const again = new SettingsStore(file, false);
    await again.load();
    expect(again.linkStore.load()?.vaultId).toBe("v");
  });

  it("a broken data.json falls back to defaults", async () => {
    const s = new SettingsStore(io("not an object"), true);
    await s.load();
    expect(s.get()).toEqual(defaultSettings(true));
  });
});
```

`apps/plugin/src/settings/store.ts`:

```ts
import type { LinkStore } from "../connection/fake-server.js";
import type { LinkInfo } from "../connection/types.js";
import { defaultSettings, normalizeSettings, type PluginSettings } from "./model.js";

export interface DataIO {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

function isLink(v: unknown): v is LinkInfo {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return ["server", "host", "user", "vaultId", "vaultName", "deviceName"].every((k) => typeof o[k] === "string");
}

/** Plugin settings and link data in data.json (plugin folder, always excluded from sync). */
export class SettingsStore {
  private settings: PluginSettings;
  private link: LinkInfo | null = null;
  private readonly listeners = new Set<() => void>();
  readonly linkStore: LinkStore;

  constructor(
    private readonly io: DataIO,
    private readonly isMobile: boolean,
  ) {
    this.settings = defaultSettings(isMobile);
    this.linkStore = {
      load: () => this.link,
      save: (link) => {
        this.link = link;
        void this.persist();
      },
    };
  }

  async load(): Promise<void> {
    let raw: unknown = null;
    try {
      raw = await this.io.loadData();
    } catch {
      raw = null;
    }
    const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    this.settings = normalizeSettings(r["settings"], this.isMobile);
    this.link = isLink(r["link"]) ? r["link"] : null;
  }

  get(): PluginSettings {
    return structuredClone(this.settings);
  }

  async update(fn: (s: PluginSettings) => PluginSettings): Promise<void> {
    this.settings = normalizeSettings(fn(this.get()), this.isMobile);
    for (const cb of [...this.listeners]) cb();
    await this.persist();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private persist(): Promise<void> {
    return this.io.saveData({ settings: this.settings, link: this.link });
  }
}
```

Run: `pnpm --filter @kamino/plugin test -- settings` → PASS. Typecheck, lint.

```bash
git add apps/plugin
git commit -m "feat(plugin): add settings model and store"
```

---

### Task 5: Mock, contesto, collegamento con lo stato, scheda di benvenuto

**Files:**
- Modify: `apps/plugin/src/__mocks__/obsidian.ts`, `apps/plugin/src/__mocks__/ui-context.ts`, `src/ui/context.ts`, `src/ui/workspace.ts`, `src/state/fake.ts`, `src/ui/StatusPanelView.ts`, `src/main.ts`, `src/i18n/{it,en}.json`, `src/styles.css`
- Create: `src/ui/WelcomeView.ts`
- Test: `src/ui/WelcomeView.test.ts`, aggiunte a `src/ui/StatusPanelView.test.ts`

**Interfaces:**
- Consumes: Task 1–4.
- Produces:
  - `UiContext` esteso con: `connection: ConnectionService`, `transfer: InitialTransfer`, `settings: SettingsStore`, `engineAvailable: boolean`, `isIos: boolean`, `platformLabel: string`, `vaultName: string`, `configDir: string`, `localFileCount(): number`, `openWelcome(): Promise<void>`, `openTransfer(): Promise<void>`, `openConnect(mode: "create" | "join"): void`, `openClaim(link: PairingLink): void`, `openAddDevice(request?: PairingRequest): void`, `confirm(opts: ConfirmOptions): Promise<boolean>`.
  - `interface ConfirmOptions { title: string; text: string; confirmText: string | null; cancelText: string; warning?: boolean }` (in `ConfirmModal.ts`, Task 8; fino ad allora il tipo vive in `context.ts`).
  - `WELCOME_VIEW`, `TRANSFER_VIEW`, `openWelcome(app)`, `openTransfer(app)` in `workspace.ts`.
  - `FakeSyncState.setLinked(linked: boolean)`, `FakeSyncState.setTransfer(p: TransferProgress | null)`.
  - `makeCtx(overrides?)` restituisce anche `server: FakeServer`, `store: SettingsStore`.

- [ ] **Step 1: Mock di Obsidian**

In `src/__mocks__/obsidian.ts`:

1. Componenti di `Setting` (prima di `class Setting`):

```ts
class BaseComponent {
  disabled = false;
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
}

export class TextComponent extends BaseComponent {
  inputEl: HTMLInputElement = document.createElement("input");
  constructor(container: HTMLElement) {
    super();
    this.inputEl.type = "text";
    container.append(this.inputEl);
  }
  getValue(): string {
    return this.inputEl.value;
  }
  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }
  setPlaceholder(p: string): this {
    this.inputEl.placeholder = p;
    return this;
  }
  onChange(cb: (value: string) => unknown): this {
    this.inputEl.addEventListener("input", () => cb(this.inputEl.value));
    return this;
  }
}

export class TextAreaComponent extends BaseComponent {
  inputEl: HTMLTextAreaElement = document.createElement("textarea");
  constructor(container: HTMLElement) {
    super();
    container.append(this.inputEl);
  }
  getValue(): string {
    return this.inputEl.value;
  }
  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }
  setPlaceholder(p: string): this {
    this.inputEl.placeholder = p;
    return this;
  }
  onChange(cb: (value: string) => unknown): this {
    this.inputEl.addEventListener("input", () => cb(this.inputEl.value));
    return this;
  }
}

export class ToggleComponent extends BaseComponent {
  toggleEl: HTMLInputElement = document.createElement("input");
  constructor(container: HTMLElement) {
    super();
    this.toggleEl.type = "checkbox";
    container.append(this.toggleEl);
  }
  getValue(): boolean {
    return this.toggleEl.checked;
  }
  setValue(on: boolean): this {
    this.toggleEl.checked = on;
    return this;
  }
  onChange(cb: (value: boolean) => unknown): this {
    this.toggleEl.addEventListener("change", () => cb(this.toggleEl.checked));
    return this;
  }
}

export class DropdownComponent extends BaseComponent {
  selectEl: HTMLSelectElement = document.createElement("select");
  constructor(container: HTMLElement) {
    super();
    container.append(this.selectEl);
  }
  addOption(value: string, display: string): this {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = display;
    this.selectEl.append(o);
    return this;
  }
  getValue(): string {
    return this.selectEl.value;
  }
  setValue(value: string): this {
    this.selectEl.value = value;
    return this;
  }
  onChange(cb: (value: string) => unknown): this {
    this.selectEl.addEventListener("change", () => cb(this.selectEl.value));
    return this;
  }
}

export class ButtonComponent extends BaseComponent {
  buttonEl: HTMLButtonElement = document.createElement("button");
  constructor(container: HTMLElement) {
    super();
    container.append(this.buttonEl);
  }
  setButtonText(text: string): this {
    this.buttonEl.textContent = text;
    return this;
  }
  setCta(): this {
    this.buttonEl.classList.add("mod-cta");
    return this;
  }
  setWarning(): this {
    this.buttonEl.classList.add("mod-warning");
    return this;
  }
  override setDisabled(disabled: boolean): this {
    this.buttonEl.disabled = disabled;
    return super.setDisabled(disabled);
  }
  onClick(cb: (evt: MouseEvent) => unknown): this {
    this.buttonEl.addEventListener("click", (e) => cb(e as MouseEvent));
    return this;
  }
}
```

2. Sostituire `class Setting` con:

```ts
export class Setting {
  settingEl = document.createElement("div");
  infoEl = document.createElement("div");
  nameEl = document.createElement("div");
  descEl = document.createElement("div");
  controlEl = document.createElement("div");
  constructor(containerEl: HTMLElement) {
    this.settingEl.className = "setting-item";
    this.nameEl.className = "setting-item-name";
    this.descEl.className = "setting-item-description";
    this.infoEl.append(this.nameEl, this.descEl);
    this.settingEl.append(this.infoEl, this.controlEl);
    containerEl.append(this.settingEl);
  }
  setName(name: string): this {
    this.nameEl.textContent = name;
    return this;
  }
  setDesc(desc: string | DocumentFragment): this {
    this.descEl.replaceChildren(desc);
    return this;
  }
  setHeading(): this {
    this.settingEl.classList.add("setting-item-heading");
    return this;
  }
  setClass(cls: string): this {
    this.settingEl.classList.add(cls);
    return this;
  }
  addText(cb: (c: TextComponent) => unknown): this {
    cb(new TextComponent(this.controlEl));
    return this;
  }
  addTextArea(cb: (c: TextAreaComponent) => unknown): this {
    cb(new TextAreaComponent(this.controlEl));
    return this;
  }
  addToggle(cb: (c: ToggleComponent) => unknown): this {
    cb(new ToggleComponent(this.controlEl));
    return this;
  }
  addDropdown(cb: (c: DropdownComponent) => unknown): this {
    cb(new DropdownComponent(this.controlEl));
    return this;
  }
  addButton(cb: (c: ButtonComponent) => unknown): this {
    cb(new ButtonComponent(this.controlEl));
    return this;
  }
}
```

3. `Notice`: `constructor(message: string, duration?: number)` con `noticeEl: HTMLElement = document.createElement("div");` e `void duration;`.
4. `Platform`: aggiungere `isIosApp: false`.
5. `Vault` e `App`:

```ts
export class Vault {
  configDir = ".obsidian";
  files: Array<{ path: string }> = [];
  getFiles(): Array<{ path: string }> {
    return this.files;
  }
  getName(): string {
    return "Prova";
  }
}
```

e in `App`: `vault: Vault = new Vault();`.
6. `Workspace`: `onLayoutReady(cb: () => unknown): void { cb(); }`.
7. `Plugin`: `data: unknown = null; loadData(): Promise<unknown> { return Promise.resolve(structuredClone(this.data)); } saveData(d: unknown): Promise<void> { this.data = structuredClone(d); return Promise.resolve(); }`.

Run: `pnpm --filter @kamino/plugin test` → i test esistenti restano verdi (aggiornare `test/settings.test.ts` solo se usa `Setting` in modo incompatibile).

- [ ] **Step 2: Contesto, navigazione, stato**

`src/ui/context.ts` (contenuto completo):

```ts
import type { Lang } from "@kamino/status";
import type { PairingLink } from "../connection/link.js";
import type { ConnectionService, InitialTransfer, PairingRequest } from "../connection/types.js";
import type { SettingsStore } from "../settings/store.js";
import type { ConflictActions, SyncStateSource } from "../state/types.js";

export interface ConfirmOptions {
  title: string;
  text: string;
  /** null = information only ("Close"). */
  confirmText: string | null;
  cancelText: string;
  warning?: boolean;
}

/** Everything the views need: data, services, environment and navigation. */
export interface UiContext {
  source: SyncStateSource;
  actions: ConflictActions;
  connection: ConnectionService;
  transfer: InitialTransfer;
  settings: SettingsStore;
  /** false until the sync engine exists (M1): behaviour settings are saved but not applied. */
  engineAvailable: boolean;
  lang: Lang;
  isMobile: boolean;
  isIos: boolean;
  platformLabel: string;
  vaultName: string;
  configDir: string;
  now: () => number;
  available: ReadonlySet<string> | null;
  localFileCount(): number;
  openStatusPanel(): Promise<void>;
  openConflict(id: string): Promise<void>;
  openBulkResolve(): void;
  openWelcome(): Promise<void>;
  openTransfer(): Promise<void>;
  openConnect(mode: "create" | "join"): void;
  openClaim(link: PairingLink): void;
  openAddDevice(request?: PairingRequest): void;
  confirm(opts: ConfirmOptions): Promise<boolean>;
}
```

`src/ui/workspace.ts`: aggiungere

```ts
export const WELCOME_VIEW = `${PRODUCT_SLUG}-welcome`;
export const TRANSFER_VIEW = `${PRODUCT_SLUG}-transfer`;

/** Opens (or reveals) a singleton view in the main area. */
async function openSingleton(app: App, type: string): Promise<void> {
  const existing = app.workspace.getLeavesOfType(type)[0];
  const leaf = existing ?? app.workspace.getLeaf("tab");
  if (!existing) await leaf.setViewState({ type, active: true });
  await app.workspace.revealLeaf(leaf);
}

export const openWelcome = (app: App): Promise<void> => openSingleton(app, WELCOME_VIEW);
export const openTransfer = (app: App): Promise<void> => openSingleton(app, TRANSFER_VIEW);
```

`src/state/fake.ts`: aggiungere

```ts
  /** Reflects the link state in the snapshot (not linked → "Not linked", never "safe"). */
  setLinked(linked: boolean): void {
    this.snap = { ...this.snap, linked };
    this.emit();
  }

  /** Reflects the initial transfer: pending files, syncing, then a confirmed sync when done. */
  setTransfer(p: TransferProgress | null): void {
    if (!p) return;
    const left = p.files.total - p.files.done;
    this.snap =
      p.phase === "done"
        ? { ...this.snap, queued: 0, oldestQueuedAt: null, syncing: false, lastConfirmedAt: this.clock() }
        : { ...this.snap, queued: left, oldestQueuedAt: this.snap.oldestQueuedAt ?? this.clock(), syncing: p.phase === "running" };
    this.emit();
  }
```

(import `type TransferProgress` da `../connection/types.js`.)

`src/__mocks__/ui-context.ts` (contenuto completo):

```ts
import { vi } from "vitest";
import { FakeServer } from "../connection/fake-server.js";
import { SettingsStore } from "../settings/store.js";
import { FakeSyncState } from "../state/fake.js";
import type { UiContext } from "../ui/context.js";
import { Plugin } from "./obsidian.js";

export const TEST_NOW = Date.UTC(2026, 10, 8, 10, 0);

/** UiContext over in-memory fakes, with spies for navigation. */
export function makeCtx(overrides: Partial<UiContext> = {}) {
  const plugin = new Plugin();
  const state = new FakeSyncState({ name: "Laptop", mode: "live", server: "sync.example" }, () => TEST_NOW);
  const store = new SettingsStore(plugin, overrides.isMobile ?? false);
  const server = new FakeServer({
    isMobile: overrides.isMobile ?? false,
    clock: () => TEST_NOW,
    delay: () => Promise.resolve(),
    random: () => 0.5,
    localFileCount: () => plugin.app.vault.getFiles().length,
    pluginVersion: "0.0.0",
    platform: "macOS",
    store: store.linkStore,
    autoRun: false,
  });
  const ctx: UiContext = {
    source: state,
    actions: state,
    connection: server,
    transfer: server.transfer,
    settings: store,
    engineAvailable: false,
    lang: "it",
    isMobile: false,
    isIos: false,
    platformLabel: "macOS",
    vaultName: "Prova",
    configDir: ".obsidian",
    now: () => TEST_NOW,
    available: null,
    localFileCount: () => plugin.app.vault.getFiles().length,
    openStatusPanel: vi.fn(() => Promise.resolve()),
    openConflict: vi.fn(() => Promise.resolve()),
    openBulkResolve: vi.fn(),
    openWelcome: vi.fn(() => Promise.resolve()),
    openTransfer: vi.fn(() => Promise.resolve()),
    openConnect: vi.fn(),
    openClaim: vi.fn(),
    openAddDevice: vi.fn(),
    confirm: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  };
  return { ctx, state, plugin, server, store };
}
```

- [ ] **Step 3: Testi**

Aggiungere a `it.json`:

```json
"welcome": {
  "viewTitle": "Collega questo vault",
  "title": "Benvenuto in {product}",
  "intro": "Collega questo vault a un server per sincronizzarlo tra i tuoi dispositivi. Nessun file viene sovrascritto senza chiedertelo.",
  "createTitle": "È il primo dispositivo",
  "createDesc": "Crea il vault sul server partendo da questi file.",
  "joinTitle": "Collega a un vault esistente",
  "joinDesc": "Accedi al server con nome utente e password.",
  "linkTitle": "Ho un QR o un link",
  "linkDesc": "Generalo da un dispositivo già collegato e aprilo qui.",
  "linkHowMobile": "Inquadra il QR con la fotocamera del telefono: si aprirà Obsidian e il collegamento partirà da solo.",
  "linkHowDesktop": "Inquadra il QR con la fotocamera di un telefono, oppure incolla qui il link.",
  "linkPaste": "Incolla il link",
  "linkGo": "Collega",
  "linkInvalid": "Questo non è un link di collegamento valido."
},
"panel2": {
  "connect": "Collega…",
  "requests": "Richieste di collegamento · {count}",
  "requestMeta": "{platform} · scade tra {left}"
},
"commands": {
  "connect": "Collega questo vault",
  "addDevice": "Aggiungi un dispositivo"
}
```

e a `en.json`:

```json
"welcome": {
  "viewTitle": "Link this vault",
  "title": "Welcome to {product}",
  "intro": "Link this vault to a server to sync it across your devices. No file is overwritten without asking you.",
  "createTitle": "This is the first device",
  "createDesc": "Create the vault on the server from these files.",
  "joinTitle": "Link to an existing vault",
  "joinDesc": "Sign in to the server with username and password.",
  "linkTitle": "I have a QR code or a link",
  "linkDesc": "Generate it on a device that is already linked and open it here.",
  "linkHowMobile": "Scan the QR code with the phone camera: Obsidian opens and linking starts by itself.",
  "linkHowDesktop": "Scan the QR code with a phone camera, or paste the link here.",
  "linkPaste": "Paste the link",
  "linkGo": "Link",
  "linkInvalid": "This is not a valid pairing link."
},
"panel2": {
  "connect": "Link…",
  "requests": "Pairing requests · {count}",
  "requestMeta": "{platform} · expires in {left}"
},
"commands": {
  "connect": "Link this vault",
  "addDevice": "Add a device"
}
```

- [ ] **Step 4: Test della scheda di benvenuto (falliscono)**

`src/ui/WelcomeView.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { WorkspaceLeaf } from "../__mocks__/obsidian.js";
import { makeCtx } from "../__mocks__/ui-context.js";
import type { UiContext } from "./context.js";
import { WelcomeView } from "./WelcomeView.js";
import { WELCOME_VIEW } from "./workspace.js";

async function open(over: Partial<UiContext> = {}) {
  const made = makeCtx(over);
  made.plugin.registerView(WELCOME_VIEW, (leaf) => new WelcomeView(leaf as never, made.ctx) as never);
  const leaf = new WorkspaceLeaf(made.plugin.app);
  await leaf.setViewState({ type: WELCOME_VIEW });
  const root = leaf.view!.contentEl;
  const button = (text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  return { ...made, leaf, root, button };
}

describe("WelcomeView", () => {
  it("shows the product name and the three choices", async () => {
    const { root } = await open();
    expect(root.querySelector("h2")?.textContent).toBe("Benvenuto in Kamino");
    expect([...root.querySelectorAll("button b")].map((b) => b.textContent)).toEqual([
      "È il primo dispositivo",
      "Collega a un vault esistente",
      "Ho un QR o un link",
    ]);
  });

  it("first two choices open the connect flow", async () => {
    const { ctx, button } = await open();
    button("È il primo dispositivo")!.click();
    expect(ctx.openConnect).toHaveBeenCalledWith("create");
    button("Collega a un vault esistente")!.click();
    expect(ctx.openConnect).toHaveBeenCalledWith("join");
  });

  it("desktop: paste a link to start the claim", async () => {
    const { ctx, root, button } = await open();
    button("Ho un QR o un link")!.click();
    const input = root.querySelector("input") as HTMLInputElement;
    input.value = "nonsense";
    button("Collega")!.click();
    expect(root.textContent).toContain("Questo non è un link di collegamento valido.");
    input.value = "obsidian://kamino?server=https%3A%2F%2Fsync.example&token=abc";
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Collega")!.click();
    expect(ctx.openClaim).toHaveBeenCalledWith({ server: "https://sync.example", token: "abc" });
  });

  it("mobile: instructions only, no paste field", async () => {
    const { root, button } = await open({ isMobile: true });
    button("Ho un QR o un link")!.click();
    expect(root.textContent).toContain("Inquadra il QR con la fotocamera del telefono");
    expect(root.querySelector("input")).toBeNull();
  });

  it("closes itself when the vault gets linked", async () => {
    const { server, leaf } = await open();
    const login = await server.login("https://sync.example", "demo", "demo");
    if (!login.ok) throw new Error("login");
    await server.linkDevice(login.session, "v-notes", "Laptop");
    expect(leaf.view).toBeNull();
  });
});
```

Run → FAIL.

- [ ] **Step 5: `WelcomeView`**

`src/ui/WelcomeView.ts`:

```ts
import { PRODUCT_NAME, PROTOCOL_ACTION } from "@kamino/brand";
import { ItemView, type WorkspaceLeaf } from "obsidian";
import { parsePairingUrl } from "../connection/link.js";
import { fmt } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import type { UiContext } from "./context.js";
import { h } from "./dom.js";
import { CLASS_PREFIX } from "./status-classes.js";
import { WELCOME_VIEW } from "./workspace.js";

const P = `${CLASS_PREFIX}-welcome`;

/** First run in a vault that is not linked: three ways in (spec §3.1). */
export class WelcomeView extends ItemView {
  private showLinkHelp = false;
  private linkError = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly ctx: UiContext,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return WELCOME_VIEW;
  }
  override getDisplayText(): string {
    return t(this.ctx.lang).welcome.viewTitle;
  }
  override getIcon(): string {
    return "link";
  }

  protected override onOpen(): Promise<void> {
    this.unsubscribe = this.ctx.connection.onChange((e) => {
      if (e.type === "linked") this.leaf.detach();
    });
    this.render();
    return Promise.resolve();
  }

  protected override onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    return Promise.resolve();
  }

  private render(): void {
    const m = t(this.ctx.lang).welcome;
    const root = this.contentEl;
    root.replaceChildren();
    root.classList.add(P);
    h(root, "h2", { text: fmt(m.title, { product: PRODUCT_NAME }) });
    h(root, "p", { cls: `${P}__muted`, text: m.intro });

    const choice = (title: string, desc: string, onClick: () => void) => {
      const b = h(root, "button", { cls: `${P}__choice` });
      h(b, "b", { text: title });
      h(b, "span", { cls: `${P}__muted`, text: desc });
      b.addEventListener("click", onClick);
    };
    choice(m.createTitle, m.createDesc, () => this.ctx.openConnect("create"));
    choice(m.joinTitle, m.joinDesc, () => this.ctx.openConnect("join"));
    choice(m.linkTitle, m.linkDesc, () => {
      this.showLinkHelp = true;
      this.render();
    });

    if (!this.showLinkHelp) return;
    const help = h(root, "section", { cls: `${P}__help` });
    if (this.ctx.isMobile) {
      h(help, "p", { text: m.linkHowMobile });
      return;
    }
    h(help, "p", { text: m.linkHowDesktop });
    const input = h(help, "input", { attrs: { type: "text", "aria-label": m.linkPaste, placeholder: m.linkPaste } });
    h(help, "button", { cls: "mod-cta", text: m.linkGo }).addEventListener("click", () => {
      const parsed = parsePairingUrl(input.value, PROTOCOL_ACTION);
      if (!parsed.ok) {
        this.linkError = true;
        error.textContent = m.linkInvalid;
        return;
      }
      this.linkError = false;
      error.textContent = "";
      this.ctx.openClaim(parsed.link);
    });
    const error = h(help, "p", { cls: `${P}__error`, attrs: { role: "alert" }, text: this.linkError ? m.linkInvalid : "" });
  }
}
```

Run: `pnpm --filter @kamino/plugin test -- WelcomeView` → PASS.

- [ ] **Step 6: Pannello: "Collega…" e richieste di collegamento**

In `src/ui/StatusPanelView.ts`:
- `onOpen`: oltre a `source.onChange`, sottoscrivere `ctx.connection.onChange(() => this.render())` (tenere entrambe le funzioni di disiscrizione e chiamarle in `onClose`).
- In `render()`, all'inizio (prima del riepilogo), le richieste:

```ts
    const requests = ctx.connection.pairingRequests();
    if (requests.length > 0) {
      const m2 = t(ctx.lang).panel2;
      const sec = this.section(root, fmt(m2.requests, { count: requests.length }));
      for (const r of requests) {
        const meta = fmt(m2.requestMeta, { platform: r.platform, left: formatAge(Math.max(0, r.expiresAt - now), ctx.lang) });
        this.row(sec.list, r.deviceName, meta).addEventListener("click", () => ctx.openAddDevice(r));
      }
    }
```

- Il bottone del riepilogo: se `snapshot.linked === false` → testo `t(ctx.lang).panel2.connect`, azione `void ctx.openWelcome()`; altrimenti "Sincronizza ora" come oggi.

Aggiungere a `StatusPanelView.test.ts`:

```ts
  it("not linked: 'Collega…' opens the welcome view", async () => {
    const { ctx, state, plugin } = makeCtx();
    state.setLinked(false);
    const { root } = await open(ctx, plugin);
    expect(root.textContent).toContain("Non collegato");
    buttons(root).find((b) => b.textContent === "Collega…")!.click();
    expect(ctx.openWelcome).toHaveBeenCalled();
  });

  it("pairing requests appear on top and open the approval", async () => {
    const { ctx, server, plugin } = makeCtx();
    const login = await server.login("https://sync.example", "demo", "demo");
    if (!login.ok) throw new Error("login");
    await server.linkDevice(login.session, "v-notes", "Laptop");
    await server.startPairing();
    const { root } = await open(ctx, plugin);
    server.simulateIncomingClaim("Pixel", "Android");
    expect(headings(root)[0]).toBe("Richieste di collegamento · 1");
    buttons(root).find((b) => b.textContent?.includes("Pixel"))!.click();
    expect(ctx.openAddDevice).toHaveBeenCalledWith(expect.objectContaining({ deviceName: "Pixel" }));
  });
```

(la funzione `open` del file usa `makeCtx()`: adattarla per accettare il `ctx` già costruito, come già fa.)

- [ ] **Step 7: `main.ts`**

`src/main.ts`, contenuto completo (`onload` diventa `async`; `openConnect`/`openClaim`/`openAddDevice`/`confirm` sono no-op finché i Task 6–8 non li collegano; la scheda impostazioni riceve il contesto nel Task 8):

```ts
import { PROTOCOL_ACTION } from "@kamino/brand";
import { DEFAULT_THRESHOLDS, describeStatus } from "@kamino/status";
import { getIconIds, Platform, Plugin } from "obsidian";
import { APP_VERSION } from "./build-info.js";
import { FakeServer } from "./connection/fake-server.js";
import { registerDevCommands } from "./dev/commands.js";
import { detectLanguage, t } from "./i18n/index.js";
import { SettingsStore } from "./settings/store.js";
import { SettingsTab } from "./settings/SettingsTab.js";
import { FakeSyncState } from "./state/fake.js";
import { BulkResolveModal } from "./ui/BulkResolveModal.js";
import { ConflictView } from "./ui/ConflictView.js";
import type { UiContext } from "./ui/context.js";
import { StatusIndicator } from "./ui/StatusIndicator.js";
import { StatusPanelView } from "./ui/StatusPanelView.js";
import { WelcomeView } from "./ui/WelcomeView.js";
import {
  CONFLICT_VIEW,
  openConflict,
  openStatusPanel,
  openTransfer,
  openWelcome,
  STATUS_VIEW,
  WELCOME_VIEW,
} from "./ui/workspace.js";

function platformLabel(): string {
  if (Platform.isIosApp) return "iPhone";
  if (Platform.isAndroidApp) return "Android";
  if (Platform.isMacOS) return "macOS";
  if (Platform.isWin) return "Windows";
  if (Platform.isLinux) return "Linux";
  return "Obsidian";
}

export default class SyncPlugin extends Plugin {
  override async onload(): Promise<void> {
    const lang = detectLanguage();
    const m = t(lang);
    const now = () => Date.now();
    const isMobile = Platform.isMobile;

    const settings = new SettingsStore(this, isMobile);
    await settings.load();
    const server = new FakeServer({
      isMobile,
      clock: now,
      delay: (ms) => new Promise((r) => window.setTimeout(r, ms)),
      random: Math.random,
      localFileCount: () => this.app.vault.getFiles().length,
      pluginVersion: APP_VERSION,
      platform: platformLabel(),
      store: settings.linkStore,
      autoRun: true,
    });
    const state = new FakeSyncState(
      { name: server.link()?.deviceName ?? m.panel.notLinked, mode: "live", server: server.link()?.host ?? m.panel.noServer },
      now,
    );
    state.setLinked(server.link() !== null);

    const ctx: UiContext = {
      source: state,
      actions: state,
      connection: server,
      transfer: server.transfer,
      settings,
      engineAvailable: false,
      lang,
      isMobile,
      isIos: Platform.isIosApp,
      platformLabel: platformLabel(),
      vaultName: this.app.vault.getName(),
      configDir: this.app.vault.configDir,
      now,
      available: new Set(getIconIds()),
      localFileCount: () => this.app.vault.getFiles().length,
      openStatusPanel: () => openStatusPanel(this.app),
      openConflict: (id) => openConflict(this.app, id),
      openBulkResolve: () => new BulkResolveModal(this.app, ctx).open(),
      openWelcome: () => openWelcome(this.app),
      openTransfer: () => openTransfer(this.app),
      openConnect: () => undefined,
      openClaim: () => undefined,
      openAddDevice: () => undefined,
      confirm: () => Promise.resolve(false),
    };

    this.addSettingTab(new SettingsTab(this.app, this));
    this.registerView(STATUS_VIEW, (leaf) => new StatusPanelView(leaf, ctx));
    this.registerView(CONFLICT_VIEW, (leaf) => new ConflictView(leaf, ctx));
    this.registerView(WELCOME_VIEW, (leaf) => new WelcomeView(leaf, ctx));

    const indicator = new StatusIndicator(this, {
      isMobile,
      lang,
      now,
      available: ctx.available,
      onOpenDetails: () => void ctx.openStatusPanel(),
    });
    indicator.mount();
    const refresh = () => indicator.update(describeStatus(state.snapshot(), DEFAULT_THRESHOLDS, now()));
    this.register(state.onChange(refresh));
    this.register(
      server.onChange((e) => {
        if (e.type === "linked" || e.type === "unlinked") state.setLinked(e.type === "linked");
      }),
    );
    this.register(server.transfer.onChange(() => state.setTransfer(server.transfer.progress())));
    refresh();

    this.addCommand({ id: "open-status", name: m.panel.openCommand, callback: () => void ctx.openStatusPanel() });
    this.addCommand({ id: "connect", name: m.commands.connect, callback: () => void ctx.openWelcome() });

    // Pairing link handler: validated here, full flow in task 7.
    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => {
      void params;
    });

    this.app.workspace.onLayoutReady(() => {
      if (!server.link()) void ctx.openWelcome();
    });

    if (__DEV__) registerDevCommands(this, { lang, now, state, ctx, server });
  }
}
```

(In questo task l'handler del link diventa provvisoriamente un no-op; il Task 7 lo completa. `DevDeps` riceve anche `server: FakeServer`; aggiungere in `commands.ts` i comandi di simulazione: "dev-pairing-request" → `server.simulateIncomingClaim()`, "dev-claim-approve" → `server.simulateClaimAnswer("approved")`, "dev-claim-deny" → `simulateClaimAnswer("denied")`, "dev-device-joined" → `server.simulateDeviceJoined("iPad")`, "dev-transfer-interrupt" → `server.interruptTransfer()`, "dev-transfer-fail" → `server.failTransfer()`, con nomi in `dev.*` dei JSON: it "Simula richiesta di collegamento (sviluppo)", "Simula approvazione (sviluppo)", "Simula rifiuto (sviluppo)", "Simula nuovo dispositivo (sviluppo)", "Simula interruzione del trasferimento (sviluppo)", "Simula errore del trasferimento (sviluppo)"; en "Simulate pairing request (development)", "Simulate approval (development)", "Simulate denial (development)", "Simulate new device (development)", "Simulate transfer interruption (development)", "Simulate transfer failure (development)".)

- [ ] **Step 8: Stili e verifica**

Aggiungere a `src/styles.css`:

```css
.kamino-welcome {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
  max-width: 560px;
  padding: var(--size-4-6) var(--size-4-4);
}
.kamino-welcome h2 {
  margin: 0;
}
.kamino-welcome__muted {
  color: var(--text-muted);
}
.kamino-welcome__choice {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--size-4-1);
  height: auto;
  padding: var(--size-4-3);
  text-align: left;
  white-space: normal;
}
.kamino-welcome__help {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.kamino-welcome__error {
  color: var(--text-error);
  min-height: 1em;
  margin: 0;
}
```

Run: `pnpm --filter @kamino/plugin test && pnpm --filter @kamino/plugin typecheck && pnpm --filter @kamino/plugin lint` → verdi.

```bash
git add apps/plugin
git commit -m "feat(plugin): add welcome view and link state in the status panel"
```

---

### Task 6: Collegamento manuale/onboarding e trasferimento iniziale

**Files:**
- Create: `apps/plugin/src/ui/ConnectModal.ts`, `apps/plugin/src/ui/TransferView.ts`
- Test: `apps/plugin/src/ui/ConnectModal.test.ts`, `apps/plugin/src/ui/TransferView.test.ts`
- Modify: `src/main.ts` (`openConnect`, `registerView(TRANSFER_VIEW)`), `src/i18n/{it,en}.json`, `src/styles.css`

**Interfaces:**
- Produces: `class ConnectModal extends Modal` (costruttore `(app, ctx, mode: "create" | "join")`); `class TransferView extends ItemView` (costruttore `(leaf, ctx)`).

- [ ] **Step 1: Testi**

`it.json`:

```json
"connect": {
  "titleCreate": "È il primo dispositivo",
  "titleJoin": "Collega a un vault esistente",
  "serverLabel": "Indirizzo del server",
  "serverPlaceholder": "https://sync.esempio.it",
  "check": "Verifica",
  "insecure": "Connessione non cifrata: usa questo server solo in una rete di cui ti fidi.",
  "user": "Nome utente",
  "password": "Password",
  "totp": "Codice di verifica",
  "totpHint": "Inserisci il codice di 6 cifre dell'app di autenticazione.",
  "signIn": "Accedi",
  "vaultName": "Nome del vault sul server",
  "vaultPick": "Scegli il vault",
  "vaultMeta": "{files} file · {devices} dispositivi",
  "noVaults": "Nessun vault su questo server: usa 'È il primo dispositivo'.",
  "deviceName": "Nome di questo dispositivo",
  "createAndLink": "Crea e collega",
  "link": "Collega",
  "reconcile": "Questo vault contiene già {count} file: li confronto con quelli sul server. Quelli identici restano come sono, quelli diversi diventano conflitti da guardare. Nessun file viene sovrascritto.",
  "continue": "Continua",
  "next": "Avanti",
  "back": "Indietro",
  "cancel": "Annulla",
  "errors": {
    "invalid_url": "Indirizzo non valido.",
    "unreachable": "Server non raggiungibile: controlla l'indirizzo e la connessione.",
    "incompatible": "Versione del server non compatibile con questo plugin: aggiorna il plugin o il server.",
    "insecure_on_mobile": "Su telefono serve un indirizzo https://. Per un server in casa puoi usare Tailscale, Cloudflare Tunnel o un reverse proxy con certificato.",
    "bad_credentials": "Nome utente o password non corretti.",
    "bad_totp": "Codice di verifica non corretto.",
    "locked": "Account bloccato: contatta l'amministratore.",
    "required": "Compila questo campo."
  }
},
"transfer": {
  "viewTitle": "Sincronizzazione iniziale",
  "upload": "Caricamento iniziale",
  "download": "Download iniziale",
  "none": "Nessun trasferimento in corso.",
  "progress": "{files} di {total} file · {bytes} di {bytesTotal}",
  "keepWorking": "Puoi continuare a lavorare: le modifiche nuove si aggiungono alla coda.",
  "pause": "Pausa",
  "resume": "Riprendi",
  "paused": "In pausa.",
  "interrupted": "Interrotto: riprendo appena possibile.",
  "failed": "Il trasferimento si è fermato per un errore.",
  "retry": "Riprova",
  "done": "Fatto: {count} file sincronizzati.",
  "openStatus": "Apri lo stato sync"
}
```

`en.json`:

```json
"connect": {
  "titleCreate": "This is the first device",
  "titleJoin": "Link to an existing vault",
  "serverLabel": "Server address",
  "serverPlaceholder": "https://sync.example.com",
  "check": "Check",
  "insecure": "Unencrypted connection: use this server only on a network you trust.",
  "user": "Username",
  "password": "Password",
  "totp": "Verification code",
  "totpHint": "Enter the 6-digit code from your authenticator app.",
  "signIn": "Sign in",
  "vaultName": "Vault name on the server",
  "vaultPick": "Choose the vault",
  "vaultMeta": "{files} files · {devices} devices",
  "noVaults": "No vaults on this server: use 'This is the first device'.",
  "deviceName": "Name of this device",
  "createAndLink": "Create and link",
  "link": "Link",
  "reconcile": "This vault already contains {count} files: I compare them with the ones on the server. Identical files stay as they are, different ones become conflicts to review. No file is overwritten.",
  "continue": "Continue",
  "next": "Next",
  "back": "Back",
  "cancel": "Cancel",
  "errors": {
    "invalid_url": "Invalid address.",
    "unreachable": "Server unreachable: check the address and the connection.",
    "incompatible": "Server version not compatible with this plugin: update the plugin or the server.",
    "insecure_on_mobile": "On a phone an https:// address is required. For a home server you can use Tailscale, Cloudflare Tunnel or a reverse proxy with a certificate.",
    "bad_credentials": "Wrong username or password.",
    "bad_totp": "Wrong verification code.",
    "locked": "Account locked: contact the administrator.",
    "required": "Fill in this field."
  }
},
"transfer": {
  "viewTitle": "Initial sync",
  "upload": "Initial upload",
  "download": "Initial download",
  "none": "No transfer in progress.",
  "progress": "{files} of {total} files · {bytes} of {bytesTotal}",
  "keepWorking": "You can keep working: new changes are added to the queue.",
  "pause": "Pause",
  "resume": "Resume",
  "paused": "Paused.",
  "interrupted": "Interrupted: resuming as soon as possible.",
  "failed": "The transfer stopped because of an error.",
  "retry": "Retry",
  "done": "Done: {count} files synced.",
  "openStatus": "Open sync status"
}
```

- [ ] **Step 2: Test di `ConnectModal` (falliscono)**

`src/ui/ConnectModal.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { App } from "../__mocks__/obsidian.js";
import { makeCtx } from "../__mocks__/ui-context.js";
import type { UiContext } from "./context.js";
import { ConnectModal } from "./ConnectModal.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

function open(mode: "create" | "join", over: Partial<UiContext> = {}, files = 0) {
  const made = makeCtx(over);
  made.plugin.app.vault.files = Array.from({ length: files }, (_, i) => ({ path: `n${i}.md` }));
  const modal = new ConnectModal(new App() as never, made.ctx, mode);
  modal.open();
  const root = (modal as unknown as { contentEl: HTMLElement }).contentEl;
  const input = (label: string) => root.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;
  const type = (label: string, value: string) => {
    const el = input(label)!;
    el.value = value;
    el.dispatchEvent(new Event("input"));
  };
  const click = async (text: string) => {
    [...root.querySelectorAll("button")].find((b) => b.textContent === text)!.click();
    await flush();
  };
  return { ...made, modal, root, input, type, click };
}

async function toLogin(o: ReturnType<typeof open>, server = "https://sync.example") {
  o.type("Indirizzo del server", server);
  await o.click("Verifica");
}

describe("ConnectModal, server step", () => {
  it.each([
    ["nope", "Indirizzo non valido."],
    ["https://unreachable.example", "Server non raggiungibile"],
    ["https://old.example", "Versione del server non compatibile"],
  ])("%s -> error", async (server, message) => {
    const o = open("join");
    await toLogin(o, server);
    expect(o.root.textContent).toContain(message);
    expect(o.input("Nome utente")).toBeNull();
  });

  it("http on desktop: warning, then login", async () => {
    const o = open("join");
    await toLogin(o, "http://10.0.0.2:8080");
    expect(o.root.textContent).toContain("Connessione non cifrata");
    expect(o.input("Nome utente")).not.toBeNull();
  });

  it("http on mobile: blocked", async () => {
    const o = open("join", { isMobile: true });
    await toLogin(o, "http://10.0.0.2:8080");
    expect(o.root.textContent).toContain("Su telefono serve un indirizzo https://");
    expect(o.input("Nome utente")).toBeNull();
  });
});

describe("ConnectModal, login step", () => {
  it("wrong credentials, then TOTP", async () => {
    const o = open("join");
    await toLogin(o);
    o.type("Nome utente", "demo");
    o.type("Password", "nope");
    await o.click("Accedi");
    expect(o.root.textContent).toContain("Nome utente o password non corretti.");
    o.type("Nome utente", "demo2fa");
    o.type("Password", "demo");
    await o.click("Accedi");
    expect(o.input("Codice di verifica")).not.toBeNull();
    o.type("Codice di verifica", "000000");
    await o.click("Accedi");
    expect(o.root.textContent).toContain("Codice di verifica non corretto.");
  });

  it("the password is not left in the DOM after closing", async () => {
    const o = open("join");
    await toLogin(o);
    o.type("Password", "secret");
    o.modal.close();
    expect(o.root.innerHTML).not.toContain("secret");
    expect(o.input("Password")).toBeNull();
  });
});

describe("ConnectModal, create flow", () => {
  it("creates the vault, links, starts the upload and opens the transfer view", async () => {
    const o = open("create", {}, 3);
    await toLogin(o);
    o.type("Nome utente", "demo");
    o.type("Password", "demo");
    await o.click("Accedi");
    expect(o.input("Nome del vault sul server")!.value).toBe("Prova");
    await o.click("Avanti");
    expect(o.input("Nome di questo dispositivo")!.value).toBe("macOS");
    const start = vi.spyOn(o.ctx.transfer, "start");
    await o.click("Crea e collega");
    expect(o.server.link()).toMatchObject({ vaultName: "Prova", deviceName: "macOS" });
    expect(start).toHaveBeenCalledWith("upload");
    expect(o.ctx.openTransfer).toHaveBeenCalled();
    expect((o.modal as unknown as { isOpen: boolean }).isOpen).toBe(false);
  });
});

describe("ConnectModal, join flow", () => {
  async function toVaults(o: ReturnType<typeof open>, user = "demo") {
    await toLogin(o);
    o.type("Nome utente", user);
    o.type("Password", "demo");
    if (user === "demo2fa") {
      await o.click("Accedi");
      o.type("Codice di verifica", "123456");
    }
    await o.click("Accedi");
  }

  it("empty vault list explains what to do", async () => {
    const o = open("join");
    await toVaults(o, "demo2fa");
    expect(o.root.textContent).toContain("Nessun vault su questo server");
  });

  it("with local files: reconciliation before linking", async () => {
    const o = open("join", {}, 12);
    await toVaults(o);
    (o.root.querySelector('input[type="radio"][value="v-notes"]') as HTMLInputElement).click();
    await o.click("Avanti");
    await o.click("Collega");
    expect(o.root.textContent).toContain("Questo vault contiene già 12 file");
    expect(o.server.link()).toBeNull();
    const start = vi.spyOn(o.ctx.transfer, "start");
    await o.click("Continua");
    expect(o.server.link()?.vaultId).toBe("v-notes");
    expect(start).toHaveBeenCalledWith("download");
  });

  it("empty local folder: links directly", async () => {
    const o = open("join", {}, 0);
    await toVaults(o);
    (o.root.querySelector('input[type="radio"][value="v-work"]') as HTMLInputElement).click();
    await o.click("Avanti");
    await o.click("Collega");
    expect(o.server.link()?.vaultId).toBe("v-work");
  });

  it("back returns to the previous step", async () => {
    const o = open("join");
    await toLogin(o);
    await o.click("Indietro");
    expect(o.input("Indirizzo del server")).not.toBeNull();
  });
});
```

- [ ] **Step 3: `ConnectModal`**

`src/ui/ConnectModal.ts`:

```ts
import { Modal, type App } from "obsidian";
import type { ServerCheck, Session, VaultSummary } from "../connection/types.js";
import { fmt } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import type { UiContext } from "./context.js";
import { h } from "./dom.js";
import { CLASS_PREFIX } from "./status-classes.js";

const P = `${CLASS_PREFIX}-connect`;
type Step = "server" | "login" | "vault" | "device" | "reconcile";

/** Manual linking: first device ("create") or existing vault ("join") — spec §3.2–3.3. */
export class ConnectModal extends Modal {
  private step: Step = "server";
  private serverUrl = "";
  private check: Extract<ServerCheck, { ok: true }> | null = null;
  private user = "";
  private password = "";
  private totp = "";
  private needTotp = false;
  private session: Session | null = null;
  private vaults: VaultSummary[] = [];
  private vaultId: string | null = null;
  private vaultName: string;
  private deviceName: string;
  private error: string | null = null;
  private busy = false;

  constructor(
    app: App,
    private readonly ctx: UiContext,
    private readonly mode: "create" | "join",
  ) {
    super(app);
    this.vaultName = ctx.vaultName;
    this.deviceName = ctx.platformLabel;
  }

  override onOpen(): void {
    this.render();
  }

  override onClose(): void {
    // Never keep the password around (D-08).
    this.password = "";
    this.totp = "";
    this.contentEl.replaceChildren();
  }

  private get m() {
    return t(this.ctx.lang).connect;
  }

  private render(): void {
    const m = this.m;
    this.titleEl.textContent = this.mode === "create" ? m.titleCreate : m.titleJoin;
    const root = this.contentEl;
    root.replaceChildren();
    root.classList.add(P);
    if (this.check?.insecure) h(root, "p", { cls: `${P}__warning`, text: m.insecure });

    const body = h(root, "div", { cls: `${P}__body` });
    if (this.step === "server") {
      this.field(body, m.serverLabel, this.serverUrl, (v) => (this.serverUrl = v), "url", m.serverPlaceholder);
    } else if (this.step === "login") {
      this.field(body, m.user, this.user, (v) => (this.user = v));
      this.field(body, m.password, "", (v) => (this.password = v), "password");
      if (this.needTotp) {
        h(body, "p", { cls: `${P}__muted`, text: m.totpHint });
        this.field(body, m.totp, "", (v) => (this.totp = v), "text");
      }
    } else if (this.step === "vault") {
      if (this.mode === "create") {
        this.field(body, m.vaultName, this.vaultName, (v) => (this.vaultName = v));
      } else if (this.vaults.length === 0) {
        h(body, "p", { text: m.noVaults });
      } else {
        const group = h(body, "div", { attrs: { role: "radiogroup", "aria-label": m.vaultPick } });
        for (const v of this.vaults) {
          const label = h(group, "label", { cls: `${P}__vault` });
          const input = h(label, "input", { attrs: { type: "radio", name: "vault", value: v.id } });
          input.checked = this.vaultId === v.id;
          input.addEventListener("change", () => (this.vaultId = v.id));
          h(label, "b", { text: v.name });
          h(label, "span", { cls: `${P}__muted`, text: fmt(m.vaultMeta, { files: v.fileCount, devices: v.deviceCount }) });
        }
      }
    } else if (this.step === "device") {
      this.field(body, m.deviceName, this.deviceName, (v) => (this.deviceName = v));
    } else {
      h(body, "p", { text: fmt(m.reconcile, { count: this.ctx.localFileCount() }) });
    }

    if (this.error) h(root, "p", { cls: `${P}__error`, attrs: { role: "alert" }, text: this.error });
    this.renderButtons(root);
  }

  private field(
    parent: HTMLElement,
    label: string,
    value: string,
    onInput: (v: string) => void,
    type = "text",
    placeholder = "",
  ): void {
    const wrap = h(parent, "label", { cls: `${P}__field` });
    h(wrap, "span", { text: label });
    const input = h(wrap, "input", { attrs: { type, "aria-label": label, ...(placeholder ? { placeholder } : {}) } });
    input.value = value;
    input.addEventListener("input", () => onInput(input.value));
  }

  private renderButtons(root: HTMLElement): void {
    const m = this.m;
    const bar = h(root, "div", { cls: "modal-button-container" });
    const button = (text: string, onClick: () => void, cta = false) => {
      const b = h(bar, "button", { text, ...(cta ? { cls: "mod-cta" } : {}) });
      b.disabled = this.busy;
      b.addEventListener("click", onClick);
    };
    if (this.step !== "server") button(m.back, () => this.back());
    button(m.cancel, () => this.close());
    const primary = {
      server: m.check,
      login: m.signIn,
      vault: m.next,
      device: this.mode === "create" ? m.createAndLink : m.link,
      reconcile: m.continue,
    }[this.step];
    if (this.step === "vault" && this.mode === "join" && this.vaults.length === 0) return;
    button(primary, () => void this.next(), true);
  }

  private back(): void {
    const order: Step[] = ["server", "login", "vault", "device", "reconcile"];
    this.error = null;
    this.step = order[Math.max(0, order.indexOf(this.step) - 1)]!;
    if (this.step === "server") this.check = null;
    this.render();
  }

  private async next(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    try {
      await this.advance();
    } finally {
      this.busy = false;
      if (this.contentEl.isConnected || this.contentEl.childElementCount > 0) this.render();
    }
  }

  private async advance(): Promise<void> {
    const m = this.m;
    const { connection } = this.ctx;
    switch (this.step) {
      case "server": {
        const r = await connection.checkServer(this.serverUrl);
        if (!r.ok) {
          this.error = m.errors[r.reason];
          return;
        }
        this.check = r;
        this.step = "login";
        return;
      }
      case "login": {
        if (!this.user || !this.password) {
          this.error = m.errors.required;
          return;
        }
        const r = await connection.login(this.serverUrl.trim(), this.user, this.password, this.needTotp ? this.totp : undefined);
        if (!r.ok) {
          if (r.reason === "totp_required") this.needTotp = true;
          else this.error = m.errors[r.reason];
          return;
        }
        this.password = "";
        this.totp = "";
        this.session = r.session;
        if (this.mode === "join") this.vaults = await connection.listVaults(r.session);
        this.step = "vault";
        return;
      }
      case "vault": {
        if (this.mode === "create" ? !this.vaultName.trim() : !this.vaultId) {
          this.error = m.errors.required;
          return;
        }
        this.step = "device";
        return;
      }
      case "device": {
        if (!this.deviceName.trim()) {
          this.error = m.errors.required;
          return;
        }
        if (this.mode === "join" && this.ctx.localFileCount() > 0) {
          this.step = "reconcile";
          return;
        }
        await this.finish();
        return;
      }
      case "reconcile":
        await this.finish();
        return;
    }
  }

  private async finish(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const { connection, transfer } = this.ctx;
    let vaultId = this.vaultId;
    if (this.mode === "create") vaultId = (await connection.createVault(session, this.vaultName.trim())).id;
    if (!vaultId) return;
    await connection.linkDevice(session, vaultId, this.deviceName.trim());
    transfer.start(this.mode === "create" ? "upload" : "download");
    this.close();
    void this.ctx.openTransfer();
  }
}
```

Nota: dopo `close()` il `finally` di `next()` non deve ridisegnare la finestra: la condizione `contentEl.childElementCount > 0` è falsa perché `onClose` svuota il contenuto. Se il typecheck segnala `m.errors[r.reason]` (chiavi), tipizzare `errors` come `Record<string, string>` con un cast locale.

Run: `pnpm --filter @kamino/plugin test -- ConnectModal` → PASS.

- [ ] **Step 4: `TransferView` (test → implementazione)**

`src/ui/TransferView.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { WorkspaceLeaf } from "../__mocks__/obsidian.js";
import { makeCtx } from "../__mocks__/ui-context.js";
import { TransferView } from "./TransferView.js";
import { TRANSFER_VIEW } from "./workspace.js";

async function open() {
  const made = makeCtx();
  made.plugin.app.vault.files = Array.from({ length: 10 }, (_, i) => ({ path: `n${i}.md` }));
  made.plugin.registerView(TRANSFER_VIEW, (leaf) => new TransferView(leaf as never, made.ctx) as never);
  const leaf = new WorkspaceLeaf(made.plugin.app);
  await leaf.setViewState({ type: TRANSFER_VIEW });
  const root = leaf.view!.contentEl;
  const button = (text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === text);
  return { ...made, root, button };
}

describe("TransferView", () => {
  it("nothing to show without a transfer", async () => {
    const { root } = await open();
    expect(root.textContent).toContain("Nessun trasferimento in corso.");
  });

  it("progress, pause, resume, done", async () => {
    const { root, server, button, ctx } = await open();
    server.transfer.start("upload");
    server.advance(4);
    expect(root.querySelector("h2")?.textContent).toBe("Caricamento iniziale");
    expect((root.querySelector("progress") as HTMLProgressElement).value).toBe(4);
    expect(root.textContent).toContain("4 di 10 file");
    button("Pausa")!.click();
    expect(root.textContent).toContain("In pausa.");
    button("Riprendi")!.click();
    server.advance(10);
    expect(root.textContent).toContain("Fatto: 10 file sincronizzati.");
    button("Apri lo stato sync")!.click();
    expect(ctx.openStatusPanel).toHaveBeenCalled();
  });

  it("interruption and failure with retry", async () => {
    const { root, server, button } = await open();
    server.transfer.start("download");
    server.interruptTransfer();
    expect(root.textContent).toContain("Interrotto: riprendo appena possibile.");
    server.failTransfer();
    expect(root.textContent).toContain("Il trasferimento si è fermato per un errore.");
    button("Riprova")!.click();
    expect(server.transfer.progress()?.phase).toBe("running");
  });
});
```

`src/ui/TransferView.ts`:

```ts
import { ItemView, type WorkspaceLeaf } from "obsidian";
import { fmt, formatSize } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import type { UiContext } from "./context.js";
import { h } from "./dom.js";
import { CLASS_PREFIX } from "./status-classes.js";
import { TRANSFER_VIEW } from "./workspace.js";

const P = `${CLASS_PREFIX}-transfer`;

/** Initial upload/download progress (spec §3.5). */
export class TransferView extends ItemView {
  private unsubscribe: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly ctx: UiContext,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return TRANSFER_VIEW;
  }
  override getDisplayText(): string {
    return t(this.ctx.lang).transfer.viewTitle;
  }
  override getIcon(): string {
    return "refresh-cw";
  }

  protected override onOpen(): Promise<void> {
    this.unsubscribe = this.ctx.transfer.onChange(() => this.render());
    this.render();
    return Promise.resolve();
  }

  protected override onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    return Promise.resolve();
  }

  private render(): void {
    const m = t(this.ctx.lang).transfer;
    const lang = this.ctx.lang;
    const root = this.contentEl;
    root.replaceChildren();
    root.classList.add(P);
    const p = this.ctx.transfer.progress();
    if (!p) {
      h(root, "p", { text: m.none });
      return;
    }
    h(root, "h2", { text: p.direction === "upload" ? m.upload : m.download });
    const bar = h(root, "progress", { attrs: { max: String(Math.max(1, p.files.total)) } });
    bar.value = p.files.done;
    h(root, "p", {
      attrs: { "aria-live": "polite" },
      text: fmt(m.progress, {
        files: p.files.done,
        total: p.files.total,
        bytes: formatSize(p.bytes.done, lang),
        bytesTotal: formatSize(p.bytes.total, lang),
      }),
    });

    const actions = h(root, "div", { cls: `${P}__actions` });
    const button = (text: string, onClick: () => void, cta = false) =>
      h(actions, "button", { text, ...(cta ? { cls: "mod-cta" } : {}) }).addEventListener("click", onClick);

    switch (p.phase) {
      case "running":
        h(root, "p", { cls: `${P}__muted`, text: m.keepWorking });
        button(m.pause, () => this.ctx.transfer.pause());
        break;
      case "paused":
        h(root, "p", { text: m.paused });
        button(m.resume, () => this.ctx.transfer.resume(), true);
        break;
      case "interrupted":
        h(root, "p", { attrs: { role: "status" }, text: m.interrupted });
        break;
      case "failed":
        h(root, "p", { attrs: { role: "alert" }, text: m.failed });
        button(m.retry, () => this.ctx.transfer.retry(), true);
        break;
      case "done":
        h(root, "p", { text: fmt(m.done, { count: p.files.total }) });
        button(m.openStatus, () => void this.ctx.openStatusPanel(), true);
        break;
    }
    root.append(actions);
  }
}
```

Run: `pnpm --filter @kamino/plugin test -- TransferView` → PASS.

- [ ] **Step 5: Collegamento in `main.ts`, stili, verifica, commit**

In `main.ts`: `openConnect: (mode) => new ConnectModal(this.app, ctx, mode).open(),` e `this.registerView(TRANSFER_VIEW, (leaf) => new TransferView(leaf, ctx));` (import di `ConnectModal`, `TransferView`, `TRANSFER_VIEW`).

Aggiungere a `src/styles.css`:

```css
.kamino-connect__body,
.kamino-connect__field {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
.kamino-connect__field input {
  width: 100%;
}
.kamino-connect__vault {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0 var(--size-4-2);
  padding: var(--size-4-2) 0;
}
.kamino-connect__vault .kamino-connect__muted {
  grid-column: 2;
}
.kamino-connect__muted,
.kamino-transfer__muted {
  color: var(--text-muted);
}
.kamino-connect__warning {
  padding: var(--size-4-2) var(--size-4-3);
  border: 1px solid var(--color-yellow);
  border-radius: var(--radius-s);
}
.kamino-connect__error {
  color: var(--text-error);
}
.kamino-transfer {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
  max-width: 560px;
  padding: var(--size-4-6) var(--size-4-4);
}
.kamino-transfer progress {
  width: 100%;
}
.kamino-transfer__actions {
  display: flex;
  gap: var(--size-4-2);
}
```

Run: `pnpm --filter @kamino/plugin test && pnpm --filter @kamino/plugin typecheck && pnpm --filter @kamino/plugin lint`

```bash
git add apps/plugin
git commit -m "feat(plugin): add manual linking flow and initial transfer view"
pnpm --filter @kamino/plugin build:vault
```

**Prova col committente** (desktop): benvenuto all'avvio (vault non collegato); "È il primo dispositivo" con `demo`/`demo` → trasferimento; scollegare non è ancora disponibile (Task 8): per ripetere, cancellare `vault/kamino/.obsidian/plugins/kamino-sync/data.json` e ricaricare il plugin; "Collega a un vault esistente" con `demo2fa`/`demo`/`123456`; errori con `https://unreachable.example`, `https://old.example`, `http://…`.

---

### Task 7: Pairing — link, codice, "Aggiungi un dispositivo", notice

**Files:**
- Create: `src/ui/PairingClaimModal.ts`, `src/ui/AddDeviceModal.ts`, `src/connection/handle-link.ts`, `src/connection/pairing-notices.ts`
- Test: `src/ui/PairingClaimModal.test.ts`, `src/ui/AddDeviceModal.test.ts`, `src/connection/handle-link.test.ts`
- Modify: `src/main.ts`, `src/i18n/{it,en}.json`, `src/styles.css`

**Interfaces:**
- Produces: `class PairingClaimModal extends Modal` (`(app, ctx, link: PairingLink)`); `class AddDeviceModal extends Modal` (`(app, ctx, request?: PairingRequest)`, statico `AddDeviceModal.isShowing(pairingId): boolean`); `handlePairingLink(params: Record<string, string>, ctx: UiContext): void`; `watchPairingEvents(ctx: UiContext): () => void`.

- [ ] **Step 1: Testi**

`it.json` → oggetto `pairing` (sostituisce quello del Task 1, mantenendo `invalidLink`):

```json
"pairing": {
  "invalidLink": "Link di collegamento non valido.",
  "alreadyLinkedTitle": "Vault già collegato",
  "alreadyLinked": "Questo vault è già collegato a un server. Per collegarlo in un altro modo, prima scollegalo dalle impostazioni.",
  "claimTitle": "Collegamento a {host}",
  "deviceName": "Nome di questo dispositivo",
  "start": "Collega",
  "codeIntro": "Sul dispositivo da cui hai generato il codice comparirà una richiesta. Approvala solo se vedi questo stesso codice:",
  "waiting": "In attesa di approvazione… · scade tra {left}",
  "denied": "Collegamento rifiutato dall'altro dispositivo.",
  "expired": "Tempo scaduto: genera un nuovo codice.",
  "alreadyClaimed": "Il link è già stato usato.",
  "invalidToken": "Il link non è valido.",
  "close": "Chiudi",
  "cancel": "Annulla",
  "addTitle": "Aggiungi un dispositivo",
  "addIntro": "Inquadra il codice con la fotocamera del nuovo dispositivo, dove Obsidian e il plugin sono già installati in un vault vuoto.",
  "qrAlt": "Codice QR per collegare un dispositivo",
  "copy": "Copia link",
  "copied": "Link copiato.",
  "validFor": "Valido ancora {left} · usabile una volta sola",
  "codeExpired": "Codice scaduto.",
  "regenerate": "Genera di nuovo",
  "requestTitle": "Nuovo dispositivo: “{name}”",
  "requestMeta": "{platform} · plugin {version} · richiesta alle {time}",
  "requestHint": "Approva solo se sul nuovo dispositivo vedi lo stesso codice. Se non sei stato tu, rifiuta.",
  "approve": "Approva",
  "deny": "Rifiuta",
  "approved": "Dispositivo collegato.",
  "rejected": "Richiesta rifiutata.",
  "noticeRequest": "Un nuovo dispositivo chiede di collegarsi. Tocca per rispondere.",
  "noticeJoined": "Nuovo dispositivo collegato: {name}.",
  "noticeReused": "Il link è stato usato da un secondo dispositivo ed è stato bloccato."
}
```

`en.json`:

```json
"pairing": {
  "invalidLink": "Invalid pairing link.",
  "alreadyLinkedTitle": "Vault already linked",
  "alreadyLinked": "This vault is already linked to a server. To link it another way, unlink it first in the settings.",
  "claimTitle": "Linking to {host}",
  "deviceName": "Name of this device",
  "start": "Link",
  "codeIntro": "A request will appear on the device that generated the code. Approve it only if you see this same code:",
  "waiting": "Waiting for approval… · expires in {left}",
  "denied": "Linking denied by the other device.",
  "expired": "Time is up: generate a new code.",
  "alreadyClaimed": "The link has already been used.",
  "invalidToken": "The link is not valid.",
  "close": "Close",
  "cancel": "Cancel",
  "addTitle": "Add a device",
  "addIntro": "Scan the code with the camera of the new device, where Obsidian and the plugin are already installed in an empty vault.",
  "qrAlt": "QR code to link a device",
  "copy": "Copy link",
  "copied": "Link copied.",
  "validFor": "Valid for {left} · usable once",
  "codeExpired": "Code expired.",
  "regenerate": "Generate again",
  "requestTitle": "New device: “{name}”",
  "requestMeta": "{platform} · plugin {version} · requested at {time}",
  "requestHint": "Approve only if you see the same code on the new device. If it wasn't you, deny.",
  "approve": "Approve",
  "deny": "Deny",
  "approved": "Device linked.",
  "rejected": "Request denied.",
  "noticeRequest": "A new device asks to link. Tap to answer.",
  "noticeJoined": "New device linked: {name}.",
  "noticeReused": "The link was used by a second device and has been blocked."
}
```

Rimuovere `pairing.linkReceived` (non più usato) da entrambi.

- [ ] **Step 2: `handle-link` (test → implementazione)**

`src/connection/handle-link.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { Notice } from "../__mocks__/obsidian.js";
import { makeCtx } from "../__mocks__/ui-context.js";
import { handlePairingLink } from "./handle-link.js";

beforeEach(() => {
  Notice.shown = [];
});

describe("handlePairingLink", () => {
  it("invalid link: notice, no flow", () => {
    const { ctx } = makeCtx();
    handlePairingLink({ action: "kamino", token: "x" }, ctx);
    expect(Notice.shown).toEqual(["Link di collegamento non valido."]);
    expect(ctx.openClaim).not.toHaveBeenCalled();
  });

  it("valid link: opens the claim", () => {
    const { ctx } = makeCtx();
    handlePairingLink({ action: "kamino", server: "https://sync.example", token: "abc" }, ctx);
    expect(ctx.openClaim).toHaveBeenCalledWith({ server: "https://sync.example", token: "abc" });
  });

  it("http on mobile: blocked", () => {
    const { ctx } = makeCtx({ isMobile: true });
    handlePairingLink({ action: "kamino", server: "http://10.0.0.2", token: "abc" }, ctx);
    expect(ctx.openClaim).not.toHaveBeenCalled();
    expect(Notice.shown[0]).toContain("Su telefono serve un indirizzo https://");
  });

  it("already linked: explains, no flow", async () => {
    const { ctx, server } = makeCtx();
    const login = await server.login("https://sync.example", "demo", "demo");
    if (!login.ok) throw new Error("login");
    await server.linkDevice(login.session, "v-notes", "Laptop");
    handlePairingLink({ action: "kamino", server: "https://sync.example", token: "abc" }, ctx);
    expect(ctx.confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmText: null }));
    expect(ctx.openClaim).not.toHaveBeenCalled();
  });
});
```

`src/connection/handle-link.ts`:

```ts
import { Notice } from "obsidian";
import { t } from "../i18n/index.js";
import type { UiContext } from "../ui/context.js";
import { parsePairingLink } from "./link.js";

/** obsidian://<action>?server=…&token=… → claim flow (spec §3.4). Never throws. */
export function handlePairingLink(params: Record<string, string>, ctx: UiContext): void {
  const m = t(ctx.lang);
  const parsed = parsePairingLink(params);
  if (!parsed.ok) {
    new Notice(m.pairing.invalidLink);
    return;
  }
  if (ctx.connection.link()) {
    void ctx.confirm({
      title: m.pairing.alreadyLinkedTitle,
      text: m.pairing.alreadyLinked,
      confirmText: null,
      cancelText: m.pairing.close,
    });
    return;
  }
  if (ctx.isMobile && parsed.link.server.startsWith("http:")) {
    new Notice(m.connect.errors.insecure_on_mobile);
    return;
  }
  ctx.openClaim(parsed.link);
}
```

- [ ] **Step 3: `PairingClaimModal` (test → implementazione)**

`src/ui/PairingClaimModal.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../__mocks__/obsidian.js";
import { makeCtx } from "../__mocks__/ui-context.js";
import { PairingClaimModal } from "./PairingClaimModal.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function open(token = "remote", files = 0) {
  const made = makeCtx();
  made.plugin.app.vault.files = Array.from({ length: files }, (_, i) => ({ path: `n${i}.md` }));
  const modal = new PairingClaimModal(new App() as never, made.ctx, { server: "https://sync.example", token });
  modal.open();
  const root = (modal as unknown as { contentEl: HTMLElement }).contentEl;
  const click = async (text: string) => {
    [...root.querySelectorAll("button")].find((b) => b.textContent === text)!.click();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { ...made, modal, root, click };
}

describe("PairingClaimModal", () => {
  it("shows the host and the device name, then the code", async () => {
    const o = await open();
    expect(o.root.querySelector("h2")?.textContent).toBe("Collegamento a sync.example");
    await o.click("Collega");
    expect(o.root.querySelector(".kamino-pairing__code")?.textContent).toHaveLength(4);
    expect(o.root.textContent).toContain("In attesa di approvazione");
  });

  it("approved without local files: starts the download", async () => {
    const o = await open();
    await o.click("Collega");
    const start = vi.spyOn(o.ctx.transfer, "start");
    o.server.simulateClaimAnswer("approved");
    await vi.advanceTimersByTimeAsync(2000);
    expect(start).toHaveBeenCalledWith("download");
    expect(o.ctx.openTransfer).toHaveBeenCalled();
  });

  it("approved with local files: reconciliation; cancel unlinks", async () => {
    const o = await open("remote", 5);
    await o.click("Collega");
    o.server.simulateClaimAnswer("approved");
    await vi.advanceTimersByTimeAsync(2000);
    expect(o.root.textContent).toContain("Questo vault contiene già 5 file");
    await o.click("Annulla");
    expect(o.server.link()).toBeNull();
  });

  it("denied", async () => {
    const o = await open();
    await o.click("Collega");
    o.server.simulateClaimAnswer("denied");
    await vi.advanceTimersByTimeAsync(2000);
    expect(o.root.textContent).toContain("Collegamento rifiutato dall'altro dispositivo.");
  });

  it.each([
    ["expired", "Tempo scaduto"],
    ["used", "Il link è già stato usato."],
    ["bad", "Il link non è valido."],
  ])("claim error %s", async (token, text) => {
    const o = await open(token);
    await o.click("Collega");
    expect(o.root.textContent).toContain(text);
  });

  it("stops polling when closed", async () => {
    const o = await open();
    await o.click("Collega");
    const spy = vi.spyOn(o.server, "claimStatus");
    o.modal.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spy).not.toHaveBeenCalled();
  });
});
```

`src/ui/PairingClaimModal.ts`:

```ts
import { formatAge } from "@kamino/status";
import { Modal, type App } from "obsidian";
import type { PairingLink } from "../connection/link.js";
import { fmt } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import type { UiContext } from "./context.js";
import { h } from "./dom.js";
import { CLASS_PREFIX } from "./status-classes.js";

const P = `${CLASS_PREFIX}-pairing`;
type Step = "name" | "code" | "reconcile" | "result";

/** New device side of pairing: name → code → approval → (reconcile) → download (spec §3.4). */
export class PairingClaimModal extends Modal {
  private step: Step = "name";
  private deviceName: string;
  private host: string;
  private code = "";
  private claimId: string | null = null;
  private expiresAt = 0;
  private result = "";
  private timer: number | null = null;
  private ticks = 0;
  private busy = false;

  constructor(
    app: App,
    private readonly ctx: UiContext,
    private readonly link: PairingLink,
  ) {
    super(app);
    this.deviceName = ctx.platformLabel;
    this.host = new URL(link.server).host;
  }

  override onOpen(): void {
    this.render();
  }

  override onClose(): void {
    this.stopTimer();
    if (this.step === "code" && this.claimId) void this.ctx.connection.cancelClaim(this.claimId);
    this.contentEl.replaceChildren();
  }

  private get m() {
    return t(this.ctx.lang).pairing;
  }

  private render(): void {
    const m = this.m;
    this.titleEl.textContent = "";
    const root = this.contentEl;
    root.replaceChildren();
    root.classList.add(P);
    h(root, "h2", { text: fmt(m.claimTitle, { host: this.host }) });
    const bar = () => h(root, "div", { cls: "modal-button-container" });
    const button = (parent: HTMLElement, text: string, onClick: () => void, cta = false) => {
      const b = h(parent, "button", { text, ...(cta ? { cls: "mod-cta" } : {}) });
      b.disabled = this.busy;
      b.addEventListener("click", onClick);
    };

    if (this.step === "name") {
      const label = h(root, "label", { cls: `${P}__field` });
      h(label, "span", { text: m.deviceName });
      const input = h(label, "input", { attrs: { type: "text", "aria-label": m.deviceName } });
      input.value = this.deviceName;
      input.addEventListener("input", () => (this.deviceName = input.value));
      const b = bar();
      button(b, m.cancel, () => this.close());
      button(b, m.start, () => void this.claim(), true);
    } else if (this.step === "code") {
      h(root, "p", { text: m.codeIntro });
      h(root, "div", { cls: `${P}__code`, text: this.code, attrs: { "aria-label": this.code.split("").join(" ") } });
      h(root, "p", {
        cls: `${P}__muted`,
        attrs: { "aria-live": "polite" },
        text: fmt(m.waiting, { left: this.left() }),
      });
      button(bar(), m.cancel, () => this.close());
    } else if (this.step === "reconcile") {
      h(root, "p", { text: fmt(t(this.ctx.lang).connect.reconcile, { count: this.ctx.localFileCount() }) });
      const b = bar();
      button(b, m.cancel, () => void this.abortAfterApproval());
      button(b, t(this.ctx.lang).connect.continue, () => this.startDownload(), true);
    } else {
      h(root, "p", { attrs: { role: "alert" }, text: this.result });
      button(bar(), m.close, () => this.close());
    }
  }

  private left(): string {
    const ms = Math.max(0, this.expiresAt - this.ctx.now());
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  private async claim(): Promise<void> {
    if (this.busy || !this.deviceName.trim()) return;
    this.busy = true;
    const r = await this.ctx.connection.claim(this.link, this.deviceName.trim());
    this.busy = false;
    if (!r.ok) {
      this.result = { invalid: this.m.invalidToken, expired: this.m.expired, already_claimed: this.m.alreadyClaimed }[r.reason];
      this.step = "result";
      this.render();
      return;
    }
    this.claimId = r.claimId;
    this.code = r.code;
    this.expiresAt = r.expiresAt;
    this.step = "code";
    this.render();
    this.timer = window.setInterval(() => void this.tick(), 1000);
  }

  private async tick(): Promise<void> {
    this.ticks += 1;
    if (this.ticks % 2 === 0 && this.claimId) {
      const status = await this.ctx.connection.claimStatus(this.claimId);
      if (this.step !== "code") return;
      if (status === "approved") {
        this.stopTimer();
        if (this.ctx.localFileCount() > 0) {
          this.step = "reconcile";
          this.render();
        } else {
          this.startDownload();
        }
        return;
      }
      if (status === "denied" || status === "expired") {
        this.stopTimer();
        this.result = status === "denied" ? this.m.denied : this.m.expired;
        this.step = "result";
        this.render();
        return;
      }
    }
    if (this.step === "code") this.render();
  }

  private startDownload(): void {
    this.step = "result";
    this.ctx.transfer.start("download");
    this.close();
    void this.ctx.openTransfer();
  }

  private async abortAfterApproval(): Promise<void> {
    this.step = "result";
    await this.ctx.connection.unlink();
    this.close();
  }

  private stopTimer(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }
}
```

Run: `pnpm --filter @kamino/plugin test -- PairingClaimModal` → PASS.

- [ ] **Step 4: `AddDeviceModal` (test → implementazione)**

`src/ui/AddDeviceModal.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Notice } from "../__mocks__/obsidian.js";
import { makeCtx } from "../__mocks__/ui-context.js";
import { AddDeviceModal } from "./AddDeviceModal.js";

beforeEach(() => {
  vi.useFakeTimers();
  Notice.shown = [];
});
afterEach(() => {
  vi.useRealTimers();
});

async function open() {
  const made = makeCtx();
  const login = await made.server.login("https://sync.example", "demo", "demo");
  if (!login.ok) throw new Error("login");
  await made.server.linkDevice(login.session, "v-notes", "Laptop");
  const modal = new AddDeviceModal(new App() as never, made.ctx);
  modal.open();
  await vi.advanceTimersByTimeAsync(0);
  const root = (modal as unknown as { contentEl: HTMLElement }).contentEl;
  const click = async (text: string) => {
    [...root.querySelectorAll("button")].find((b) => b.textContent === text)!.click();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { ...made, modal, root, click };
}

describe("AddDeviceModal", () => {
  it("shows the QR, the link and the validity", async () => {
    const o = await open();
    const img = o.root.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("Codice QR per collegare un dispositivo");
    expect(img.getAttribute("src")?.startsWith("data:image/svg+xml,")).toBe(true);
    expect((o.root.querySelector("input") as HTMLInputElement).value.startsWith("obsidian://kamino?")).toBe(true);
    expect(o.root.textContent).toContain("usabile una volta sola");
  });

  it("an incoming request turns the window into the approval", async () => {
    const o = await open();
    o.server.simulateIncomingClaim("Pixel", "Android");
    await vi.advanceTimersByTimeAsync(0);
    expect(o.root.textContent).toContain("Nuovo dispositivo: “Pixel”");
    expect(o.root.querySelector(".kamino-pairing__code")?.textContent).toHaveLength(4);
    const approve = vi.spyOn(o.server, "approve");
    await o.click("Approva");
    expect(approve).toHaveBeenCalled();
    expect(o.root.textContent).toContain("Dispositivo collegato.");
  });

  it("deny", async () => {
    const o = await open();
    o.server.simulateIncomingClaim();
    await vi.advanceTimersByTimeAsync(0);
    await o.click("Rifiuta");
    expect(o.root.textContent).toContain("Richiesta rifiutata.");
  });

  it("expiry offers to generate again", async () => {
    const o = await open();
    const now = o.ctx.now();
    o.ctx.now = () => now + 11 * 60_000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(o.root.textContent).toContain("Codice scaduto.");
    await o.click("Genera di nuovo");
    expect(o.root.querySelector("img")).not.toBeNull();
  });

  it("is showing its pairing while open, not after close", async () => {
    const o = await open();
    const id = (o.modal as unknown as { pairingId: string }).pairingId;
    expect(AddDeviceModal.isShowing(id)).toBe(true);
    o.modal.close();
    expect(AddDeviceModal.isShowing(id)).toBe(false);
  });

  it("opened on an existing request shows the approval directly", async () => {
    const made = makeCtx();
    const login = await made.server.login("https://sync.example", "demo", "demo");
    if (!login.ok) throw new Error("login");
    await made.server.linkDevice(login.session, "v-notes", "Laptop");
    await made.server.startPairing();
    made.server.simulateIncomingClaim("Pixel");
    const request = made.server.pairingRequests()[0]!;
    const modal = new AddDeviceModal(new App() as never, made.ctx, request);
    modal.open();
    await vi.advanceTimersByTimeAsync(0);
    const root = (modal as unknown as { contentEl: HTMLElement }).contentEl;
    expect(root.textContent).toContain("Nuovo dispositivo: “Pixel”");
  });
});
```

`src/ui/AddDeviceModal.ts`:

```ts
import { Modal, Notice, type App } from "obsidian";
import { qrDataUrl } from "../connection/qr.js";
import type { PairingRequest } from "../connection/types.js";
import { fmt, formatWhen } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import type { UiContext } from "./context.js";
import { h } from "./dom.js";
import { CLASS_PREFIX } from "./status-classes.js";

const P = `${CLASS_PREFIX}-pairing`;
type Step = "offer" | "expired" | "request" | "done";

/** Origin side of pairing: QR/link, then approval of the request (spec §3.6). */
export class AddDeviceModal extends Modal {
  private static readonly showing = new Set<string>();
  /** True while an open window is showing this pairing: the global notice is then not needed. */
  static isShowing(pairingId: string): boolean {
    return AddDeviceModal.showing.has(pairingId);
  }

  private step: Step = "offer";
  private pairingId = "";
  private link = "";
  private expiresAt = 0;
  private request: PairingRequest | null;
  private doneText = "";
  private timer: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private busy = false;

  constructor(
    app: App,
    private readonly ctx: UiContext,
    request?: PairingRequest,
  ) {
    super(app);
    this.request = request ?? null;
  }

  override onOpen(): void {
    this.unsubscribe = this.ctx.connection.onChange((e) => {
      if (e.type === "pairing_request" && e.request.pairingId === this.pairingId) {
        this.request = e.request;
        this.step = "request";
        this.render();
      }
      if (e.type === "pairing_closed" && e.pairingId === this.pairingId && this.step === "request" && !this.busy) {
        this.doneText = t(this.ctx.lang).pairing.expired;
        this.step = "done";
        this.render();
      }
    });
    this.timer = window.setInterval(() => this.tick(), 1000);
    if (this.request) {
      this.setPairing(this.request.pairingId, this.request.expiresAt);
      this.step = "request";
      this.render();
    } else {
      void this.offer();
    }
  }

  override onClose(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    AddDeviceModal.showing.delete(this.pairingId);
    if (this.step === "offer" && this.pairingId) void this.ctx.connection.cancelPairing(this.pairingId);
    this.contentEl.replaceChildren();
  }

  private setPairing(id: string, expiresAt: number): void {
    AddDeviceModal.showing.delete(this.pairingId);
    this.pairingId = id;
    this.expiresAt = expiresAt;
    AddDeviceModal.showing.add(id);
  }

  private async offer(): Promise<void> {
    const offer = await this.ctx.connection.startPairing();
    this.setPairing(offer.pairingId, offer.expiresAt);
    this.link = offer.link;
    this.step = "offer";
    this.render();
  }

  private tick(): void {
    if (this.step === "offer" && this.ctx.now() >= this.expiresAt) {
      this.step = "expired";
      this.render();
    } else if (this.step === "offer") {
      const el = this.contentEl.querySelector(`.${P}__validity`);
      if (el) el.textContent = fmt(t(this.ctx.lang).pairing.validFor, { left: this.left() });
    }
  }

  private left(): string {
    const s = Math.ceil(Math.max(0, this.expiresAt - this.ctx.now()) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  private render(): void {
    const m = t(this.ctx.lang).pairing;
    const root = this.contentEl;
    root.replaceChildren();
    root.classList.add(P);
    const bar = () => h(root, "div", { cls: "modal-button-container" });
    const button = (parent: HTMLElement, text: string, onClick: () => void, cls = "") => {
      const b = h(parent, "button", { text, ...(cls ? { cls } : {}) });
      b.disabled = this.busy;
      b.addEventListener("click", onClick);
    };

    if (this.step === "offer") {
      this.titleEl.textContent = m.addTitle;
      h(root, "p", { text: m.addIntro });
      h(root, "img", { cls: `${P}__qr`, attrs: { src: qrDataUrl(this.link), alt: m.qrAlt, width: "220", height: "220" } });
      const input = h(root, "input", { attrs: { type: "text", readonly: "", "aria-label": m.copy } });
      input.value = this.link;
      h(root, "p", { cls: `${P}__validity ${P}__muted`, text: fmt(m.validFor, { left: this.left() }) });
      button(bar(), m.copy, () => void this.copy(input));
    } else if (this.step === "expired") {
      this.titleEl.textContent = m.addTitle;
      h(root, "p", { text: m.codeExpired });
      button(bar(), m.regenerate, () => void this.offer(), "mod-cta");
    } else if (this.step === "request" && this.request) {
      const r = this.request;
      this.titleEl.textContent = fmt(m.requestTitle, { name: r.deviceName });
      h(root, "h2", { text: fmt(m.requestTitle, { name: r.deviceName }) });
      h(root, "p", {
        cls: `${P}__muted`,
        text: fmt(m.requestMeta, { platform: r.platform, version: r.pluginVersion, time: formatWhen(r.at, this.ctx.now(), this.ctx.lang) }),
      });
      h(root, "div", { cls: `${P}__code`, text: r.code, attrs: { "aria-label": r.code.split("").join(" ") } });
      h(root, "p", { text: m.requestHint });
      const b = bar();
      button(b, m.approve, () => void this.answer(true), "mod-cta");
      button(b, m.deny, () => void this.answer(false));
    } else {
      h(root, "p", { attrs: { role: "status" }, text: this.doneText });
      button(bar(), m.close, () => this.close());
    }
  }

  private async copy(input: HTMLInputElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.link);
      new Notice(t(this.ctx.lang).pairing.copied);
    } catch {
      input.select();
    }
  }

  private async answer(approve: boolean): Promise<void> {
    if (this.busy) return;
    const m = t(this.ctx.lang).pairing;
    this.busy = true;
    this.render();
    try {
      if (approve) await this.ctx.connection.approve(this.pairingId);
      else await this.ctx.connection.deny(this.pairingId);
      this.doneText = approve ? m.approved : m.rejected;
      this.step = "done";
    } finally {
      this.busy = false;
      this.render();
    }
  }
}
```

Run: `pnpm --filter @kamino/plugin test -- AddDeviceModal` → PASS.

- [ ] **Step 5: Notice globali e `main.ts`**

`src/connection/pairing-notices.ts`:

```ts
import { Notice } from "obsidian";
import { fmt } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import { AddDeviceModal } from "../ui/AddDeviceModal.js";
import type { UiContext } from "../ui/context.js";

/** Pairing events while no approval window shows them (spec §3.6). Returns the unsubscribe. */
export function watchPairingEvents(ctx: UiContext): () => void {
  const m = t(ctx.lang).pairing;
  return ctx.connection.onChange((e) => {
    if (e.type === "pairing_request" && !AddDeviceModal.isShowing(e.request.pairingId)) {
      const notice = new Notice(m.noticeRequest, 15_000);
      notice.noticeEl.addEventListener("click", () => ctx.openAddDevice(e.request));
    } else if (e.type === "device_joined") {
      new Notice(fmt(m.noticeJoined, { name: e.deviceName }));
    } else if (e.type === "pairing_reused") {
      new Notice(m.noticeReused);
    }
  });
}
```

Test in `src/connection/handle-link.test.ts` (nuovo `describe`):

```ts
import { watchPairingEvents } from "./pairing-notices.js";

describe("watchPairingEvents", () => {
  it("notifies requests (clickable), joined devices and reused links", async () => {
    const { ctx, server } = makeCtx();
    watchPairingEvents(ctx);
    const login = await server.login("https://sync.example", "demo", "demo");
    if (!login.ok) throw new Error("login");
    await server.linkDevice(login.session, "v-notes", "Laptop");
    await server.startPairing();
    server.simulateIncomingClaim("Pixel");
    expect(Notice.shown).toEqual(["Un nuovo dispositivo chiede di collegarsi. Tocca per rispondere."]);
    server.simulateDeviceJoined("iPad");
    expect(Notice.shown.at(-1)).toBe("Nuovo dispositivo collegato: iPad.");
  });
});
```

(Per verificare il clic sulla notice, nel mock di `Notice` salvare anche l'ultima istanza: `static last: Notice | null` impostato nel costruttore; poi `Notice.last!.noticeEl.click()` → `ctx.openAddDevice` chiamato. Aggiungere questa asserzione al test.)

In `main.ts`:
- `openClaim: (link) => new PairingClaimModal(this.app, ctx, link).open(),`
- `openAddDevice: (request) => new AddDeviceModal(this.app, ctx, request).open(),`
- protocol handler: `this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => handlePairingLink(params, ctx));`
- `this.register(watchPairingEvents(ctx));`
- comando `{ id: "add-device", name: m.commands.addDevice, checkCallback: (checking) => { if (!server.link()) return false; if (!checking) ctx.openAddDevice(); return true; } }`.

(Nel mock, `addCommand` accetta già `Command` con `callback`; aggiungere `checkCallback?: (checking: boolean) => boolean | void` all'interfaccia del mock.)

- [ ] **Step 6: Stili, verifica, commit, prova**

Aggiungere a `src/styles.css`:

```css
.kamino-pairing__code {
  margin: var(--size-4-3) 0;
  padding: var(--size-4-3) 0;
  border-radius: var(--radius-m);
  background: var(--background-secondary);
  font-family: var(--font-monospace);
  font-size: 2em;
  letter-spacing: 0.3em;
  text-align: center;
}
.kamino-pairing__qr {
  display: block;
  margin: var(--size-4-3) auto;
  border-radius: var(--radius-s);
}
.kamino-pairing input[readonly] {
  width: 100%;
  font-family: var(--font-monospace);
}
.kamino-pairing__muted {
  color: var(--text-muted);
}
.kamino-pairing__field {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
}
```

Run: `pnpm --filter @kamino/plugin test && pnpm --filter @kamino/plugin typecheck && pnpm --filter @kamino/plugin lint`

```bash
git add apps/plugin
git commit -m "feat(plugin): add pairing by QR or link with approval"
```

---

### Task 8: Impostazioni complete e scollegamento

**Files:**
- Create: `src/ui/ConfirmModal.ts`
- Modify (riscrittura): `src/settings/SettingsTab.ts`, `test/settings.test.ts`
- Test: `src/settings/SettingsTab.test.ts`
- Modify: `src/main.ts`, `src/i18n/{it,en}.json`, `apps/plugin/package.json` (dipendenza `@kamino/protocol`)

**Interfaces:**
- Produces: `class ConfirmModal extends Modal` (`(app, opts: ConfirmOptions, resolve: (ok: boolean) => void)`), `confirmDialog(app, opts): Promise<boolean>`; `class SettingsTab extends PluginSettingTab` (`(app, plugin, ctx: UiContext)`).

- [ ] **Step 1: Testi**

In `it.json`, oggetto `settings` (sostituisce quello esistente, mantenendo `title`, `version`, `release`):

```json
"settings": {
  "title": "Impostazioni",
  "version": "Versione",
  "release": "Rilascio",
  "protocol": "Versione del protocollo",
  "link": "Collegamento",
  "notLinked": "Questo vault non è collegato.",
  "connect": "Collega…",
  "server": "Server",
  "user": "Utente",
  "vault": "Vault",
  "deviceName": "Nome di questo dispositivo",
  "addDevice": "Aggiungi un dispositivo",
  "addDeviceDesc": "Mostra un QR o un link per collegare un altro dispositivo.",
  "unlink": "Scollega questo vault",
  "unlinkDesc": "Ferma il sync e revoca questo dispositivo sul server.",
  "unlinkTitle": "Scollegare questo vault?",
  "unlinkText": "Il sync di questo vault si ferma e questo dispositivo viene revocato sul server. I file su questo dispositivo restano dove sono.",
  "insecure": "Connessione non cifrata.",
  "sync": "Sincronizzazione",
  "notActive": "Queste impostazioni verranno usate quando il sync sarà attivo.",
  "mode": "Modalità",
  "modeDesc": "Le modalità cambiano solo quando si sincronizza, mai cosa viene salvato.",
  "modes": { "live": "Live", "periodic": "Periodica", "manual": "Manuale" },
  "debounce": "Pausa di scrittura per le note aperte",
  "debounceDesc": "Secondi senza scrivere prima di inviare (2–30).",
  "periodic": "Ogni quanti minuti",
  "largeFiles": "File grandi",
  "wifiOnly": "Solo in Wi-Fi",
  "wifiOnlyDesc": "I file sopra la soglia aspettano una rete Wi-Fi.",
  "threshold": "Soglia (MB)",
  "iosNote": "Su iPhone e iPad la rete è sempre considerata a consumo: ti verrà chiesta conferma.",
  "exclusions": "Esclusioni",
  "exclusionsDesc": "Un pattern per riga, per esempio Archivio/**",
  "invalidGlobs": "Pattern non validi, ignorati: {list}",
  "alwaysExcluded": "Sempre esclusi: i dati di questo plugin, lo stato delle finestre (workspace), la cache.",
  "configDir": "Cartella di configurazione ({dir})",
  "useVaultDefault": "Usa le impostazioni del vault",
  "categories": {
    "core": "Impostazioni di base",
    "appearance": "Aspetto e temi",
    "hotkeys": "Scorciatoie",
    "enabledPlugins": "Elenco dei plugin attivi",
    "installedPlugins": "Plugin installati e loro impostazioni"
  },
  "configNote": "Le modifiche in arrivo per questa cartella non si applicano subito: ti verrà proposto di riavviare Obsidian.",
  "about": "Informazioni",
  "cancel": "Annulla",
  "confirmUnlink": "Scollega"
}
```

`en.json`:

```json
"settings": {
  "title": "Settings",
  "version": "Version",
  "release": "Release",
  "protocol": "Protocol version",
  "link": "Link",
  "notLinked": "This vault is not linked.",
  "connect": "Link…",
  "server": "Server",
  "user": "User",
  "vault": "Vault",
  "deviceName": "Name of this device",
  "addDevice": "Add a device",
  "addDeviceDesc": "Show a QR code or a link to link another device.",
  "unlink": "Unlink this vault",
  "unlinkDesc": "Stops sync and revokes this device on the server.",
  "unlinkTitle": "Unlink this vault?",
  "unlinkText": "Sync for this vault stops and this device is revoked on the server. The files on this device stay where they are.",
  "insecure": "Unencrypted connection.",
  "sync": "Sync",
  "notActive": "These settings will be used when sync is active.",
  "mode": "Mode",
  "modeDesc": "Modes only change when syncing happens, never what gets saved.",
  "modes": { "live": "Live", "periodic": "Periodic", "manual": "Manual" },
  "debounce": "Typing pause for open notes",
  "debounceDesc": "Seconds without typing before sending (2–30).",
  "periodic": "Every how many minutes",
  "largeFiles": "Large files",
  "wifiOnly": "Wi-Fi only",
  "wifiOnlyDesc": "Files above the threshold wait for a Wi-Fi network.",
  "threshold": "Threshold (MB)",
  "iosNote": "On iPhone and iPad the network is always treated as metered: you will be asked to confirm.",
  "exclusions": "Exclusions",
  "exclusionsDesc": "One pattern per line, for example Archive/**",
  "invalidGlobs": "Invalid patterns, ignored: {list}",
  "alwaysExcluded": "Always excluded: this plugin's data, window state (workspace), cache.",
  "configDir": "Configuration folder ({dir})",
  "useVaultDefault": "Use the vault settings",
  "categories": {
    "core": "Core settings",
    "appearance": "Appearance and themes",
    "hotkeys": "Hotkeys",
    "enabledPlugins": "List of enabled plugins",
    "installedPlugins": "Installed plugins and their settings"
  },
  "configNote": "Incoming changes to this folder are not applied right away: you will be offered to restart Obsidian.",
  "about": "About",
  "cancel": "Cancel",
  "confirmUnlink": "Unlink"
}
```

- [ ] **Step 2: `ConfirmModal`**

`src/ui/ConfirmModal.ts`:

```ts
import { Modal, type App } from "obsidian";
import type { ConfirmOptions } from "./context.js";
import { h } from "./dom.js";

/** Confirmation (or information, with confirmText null). Resolves false on cancel or close. */
export class ConfirmModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly opts: ConfirmOptions,
    private readonly resolve: (ok: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.textContent = this.opts.title;
    h(this.contentEl, "p", { text: this.opts.text });
    const bar = h(this.contentEl, "div", { cls: "modal-button-container" });
    h(bar, "button", { text: this.opts.cancelText }).addEventListener("click", () => this.answer(false));
    if (this.opts.confirmText !== null) {
      h(bar, "button", { cls: this.opts.warning ? "mod-warning" : "mod-cta", text: this.opts.confirmText }).addEventListener(
        "click",
        () => this.answer(true),
      );
    }
  }

  override onClose(): void {
    if (!this.answered) this.resolve(false);
    this.contentEl.replaceChildren();
  }

  private answer(ok: boolean): void {
    this.answered = true;
    this.resolve(ok);
    this.close();
  }
}

export function confirmDialog(app: App, opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => new ConfirmModal(app, opts, resolve).open());
}
```

- [ ] **Step 3: Test della scheda impostazioni (falliscono)**

`src/settings/SettingsTab.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { App } from "../__mocks__/obsidian.js";
import { makeCtx } from "../__mocks__/ui-context.js";
import type { UiContext } from "../ui/context.js";
import { SettingsTab } from "./SettingsTab.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

async function open(over: Partial<UiContext> = {}, linked = false) {
  const made = makeCtx(over);
  if (linked) {
    const login = await made.server.login("http://10.0.0.2:8080", "demo", "demo");
    if (!login.ok) throw new Error("login");
    await made.server.linkDevice(login.session, "v-notes", "Laptop");
  }
  const tab = new SettingsTab(new App() as never, made.plugin as never, made.ctx);
  tab.display();
  const root = (tab as unknown as { containerEl: HTMLElement }).containerEl;
  const names = () => [...root.querySelectorAll(".setting-item-name")].map((x) => x.textContent);
  const row = (name: string) =>
    [...root.querySelectorAll(".setting-item")].find((x) => x.querySelector(".setting-item-name")?.textContent === name)!;
  return { ...made, tab, root, names, row };
}

describe("SettingsTab", () => {
  it("not linked: link section offers 'Collega…'", async () => {
    const { names, row, ctx } = await open();
    expect(names()).toContain("Questo vault non è collegato.");
    (row("Questo vault non è collegato.").querySelector("button") as HTMLButtonElement).click();
    expect(ctx.openWelcome).toHaveBeenCalled();
    expect(names()).not.toContain("Scollega questo vault");
  });

  it("linked: server, user, vault, device name, add device, unlink and http warning", async () => {
    const { names, root } = await open({}, true);
    for (const n of ["Server", "Utente", "Vault", "Nome di questo dispositivo", "Aggiungi un dispositivo", "Scollega questo vault"]) {
      expect(names()).toContain(n);
    }
    expect(root.textContent).toContain("Connessione non cifrata.");
  });

  it("unlink asks for confirmation", async () => {
    const { row, ctx, server } = await open({}, true);
    (ctx.confirm as unknown as { mockResolvedValueOnce(v: boolean): void }).mockResolvedValueOnce(false);
    (row("Scollega questo vault").querySelector("button") as HTMLButtonElement).click();
    await flush();
    expect(ctx.confirm).toHaveBeenCalledWith(expect.objectContaining({ warning: true }));
    expect(server.link()).not.toBeNull();
    (row("Scollega questo vault").querySelector("button") as HTMLButtonElement).click();
    await flush();
    expect(server.link()).toBeNull();
  });

  it("shows the not-yet-active note and mode-dependent rows", async () => {
    const { root, names, row, store } = await open();
    expect(root.textContent).toContain("Queste impostazioni verranno usate quando il sync sarà attivo.");
    expect(names()).toContain("Pausa di scrittura per le note aperte");
    const select = row("Modalità").querySelector("select") as HTMLSelectElement;
    select.value = "periodic";
    select.dispatchEvent(new Event("change"));
    await flush();
    expect(store.get().sync.mode).toBe("periodic");
    expect(names()).toContain("Ogni quanti minuti");
    expect(names()).not.toContain("Pausa di scrittura per le note aperte");
  });

  it("numbers are clamped", async () => {
    const { row, store } = await open();
    const input = row("Pausa di scrittura per le note aperte").querySelector("input") as HTMLInputElement;
    input.value = "99";
    input.dispatchEvent(new Event("input"));
    await flush();
    expect(store.get().sync.liveDebounceSec).toBe(30);
  });

  it("invalid globs are reported and ignored", async () => {
    const { root, store } = await open();
    const area = root.querySelector("textarea") as HTMLTextAreaElement;
    area.value = "Archivio/**\n[bad\n";
    area.dispatchEvent(new Event("input"));
    await flush();
    expect(store.get().exclusions).toEqual(["Archivio/**"]);
    expect(root.textContent).toContain("Pattern non validi, ignorati: [bad");
  });

  it("iOS note only on iOS; config categories only without vault default", async () => {
    const a = await open({ isIos: true });
    expect(a.root.textContent).toContain("Su iPhone e iPad");
    const b = await open();
    expect(b.root.textContent).not.toContain("Su iPhone e iPad");
    expect(b.names()).not.toContain("Scorciatoie");
    const toggle = b.row("Usa le impostazioni del vault").querySelector('input[type="checkbox"]') as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await flush();
    expect(b.names()).toContain("Scorciatoie");
  });

  it("about shows version, release and protocol", async () => {
    const { names } = await open();
    expect(names()).toEqual(expect.arrayContaining(["Versione", "Rilascio", "Versione del protocollo"]));
  });
});
```

Aggiornare `test/settings.test.ts`: il test "shows version and codename" costruisce la scheda con `makeCtx()` (`new SettingsTab(app, plugin as never, ctx)`) e verifica ancora versione e "Ash".

- [ ] **Step 4: `SettingsTab`**

Run: `pnpm --filter @kamino/plugin add '@kamino/protocol@workspace:*'`.

`src/settings/SettingsTab.ts` (contenuto completo):

```ts
import { PROTOCOL_VERSION } from "@kamino/protocol";
import { PluginSettingTab, Setting, type App, type Plugin } from "obsidian";
import { APP_CODENAME, APP_VERSION } from "../build-info.js";
import { fmt } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import type { UiContext } from "../ui/context.js";
import { CLASS_PREFIX } from "../ui/status-classes.js";
import { CONFIG_CATEGORIES, validateGlob, type SyncMode } from "./model.js";

const P = `${CLASS_PREFIX}-settings`;

/** Full plugin settings (spec §6). Every change is saved right away, normalized. */
export class SettingsTab extends PluginSettingTab {
  private invalidGlobs: string[] = [];

  constructor(
    app: App,
    plugin: Plugin,
    private readonly ctx: UiContext,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl, ctx } = this;
    const m = t(ctx.lang).settings;
    const s = ctx.settings.get();
    const link = ctx.connection.link();
    containerEl.empty();
    containerEl.classList.add(P);
    const save = (fn: Parameters<typeof ctx.settings.update>[0], redraw = false) =>
      void ctx.settings.update(fn).then(() => {
        if (redraw) this.display();
      });
    const note = (text: string) => this.p(text);

    // 1. Link
    new Setting(containerEl).setName(m.link).setHeading();
    if (!link) {
      new Setting(containerEl).setName(m.notLinked).addButton((b) =>
        b
          .setButtonText(m.connect)
          .setCta()
          .onClick(() => void ctx.openWelcome()),
      );
    } else {
      new Setting(containerEl).setName(m.server).setDesc(link.host);
      if (link.server.startsWith("http:")) note(m.insecure);
      new Setting(containerEl).setName(m.user).setDesc(link.user);
      new Setting(containerEl).setName(m.vault).setDesc(link.vaultName);
      new Setting(containerEl).setName(m.deviceName).addText((text) => {
        text.setValue(link.deviceName);
        text.inputEl.addEventListener("blur", () => {
          const name = text.getValue().trim();
          if (name && name !== link.deviceName) void ctx.connection.renameDevice(name);
        });
      });
      new Setting(containerEl)
        .setName(m.addDevice)
        .setDesc(m.addDeviceDesc)
        .addButton((b) => b.setButtonText(m.addDevice).onClick(() => ctx.openAddDevice()));
      new Setting(containerEl)
        .setName(m.unlink)
        .setDesc(m.unlinkDesc)
        .addButton((b) =>
          b
            .setButtonText(m.unlink)
            .setWarning()
            .onClick(async () => {
              const ok = await ctx.confirm({
                title: m.unlinkTitle,
                text: m.unlinkText,
                confirmText: m.confirmUnlink,
                cancelText: m.cancel,
                warning: true,
              });
              if (!ok) return;
              await ctx.connection.unlink();
              this.display();
            }),
        );
    }

    // 2. Sync
    new Setting(containerEl).setName(m.sync).setHeading();
    if (!ctx.engineAvailable) note(m.notActive);
    new Setting(containerEl)
      .setName(m.mode)
      .setDesc(m.modeDesc)
      .addDropdown((d) => {
        for (const mode of ["live", "periodic", "manual"] as const) d.addOption(mode, m.modes[mode]);
        d.setValue(s.sync.mode).onChange((v) => save((x) => ({ ...x, sync: { ...x.sync, mode: v as SyncMode } }), true));
      });
    if (s.sync.mode === "live") {
      new Setting(containerEl)
        .setName(m.debounce)
        .setDesc(m.debounceDesc)
        .addText((text) => {
          text.inputEl.type = "number";
          text.setValue(String(s.sync.liveDebounceSec)).onChange((v) =>
            save((x) => ({ ...x, sync: { ...x.sync, liveDebounceSec: Number(v) } })),
          );
        });
    }
    if (s.sync.mode === "periodic") {
      new Setting(containerEl).setName(m.periodic).addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(s.sync.periodicMinutes)).onChange((v) =>
          save((x) => ({ ...x, sync: { ...x.sync, periodicMinutes: Number(v) } })),
        );
      });
    }

    // 3. Large files
    new Setting(containerEl).setName(m.largeFiles).setHeading();
    new Setting(containerEl)
      .setName(m.wifiOnly)
      .setDesc(m.wifiOnlyDesc)
      .addToggle((tg) =>
        tg.setValue(s.largeFiles.wifiOnly).onChange((v) => save((x) => ({ ...x, largeFiles: { ...x.largeFiles, wifiOnly: v } }))),
      );
    new Setting(containerEl).setName(m.threshold).addText((text) => {
      text.inputEl.type = "number";
      text.setValue(String(s.largeFiles.thresholdMb)).onChange((v) =>
        save((x) => ({ ...x, largeFiles: { ...x.largeFiles, thresholdMb: Number(v) } })),
      );
    });
    if (ctx.isIos) note(m.iosNote);

    // 4. Exclusions
    new Setting(containerEl).setName(m.exclusions).setHeading();
    const invalid = this.p("");
    const showInvalid = () => {
      invalid.textContent = this.invalidGlobs.length ? fmt(m.invalidGlobs, { list: this.invalidGlobs.join(", ") }) : "";
    };
    new Setting(containerEl)
      .setName(m.exclusions)
      .setDesc(m.exclusionsDesc)
      .addTextArea((area) => {
        area.setValue(s.exclusions.join("\n")).onChange((v) => {
          const lines = v.split("\n").map((l) => l.trim()).filter(Boolean);
          this.invalidGlobs = lines.filter((l) => !validateGlob(l));
          showInvalid();
          save((x) => ({ ...x, exclusions: lines.filter(validateGlob) }));
        });
      });
    containerEl.append(invalid);
    showInvalid();
    note(m.alwaysExcluded);

    // 5. Configuration folder
    new Setting(containerEl).setName(fmt(m.configDir, { dir: ctx.configDir })).setHeading();
    new Setting(containerEl).setName(m.useVaultDefault).addToggle((tg) =>
      tg
        .setValue(s.configDir.useVaultDefault)
        .onChange((v) => save((x) => ({ ...x, configDir: { ...x.configDir, useVaultDefault: v } }), true)),
    );
    if (!s.configDir.useVaultDefault) {
      for (const c of CONFIG_CATEGORIES) {
        new Setting(containerEl).setName(m.categories[c]).addToggle((tg) =>
          tg.setValue(s.configDir.categories[c]).onChange((v) =>
            save((x) => ({ ...x, configDir: { ...x.configDir, categories: { ...x.configDir.categories, [c]: v } } })),
          ),
        );
      }
    }
    note(m.configNote);

    // 6. About
    new Setting(containerEl).setName(m.about).setHeading();
    new Setting(containerEl).setName(m.version).setDesc(APP_VERSION);
    new Setting(containerEl).setName(m.release).setDesc(APP_CODENAME);
    new Setting(containerEl).setName(m.protocol).setDesc(String(PROTOCOL_VERSION));
  }

  private p(text: string): HTMLParagraphElement {
    const el = this.containerEl.ownerDocument.createElement("p");
    el.className = `${P}__note`;
    el.textContent = text;
    this.containerEl.append(el);
    return el;
  }
}
```

Run: `pnpm --filter @kamino/plugin test -- SettingsTab settings` → PASS.

- [ ] **Step 5: `main.ts`, stili, verifica, commit**

In `main.ts`: `confirm: (opts) => confirmDialog(this.app, opts),` e `this.addSettingTab(new SettingsTab(this.app, this, ctx));` (dopo la creazione di `ctx`).

Aggiungere a `src/styles.css`:

```css
.kamino-settings__note {
  margin: var(--size-4-1) 0 var(--size-4-3);
  color: var(--text-muted);
  font-size: var(--font-ui-small);
}
```

Run: `pnpm --filter @kamino/plugin test && pnpm --filter @kamino/plugin typecheck && pnpm --filter @kamino/plugin lint`

```bash
git add apps/plugin pnpm-lock.yaml
git commit -m "feat(plugin): add full settings tab and unlinking"
pnpm --filter @kamino/plugin build:vault
```

**Prova col committente** (desktop): pairing su una sola installazione — da collegato: impostazioni → "Aggiungi un dispositivo" → "Simula richiesta di collegamento (sviluppo)" → approva/rifiuta; chiudere la finestra prima della richiesta → notice + sezione nel pannello. Da non collegato: incollare il link mostrato da "Mostra QR di prova" nella scheda di benvenuto, poi "Simula approvazione (sviluppo)". Impostazioni: ogni sezione, scollega.

---

### Task 9: Documentazione, changeset, verifica finale

**Files:**
- Modify: `docs/ui/design-system.md`, `docs/renaming.md`, `docs/HANDOVER.md`
- Create: `.changeset/onboarding-pairing-settings.md`

- [ ] **Step 1: `docs/ui/design-system.md`** — nuova sezione "8. Collegamento, pairing e impostazioni": scheda di benvenuto (tre strade, quando si apre); collegamento manuale (passi, messaggi d'errore, regola `http`: avviso su desktop, blocco su telefono); riconciliazione prima del trasferimento; vista di trasferimento; pairing (quattro passi, codice di 4 caratteri, "approva solo se il codice coincide", notice e sezione "Richieste di collegamento" a finestra chiusa); impostazioni (sezioni, riga "verranno usate quando il sync sarà attivo"); comandi di sviluppo e credenziali di prova (`demo`/`demo`, `demo2fa`/`demo`/`123456`, `locked`, host `unreachable`/`old`, token `expired`/`used`/`bad`).
- [ ] **Step 2: `docs/renaming.md`** — aggiungere: azione del link `obsidian://` (`PROTOCOL_ACTION` = `PRODUCT_SLUG`): cambiandola i QR/link già generati non funzionano più (scadono comunque in 10 minuti); tipi di vista `kamino-welcome`, `kamino-transfer`.
- [ ] **Step 3: HANDOVER** — stato della sotto-fase 3, decisioni O1–O6, punti aperti (applicazione delle impostazioni e `engineAvailable` in M1; ricostruzione del server V-05 in M1; schermata web "aggiungi dispositivo" nella sotto-fase 4; prova su telefono di benvenuto, pairing reale con fotocamera e impostazioni).
- [ ] **Step 4: Changeset** `.changeset/onboarding-pairing-settings.md`:

```md
---
"@kamino/plugin": minor
---

Add the welcome view, manual linking with initial transfer, pairing by QR code or link with approval, and the full settings tab.
```

- [ ] **Step 5: Verifica completa e push**

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm release-names:check
docker build -q -f docker/Dockerfile --build-arg KAMINO_BUILD_COMMIT=local .
git add docs .changeset
git commit -m "docs: document onboarding, pairing and settings"
git push
```

Expected: tutto verde; CI verde. Poi revisione finale (un subagente) e PR.
