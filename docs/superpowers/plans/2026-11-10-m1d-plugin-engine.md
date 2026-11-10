# M1d — Motore di sync del plugin: piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **In questo progetto:** esecuzione nella sessione con _executing-plans_, senza checkpoint tra i blocchi (scelta del committente, 2026-11-10); una sola revisione finale con un subagente.

**Goal:** il plugin sincronizza davvero un vault con il server: scansione, watcher, outbox durevole, upload/download (in streaming dove possibile), collegamento e stato veri.

**Architecture:** un pacchetto puro-TS `packages/sync-engine` esegue gli effetti di `step()` di `sync-core` su due porte (`VaultFs`, `Http`). Il plugin fornisce gli adattatori Obsidian; i test di integrazione del server usano un `MemoryFs` e un `Http` che parla con il server vero (Fastify `inject`).

**Tech Stack:** TypeScript strict, `@kamino/sync-core`, `@kamino/protocol`, `@kamino/status`, `@noble/hashes` (SHA-256 incrementale), Obsidian API (`requestUrl`, `vault.adapter`), Vitest + fast-check, testcontainers per l'integrazione.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-11-10-m1d-plugin-engine-design.md` (E1–E10).
- Plugin: niente API Node/Electron (`isDesktopOnly: false`); solo API di Obsidian, `requestUrl`, `fetch` sugli URL delle risorse, WebCrypto, `@noble/hashes`. Stato locale nella cartella del plugin, scritture atomiche. HTTPS obbligatorio su mobile.
- `sync-engine` non importa `obsidian` né moduli Node: gira nel plugin e nei test del server.
- Mai nei log: path, nomi, contenuti, token.
- Il client considera "al sicuro" solo ciò che il server ha confermato; ogni op ha il suo `opId`.
- Nuovo pacchetto → `docker/Dockerfile` (COPY del `package.json` prima di `pnpm install`).
- Commit con `/tmp/kamino-tools/commit.sh`; `pnpm --filter @kamino/sync-core test:deep` dopo ogni modifica del client.

## File

| File | Responsabilità |
|---|---|
| `packages/sync-engine/src/ports.ts` | `VaultFs`, `Http`, `Clock` |
| `packages/sync-engine/src/memory-fs.ts` | `VaultFs` in memoria (test, integrazione) |
| `packages/sync-engine/src/hash.ts` · `scanner.ts` | SHA-256 incrementale; scanner con `StatCache` |
| `packages/sync-engine/src/api.ts` | rotte tipizzate, errori (`ApiError`: `network`, `revoked`, `blocked`, `protocol`, `http`) |
| `packages/sync-engine/src/transfers.ts` | upload a chunk con ripresa, download a pezzi |
| `packages/sync-engine/src/engine.ts` | coda di eventi → `step()`, esecutore degli effetti, cicli, retry, stato |
| `packages/sync-engine/src/status.ts` | `SyncSnapshot` derivato |
| `packages/sync-core/src/client.ts` | cartelle (Z9) |
| `apps/server/test/helpers/engine.ts` · `engine-*.test.ts` | integrazione col server vero |
| `apps/plugin/src/engine/obsidian-fs.ts` · `obsidian-http.ts` | adattatori |
| `apps/plugin/src/connection/real-server.ts` | `ConnectionService`, `InitialTransfer` veri |
| `apps/plugin/src/state/engine-state.ts` | `SyncStateSource` dal motore |

---

## Blocco A — `sync-engine`

### Task 1: pacchetto, porte, `MemoryFs`, hash

**Files:** Create `packages/sync-engine/{package.json,tsconfig.json,vitest.config.ts,src/index.ts,src/ports.ts,src/memory-fs.ts,src/hash.ts,src/memory-fs.test.ts}`; Modify `docker/Dockerfile`.

**Interfaces — Produces:**

```ts
export interface FsEntry { path: string; kind: "file" | "folder"; size: number; mtime: number }
export type WriteOutcome = "ok" | "changed"; // changed = expect not met, nothing written
export interface VaultFs {
  list(): Promise<FsEntry[]>;
  stat(path: string): Promise<{ size: number; mtime: number; kind: "file" | "folder" } | null>;
  read(path: string): AsyncIterable<Uint8Array>;
  /** Writes atomically if the current content hash is `expect` (null = must not exist). */
  write(path: string, parts: AsyncIterable<Uint8Array>, expect: string | null, hashOf: (p: string) => Promise<string | null>): Promise<WriteOutcome>;
  rename(from: string, to: string): Promise<boolean>;
  trash(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  rmdirIfEmpty(path: string): Promise<boolean>;
  loadState(name: string): Promise<string | null>;
  saveState(name: string, data: string): Promise<void>;
}
export interface HttpRequest { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; json?: unknown; body?: Uint8Array; headers?: Record<string, string> }
export interface HttpResponse { status: number; json?: unknown; body?: Uint8Array }
export interface Http { request(r: HttpRequest): Promise<HttpResponse> } // throws only on network failure
export interface Clock { now(): number; sleep(ms: number): Promise<void>; random(): number }
export async function sha256Hex(parts: AsyncIterable<Uint8Array>): Promise<string>;
export class MemoryFs implements VaultFs { files: Map<string, { data: Uint8Array; mtime: number }>; folders: Set<string>; state: Map<string, string>; trashed: string[]; /* + helpers: put(path, text), text(path) */ }
```

- [ ] Test (`memory-fs.test.ts`): write con `expect` corretto/sbagliato, rename su destinazione occupata → `false`, trash, `rmdirIfEmpty`, stato salvato/letto, `sha256Hex` su più pezzi = hash del tutto.
- [ ] FAIL → implementa → PASS. `package.json`: `name: "@kamino/sync-engine"`, `private: true`, dipendenze `@kamino/protocol`, `@kamino/sync-core`, `@kamino/status`, `@noble/hashes`; script `build`/`typecheck`/`lint`/`test` come `sync-core`; aggiungi a `.changeset/config.json` → `ignore`.
- [ ] Commit `feat(sync-engine): add ports, an in-memory vault and hashing`.

### Task 2: scanner con cache degli stat

**Files:** Create `src/scanner.ts`, `src/scanner.test.ts`.

**Produces:** `class Scanner { constructor(fs: VaultFs, cache: StatCache); scan(): Promise<ScanItem[]> }` (solo file, cartelle a parte in `folders(): string[]` per il Task 5); `StatCache` = `Record<path, { size, mtime, hash }>` serializzabile; file illeggibile → escluso dalla scansione e segnalato in `unreadable: string[]` (lo stato lo mostra). Path canonici NFC (`normalizePath` di `sync-core`).

- [ ] Test: secondo scan senza modifiche non rilegge i file (spia su `read`); file modificato (mtime/size) rilettto; file sparito tolto dalla cache.
- [ ] FAIL → implementa → PASS → commit `feat(sync-engine): scan the vault with a stat cache`.

### Task 3: API e trasferimenti

**Files:** Create `src/api.ts`, `src/transfers.ts`, `src/api.test.ts`.

**Produces:**

```ts
export class ApiError extends Error { kind: "network" | "revoked" | "blocked" | "protocol" | "cursor_too_old" | "http"; status?: number; code?: string }
export class Api {
  constructor(http: Http, token: () => string | null);
  // device-auth routes (enrollment) and device routes, typed with @kamino/protocol schemas
  login(u: string, p: string, totp?: string): Promise<DeviceLoginResponse>;
  enrollVaults(enroll: string): Promise<EnrollVaultList>; createVault(enroll: string, name: string): Promise<{ id: string; name: string }>;
  link(enroll: string, vaultId: string, d: LinkDeviceRequest): Promise<LinkDeviceResponse>;
  renameDevice(name: string): Promise<void>; unlink(): Promise<void>;
  missing(vaultId: string, hashes: string[]): Promise<string[]>;
  commit(vaultId: string, ops: Op[]): Promise<CommitResponse>;
  changes(vaultId: string, after: number): Promise<ChangesResponse>; // 410 → ApiError("cursor_too_old")
  snapshot(vaultId: string): Promise<Snapshot>;
  ack(vaultId: string, seq: number): Promise<void>; status(vaultId: string, r: DeviceStatusReport): Promise<void>;
  vaultSettings(): Promise<SyncSettings>; deviceSettings(): Promise<DeviceSettings>;
}
export class Transfers {
  constructor(api: Api, http: Http, fs: VaultFs, saveSessions: (s: UploadSessions) => Promise<void>);
  upload(vaultId: string, path: string, hash: string, size: number, onBytes: (n: number) => void): Promise<void>; // resumes a saved session (GET status, missing chunks only)
  download(vaultId: string, hash: string, size: number, onBytes: (n: number) => void): AsyncIterable<Uint8Array>; // 4 MiB Range requests
}
```

Mappa errori: rete → `network`; `401 device_revoked` → `revoked`; `403 user_blocked` → `blocked`; `426` → `protocol`; altro ≥ 400 → `http` con `code`.

- [ ] Test con un `Http` finto: intestazioni (`kamino-protocol`, Bearer), mappa errori, ripresa dell'upload (chunk già ricevuti non rinviati), download a più pezzi.
- [ ] FAIL → implementa → PASS → commit `feat(sync-engine): add the typed api and resumable transfers`.

### Task 4: motore

**Files:** Create `src/engine.ts`, `src/status.ts`, `src/engine.test.ts`.

**Produces:**

```ts
export interface EngineDeps { fs: VaultFs; http: Http; clock: Clock; newId(): string; config: ClientConfig; vaultId: string; token: () => string | null; log?: (code: string) => void }
export class Engine {
  static async open(d: EngineDeps): Promise<Engine>; // loads durable + stat cache + upload sessions
  start(): void;                 // first cycle, then periodic pull every 60 s (clock.sleep)
  stop(): Promise<void>;
  syncNow(): Promise<void>;      // resolves when the cycle is idle again
  localChange(): void;           // debounced by the caller (plugin); schedules a cycle
  localRename(from: string, to: string): void;
  setSettings(s: SyncSettings): void;
  snapshot(): SyncSnapshot;      // @kamino/status
  pending(): PendingChange[]; deferred(): DeferredFile[]; conflicts(): { id: string; fileId: string }[];
  onChange(cb: () => void): () => void;
  readonly stopped: null | "revoked" | "blocked" | "protocol" | "update_required";
}
```

Ciclo e regole:
1. Un solo `step()` alla volta (coda); dopo ogni `step` il primo effetto `persist` salva `durable` (atomico) **prima** degli altri.
2. Effetti di file in ordine (Z11), ognuno col suo evento (`written` con l'hash, `renamed`, `trashed`); il `sync` con la scansione parte solo a effetti di file completati.
3. `push` → `missing` → `upload` dei mancanti → `commit` → evento `pushResult`; `pull` → `changes` → `pullResult` (`cursor_too_old` → effetto `snapshot` alla prossima richiesta); `snapshot` → `snapshotResult`; `ack` → `api.ack`; errori di rete → `networkError` e nuovo tentativo dopo `retryDelay(attempt, random)`.
4. `write`: `download` → `fs.write(path, parts, expect)`; hash verificato durante la scrittura (stream) → `written { ok }`.
5. `revoked`/`blocked`/`protocol` fermano il motore (`stopped`) e notificano.
6. Stato: `queued` = op non confermate (`sent` + modifiche locali non ancora inviate), `oldestQueuedAt`, `lastConfirmedAt`, `unreachableSince`, `syncing`, `conflicts`, `blocked`.
7. Dopo ogni ciclo: `api.status(...)` con `pendingOps`, `pendingBytes`, `deferredFiles`.

- [ ] Test con `MemoryFs` e un server finto in memoria basato su `MemoryStore` di `sync-core` (adattatore `Http` → `MemoryStore`): un file creato arriva sul server; uno remoto viene scritto; rete giù → `unreachableSince`, poi ripresa; `revoked` ferma; **proprietà**: sequenze casuali di modifiche locali, crash (si ricrea `Engine.open` dallo stato salvato in un punto casuale) e cicli → alla fine il server e il vault coincidono e nessun contenuto creato è perso.
- [ ] FAIL → implementa → PASS → commit `feat(sync-engine): run sync-core effects with retries and status`.

---

## Blocco B — Cartelle in `sync-core`

### Task 5: cartelle sul client (Z9)

**Files:** Modify `packages/sync-core/src/client.ts`, `client.test.ts`, `sim/world.ts`.

Comportamento:
- `ScanItem` acquista `kind?: "file" | "folder"` (default file); `Entry` acquista `kind`.
- Cartella nuova in locale (vuota o no) → op `mkdir`; cartella sparita in locale senza figli vivi nell'indice → op `delete` (base `null`), dopo le cancellazioni dei figli nello stesso lotto.
- Rinomina di cartella vista dal watcher → `move` della cartella + `move` di ogni discendente (il server tiene i path piatti).
- Voci remote: `folder_created` → effetto `mkdir`; `folder_deleted` → effetto `rmdir` (solo se vuota; altrimenti resta, nessuna perdita); `file_moved` su una cartella → `rename`.
- Nuovi effetti `{ type: "mkdir"; path }`, `{ type: "rmdir"; path }` con evento `{ type: "folderDone"; path; ok }`.
- Il simulatore genera anche cartelle (crea, sposta con figli, cancella vuote) e verifica che nessun file vada perso e che le cartelle convergano.

- [ ] Test unità per ciascun caso sopra; `test:deep` (3000 scenari) verde.
- [ ] Commit `feat(sync-core): sync folders on the client`.

---

## Blocco C — File grandi (porte)

### Task 6: streaming nel contratto del motore

**Files:** Modify `packages/sync-engine/src/transfers.ts`, `engine.ts`, test.

- Upload: `fs.read(path)` a pezzi → chunk da `chunkSize` del server senza tenere il file intero (si ricompone il pezzo corrente); hash calcolato in streaming nello scanner.
- Download: `fs.write(path, download(...), expect)`: il motore non bufferizza mai il file intero.
- `EngineDeps.limits?: { maxInMemoryBytes?: number }`: se l'adattatore dichiara `fs.streaming === false` e il file supera il limite → il file resta "rimandato" (`deferred()`), mai perso.

- [ ] Test con `MemoryFs` instrumentato (picco di byte in memoria per file da 20 MB con chunk da 4 MiB < 3 chunk); file rimandato oltre il limite con `streaming = false`.
- [ ] Commit `feat(sync-engine): stream large files and defer them when streaming is unavailable`.

---

## Blocco D — Integrazione col server vero

### Task 7: motore contro il server

**Files:** Create `apps/server/test/helpers/engine.ts`, `apps/server/test/engine-flow.test.ts`, `apps/server/test/engine-crash.test.ts`; Modify `apps/server/package.json` (devDependency `@kamino/sync-engine`), `apps/server/test/helpers/app.ts` (opzione `chunkSize`).

`helpers/engine.ts`: `injectHttp(getApp: () => FastifyInstance): Http` (traduce in `app.inject`, `/api/v1` come prefisso, corpo binario); `deviceEngine(t, device, fs)`.

- [ ] `engine-flow.test.ts`: onboarding di un vault da 2.000 file (contenuti piccoli, chunk 64 KiB) → tutti confermati, `snapshot` del server = vault; secondo dispositivo con vault vuoto → riceve tutto identico; modifica su A → arriva su B al pull; server spento → stato "non raggiungibile", poi ripresa; `cursor_too_old` (compattazione + dispositivo assente) → snapshot e convergenza.
- [ ] `engine-crash.test.ts` (uscita di M1): fast-check su punti di crash del client (si butta l'`Engine` e si riapre dallo stato in `MemoryFs`) e del server (`app.close()` e nuovo `testApp` sullo stesso DB e cartelle) durante l'upload iniziale di 200 file → alla fine nessun file perso, server = vault, nessun duplicato.
- [ ] Commit `test(server): drive the real sync engine against the server`.

---

## Blocco E — Plugin

### Task 8: adattatori Obsidian

**Files:** Create `apps/plugin/src/engine/obsidian-fs.ts`, `obsidian-http.ts`, test; Modify `apps/plugin/src/__mocks__/obsidian.ts` (adapter in memoria con `appendBinary` opzionale e `getResourcePath`).

- `ObsidianFs`: `list` da `adapter.list` ricorsivo (esclusa la cartella del plugin, gestita da `sync-core`), `read` = `fetch(getResourcePath)` a pezzi con ripiego su `readBinary` (rilevato una volta: `streaming` = esito), `write` = file temporaneo nella cartella del plugin con `appendBinary` (se presente) o `writeBinary`, verifica hash, `adapter.rename` atomico; `trash` = `app.vault.trash(file, true)` (cestino di sistema) con ripiego `adapter.trashLocal`; stato in `<pluginDir>/state/*.json` con tmp + rename.
- `ObsidianHttp`: `requestUrl({ url, method, headers, body, throw: false })`; eccezione = rete.
- [ ] Test sui mock: ripiego senza `appendBinary`; scrittura con `expect` sbagliato → `changed`; stato atomico.
- [ ] Commit `feat(plugin): add obsidian adapters for the sync engine`.

### Task 9: collegamento e trasferimento veri

**Files:** Create `apps/plugin/src/connection/real-server.ts`, test; Modify `apps/plugin/src/main.ts`, `settings/store.ts` (server, token, vaultId, deviceId salvati nella cartella del plugin).

- `RealConnection implements ConnectionService` con `Api`; `checkServer` = `GET /version` (HTTPS obbligatorio su mobile → errore dedicato); `login` (TOTP, `totp_mandatory` → errore con messaggio); `startPairing`/`claim`… → errore "in arrivo" (M6).
- `RealTransfer implements InitialTransfer`: avanzamento dal motore (file/byte del primo ciclo), pausa = `engine.stop()`, ripresa = `start()`.
- `main.ts`: `const server = DEV && settings.useFake ? new FakeServer(…) : new RealConnection(…)`.
- [ ] Test con `Http` finto; commit `feat(plugin): link devices and transfer the vault with the real server`.

### Task 10: stato vero e watcher

**Files:** Create `apps/plugin/src/state/engine-state.ts`, `apps/plugin/src/engine/watcher.ts`, test; Modify `main.ts`, `ui/ConflictView.ts`/`BulkResolveModal.ts` (azioni "in arrivo" in produzione).

- `EngineState implements SyncStateSource, ConflictActions` (risoluzione → notice "in arrivo", M3; `syncNow` → motore).
- `Watcher`: `vault.on("create"|"modify"|"delete"|"rename")` → debounce (5 s per il file attivo, 1,5 s per gli altri) → `engine.localChange()`; `rename` → `engine.localRename`. `workspace.on("resize")`/`visibilitychange` (resume su mobile) → ciclo.
- [ ] Test con il mock di Obsidian (eventi → chiamate debounced; resume); commit `feat(plugin): show the real sync status and watch the vault`.

---

## Blocco F — Impostazioni e build di produzione

### Task 11: impostazioni

**Files:** Create `apps/plugin/src/engine/settings-map.ts`, test; Modify `main.ts`, `engine.ts` (`setSettings` alla voce `vault_settings_changed`).

- Mappa `core→base`, `appearance→appearance`, `hotkeys→hotkeys`, `enabledPlugins→pluginList`, `installedPlugins→plugins`; "usa il default del vault" → `override: null`.
- All'avvio: `GET /device/settings` → `effective` in `config`; cambio da UI → `PUT /device/settings`; voce `vault_settings_changed` → rilettura; cambio di categorie della configurazione → notice "ricarica Obsidian" (S-12).
- [ ] Test della mappa e del flusso; commit `feat(plugin): sync settings with the server`.

### Task 12: build di produzione

**Files:** Create `apps/plugin/test/bundle.test.ts`.

- [ ] Test: dopo `pnpm --filter @kamino/plugin build`, `dist/main.js` non contiene `FakeServer` né le credenziali `demo`; contiene `requestUrl`. Commit `test(plugin): keep the fake server out of production builds`.

---

## Blocco G — Chiusura

### Task 13

- [ ] Documenti: `03` (note di implementazione del guscio: streaming, pull periodico, cartelle), `HANDOVER` (decisioni E1–E10, stato, punti aperti), `docs/spikes/README.md` con **l'elenco dei test da eseguire sui dispositivi** (R-1 col motore vero: file da 50/200/500 MB su iPhone e Android, misura di memoria e tempi e verifica dello streaming; R-4: resume e cambio di rete con il pull periodico; R-5: spostamento di una cartella da 2.000 file; prova d'uso di una settimana desktop + telefono; R-2/R-3 con M2b/M3).
- [ ] Changeset (`@kamino/plugin` minor, `@kamino/server` patch se toccato).
- [ ] Verifica completa (build, typecheck, lint, format, test non in cache, `test:deep`); prova del plugin in Obsidian desktop con il server Docker (vault di prova `vault/kamino` con `build:vault`): collegamento, upload, modifica, stato.
- [ ] Revisione finale con **un** subagente; correzioni con test; PR; attesa del merge.
