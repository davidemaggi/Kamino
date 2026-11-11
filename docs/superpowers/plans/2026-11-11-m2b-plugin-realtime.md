# M2b — Tempo reale nel plugin: piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **In questo progetto:** esecuzione nella sessione con _executing-plans_, a blocchi con checkpoint col committente (`CLAUDE.md`); una sola revisione finale con un subagente. Accelerazioni del 2026-11-11: `test:deep` gira in CI, in locale bastano i 150 scenari di `pnpm test`; sul PC Windows test un pacchetto alla volta (`pnpm --filter <pkg> test -- --maxWorkers=2`, `DOCKER_HOST=tcp://127.0.0.1:2375`).

**Goal:** le modifiche arrivano sugli altri dispositivi in pochi secondi (WebSocket), con modalità Live/Periodica/Manuale, allegati grossi solo in Wi-Fi, avvisi insistenti e i minori rinviati da M1d.

**Architecture:** nuova porta `SocketFactory` e client `Realtime` in `packages/sync-engine`: il socket è solo un campanello (`changes` → pull REST coalescente), `step()` non cambia. Il motore riceve modalità, rete e "eco" come input; il plugin fornisce gli adattatori (`WebSocket` del browser, `navigator.connection`, editor di Obsidian). I test del server usano `app.injectWS` come socket.

**Tech Stack:** TypeScript strict, `@kamino/sync-engine`, `@kamino/protocol` (`Hello`, `ClientMessage`, `ServerMessage`), Obsidian API, Vitest + fast-check, testcontainers.

**Spec:** `docs/superpowers/specs/2026-11-11-m2b-plugin-realtime-design.md` (F1–F10 e §6.1–6.11, vincolanti).

## Global Constraints

- Plugin: niente API Node/Electron; `WebSocket` del browser sì; su mobile solo `https://` e `wss://`.
- Il token va nel messaggio `hello`, mai nell'URL. Mai nei log: path, nomi, contenuti, token.
- `PROTOCOL_VERSION` resta 1; messaggi e codici solo quelli di M2a: `hello`/`welcome`/`changes`/`device_revoked`/`vault_settings_changed`/`error`/`ping`/`pong`; chiusure `4400 4401 4403 4404 4408 4409 4410 4426 1011`.
- Una modalità cambia solo *quando* si sincronizza, mai *cosa* (S-04); un socket caduto non rende mai "al sicuro" niente.
- Debounce: file aperto = `liveDebounceSec` (2–30 s, default 5 s); altri file = 1 500 ms fissi. Live con socket giù: pull ogni 5 min. `4409`: nuovo tentativo dopo 5 min con jitter. Silenzio del server oltre 75 s → chiusura e riconnessione. Eco: 10 s.
- Soglia allegati in Wi-Fi: `largeFiles.thresholdMb` (default 10 MB); avvisi: `DEFAULT_THRESHOLDS` (1 h, 24 h), notice ripetuta ogni ora.
- `sync-core` non cambia (se dovesse cambiare: `test:deep` in CI).

## Review Focus

1. Socket che si riconnette in loop serrato (server giù, `4409`, `4401` dopo revoca): il client deve rispettare il backoff e fermarsi sugli stop → test in Task 1 ("never reconnects faster than the backoff", "stops on 4401/4403/4426").
2. Notifiche perse durante una riconnessione: dopo `welcome` il client deve sempre fare un pull di recupero → test in Task 2 ("pulls after every (re)connection").
3. Cambio di modalità con un ciclo in corso: nessuna perdita, nessun doppio timer → test in Task 3 ("switching mode twice leaves one timer").
4. Eco che ingoia una modifica vera fatta nei 10 s → test in Task 4 ("a user edit right after an engine write is not an echo").
5. Rete che diventa a consumo a metà di un upload grande: l'upload in corso finisce, i successivi aspettano → test in Task 6 ("a network change mid-batch defers only the next files").

---

## Blocco A — Socket e notifiche

### Task 1: porta `SocketFactory` e client `Realtime`

**Files:** Create `packages/sync-engine/src/socket.ts`, `src/socket.test.ts`; Modify `src/index.ts`.

**Interfaces — Produces:**

```ts
export interface SocketConn { send(data: string): void; close(code?: number): void }
export interface SocketHandlers { onOpen(): void; onMessage(data: string): void; onClose(code: number): void }
/** Opens /api/v1/ws; a failure to connect is reported as onClose(1006). */
export type SocketFactory = (h: SocketHandlers) => SocketConn;
export type RealtimeEvent =
  | { type: "connected"; head: number } | { type: "disconnected" }
  | { type: "changes"; head: number } | { type: "settings" }
  | { type: "revoked" } | { type: "blocked" } | { type: "protocol" }
  | { type: "resync" } | { type: "check" };           // 4404 → the engine verifies via REST
export class Realtime {
  constructor(o: { socket: SocketFactory; clock: Clock; hello: () => Hello; onEvent(e: RealtimeEvent): void; log?(code: string): void });
  start(): void; stop(): void; readonly connected: boolean;
}
```

- [ ] Test (`socket.test.ts`, socket finto e `Clock` manuale): manda `hello` come primo messaggio; `welcome` → `connected` con `head`; `changes` → evento con `head` (le voci si ignorano); risponde `pong` a `ping`; `device_revoked` e chiusura `4401` → `revoked`, `4403` → `blocked`, `4426` → `protocol`, `4410` → `resync`, `4404` → `check` (e nessuna riconnessione dopo `revoked`/`blocked`/`protocol`); `vault_settings_changed` → `settings`; `4409` → riconnessione dopo 300 000 ms ± jitter; altre chiusure → riconnessione con `retryDelay(attempt, random)` di `sync-core`; "never reconnects faster than the backoff"; 75 s senza messaggi → chiusura e riconnessione; `stop()` chiude con `1000` e non riconnette.
- [ ] FAIL → implementa → PASS. Commit `feat(sync-engine): add a realtime socket client`.

### Task 2: notifiche nel motore

**Files:** Modify `packages/sync-engine/src/engine.ts`, `src/testing/fake-server.ts`, `src/engine.test.ts`.

**Interfaces — Consumes:** Task 1. **Produces:** `EngineDeps.socket?: SocketFactory`, `EngineDeps.client?: { pluginVersion: string; platform: string }`; `Engine.realtimeConnected: boolean`; `FakeServer.socket(deviceId): SocketFactory` (emette `welcome` e un `changes` a ogni commit; metodi di test `dropNext()`, `duplicateNext()`, `closeAll(code)`).

- [ ] Test: `changes` con `head` oltre il cursore → un pull; più notifiche durante un pull → **un** pull in più (coalescente); `head` non oltre il cursore → nessun pull; "pulls after every (re)connection"; `revoked`/`blocked`/`protocol` → `stopped`; `check` → `GET /device` e stop se `401`/`404`; `resync` → evento `resync` di `sync-core`; `settings` → `onSettingsChanged`; proprietà: notifiche perse, duplicate e riordinate + chiusure casuali → convergenza e nessun contenuto perso (stessa verifica del test di proprietà esistente).
- [ ] FAIL → implementa → PASS. Commit `feat(sync-engine): pull on realtime notifications`.

## Blocco B — Modalità, eco, file aperto

### Task 3: modalità

**Files:** Modify `packages/sync-engine/src/engine.ts`, `src/engine.test.ts`.

**Produces:** `type SyncMode = "live" | "periodic" | "manual"`; `Engine.setMode(mode: SyncMode, periodicMinutes: number): void`; `EngineDeps.mode?: { mode: SyncMode; periodicMinutes: number }` (default live, 15). Rimuove `PULL_PERIOD_MS`.

- [ ] Test (`Clock` manuale): Live = socket aperto, con socket giù pull ogni 300 000 ms; Periodica = nessun socket, ciclo ogni `periodicMinutes`, `localChange()` marca "in attesa" senza ciclo; Manuale = nessun ciclo spontaneo, `syncNow()` sì; in tutte `start()` fa un ciclo; "switching mode twice leaves one timer"; il cambio chiude il socket con `1000`.
- [ ] FAIL → implementa → PASS. Commit `feat(sync-engine): live, periodic and manual modes`.

### Task 4: eco

**Files:** Create `packages/sync-engine/src/echo.ts`, `src/echo.test.ts`; Modify `src/engine.ts`; Modify `apps/plugin/src/engine/watcher.ts`, `watcher.test.ts`.

**Produces:** `class EchoGuard { record(path: string, stat: { size: number; mtime: number } | null): void; isEcho(path: string, stat: { size: number; mtime: number } | null): boolean }` (finestra 10 s, `Clock`); `Engine.isEcho(path, stat)`; il `Watcher` riceve `isEcho` e ignora quegli eventi (lo `stat` lo legge dall'adapter).

- [ ] Test: dopo una scrittura del motore l'evento con lo stesso stat è eco; "a user edit right after an engine write is not an echo" (mtime o size diversi); dopo 10 s niente è eco; rename/cestino/cartelle registrano il path (stat `null` = non esiste più).
- [ ] FAIL → implementa → PASS. Commit `feat(sync): ignore vault events caused by the engine itself`.

### Task 5: file aperto con modifiche non salvate

**Files:** Modify `apps/plugin/src/engine/obsidian-fs.ts`, `obsidian-fs.test.ts`, `apps/plugin/src/__mocks__/obsidian.ts` (vista Markdown con `file.path` ed `editor.getValue()`).

- [ ] Test: file aperto con buffer diverso dal disco → `write` restituisce `changed` e il disco non cambia; buffer uguale → scrittura normale; file non aperto → normale.
- [ ] FAIL → implementa (prima della scrittura: le viste `markdown` aperte su quel path; buffer ≠ contenuto su disco → `changed`) → PASS. Commit `fix(plugin): never overwrite a note with unsaved edits`.

## Blocco C — Reti a consumo e avvisi

### Task 6: rete

**Files:** Create `packages/sync-engine/src/network.ts`; Modify `src/engine.ts`, `src/status.ts`, test; Create `apps/plugin/src/engine/obsidian-network.ts`, test; Create `apps/plugin/src/ui/MeteredModal.ts`; i18n it/en.

**Produces:** `interface Network { kind(): "free" | "metered" | "ask"; ask(): Promise<boolean> }`; `EngineDeps.network?: Network`, `EngineDeps.wifiOnly?: () => { enabled: boolean; thresholdBytes: number }`; `DeferredFile.reason?: "network" | "size" | "unreadable"`; `Engine.transferNow(path: string): Promise<void>` (sblocca il path una volta e fa un ciclo); `ObsidianNetwork` (`navigator.connection`: `cellular`/`saveData` → metered, `wifi`/`ethernet` → free; iOS → `ask` con "non chiedere più per questa sessione"; desktop → free; Android senza info → free).

- [ ] Test motore: rete a consumo + file oltre soglia → upload e download rimandati con `reason: "network"`, note e file sotto soglia passano; `ask` → una sola domanda per ciclo, risposta sì vale per la sessione; "a network change mid-batch defers only the next files"; `transferNow` sblocca solo quel path; i rimandati per rete tengono lo stato non "al sicuro".
- [ ] Test plugin: mappa di `navigator.connection`, iOS, desktop; la finestra salva "non chiedere più" per la sessione.
- [ ] FAIL → implementa → PASS. Commit `feat(sync): large attachments only on Wi-Fi`.

### Task 7: avvisi insistenti

**Files:** Create `apps/plugin/src/state/insistent-notices.ts`, test; Modify `apps/plugin/src/main.ts`; i18n it/en.

**Produces:** `class InsistentNotices { constructor(o: { source: SyncStateSource; clock: () => number; notice(msg: string): void; lang: Lang }); start(): () => void }`.

- [ ] Test (orologio finto): livello Attenzione o peggio oltre soglia → notice subito, poi ogni 3 600 000 ms; stato migliorato → si azzera; solo rimandati per rete → nessuna notice; Decisione `deletions` → notice.
- [ ] FAIL → implementa → PASS. Commit `feat(plugin): repeat warnings until the problem is gone`.

## Blocco D — Minori rinviati da M1d

### Task 8: adattatori (M1, M2, M4, M5, M8-pulizia)

**Files:** Modify `apps/plugin/src/engine/obsidian-fs.ts`, `obsidian-http.ts`, test.

- [ ] Test: sostituzione = vecchio file spostato in `<pluginDir>/tmp/<n>.old`, nuovo rinominato al suo posto, `.old` rimosso; all'apertura un `.old` senza originale torna al suo posto e i `.part` orfani si cancellano (M1, M8); rinomina di sole maiuscole riesce via nome temporaneo (M2); streaming: un fetch fallito ricade su `readBinary` solo per quel file, disattivato dopo 3 fallimenti su file esistenti, byte letti ≠ `stat.size` → ripiego (M4); `ObsidianHttp` su mobile rifiuta `http:` (M5).
- [ ] FAIL → implementa → PASS. Commit `fix(plugin): safer replacements, case renames and streaming fallback`.

### Task 9: motore, host e UI (M3, M6, M7, M8-attesa, M9, M10)

**Files:** Modify `packages/sync-engine/src/scanner.ts`, `engine.ts`; `apps/plugin/src/engine/host.ts`, `connection/real-server.ts`, `connection/real-transfer.ts`, `main.ts`; test.

- [ ] Test: file con mtime più recente di 2 000 ms rihashato anche se la cache coincide; `write`/`trash` con esito `changed` invalidano la voce di cache (M3); `Engine.open` fallito → l'host ritenta con backoff (M6); login: 5xx → `unreachable`, 426 → nuovo motivo `update_required` con testo "aggiorna il plugin" (M7); `onunload` attende `host.stop()` (M8); trasferimento iniziale `done` anche con rimandati, con il loro numero (M9, nuovo campo `TransferProgress.waiting`); modifica delle impostazioni → `effectiveLocally` applicato subito, poi la risposta del server (M10).
- [ ] FAIL → implementa → PASS. Commit `fix(sync): smaller fixes from the m1d review`.

## Blocco E — Server vero

### Task 10: tempo reale contro il server

**Files:** Modify `apps/server/test/helpers/engine.ts` (`injectSocket(getApp): SocketFactory` su `app.injectWS("/api/v1/ws")`); Create `apps/server/test/engine-realtime.test.ts`.

- [ ] Test: A e B in Live; modifica su A → arriva su B senza `syncNow` (aspettando l'evento, timeout 10 s); revoca di B dal web mentre è connesso → B fermo; server riavviato → riconnessione e convergenza; compattazione con B connesso ma indietro → `4410` → resync e convergenza.
- [ ] Commit `test(server): realtime sync between two engines`.

## Blocco F — Plugin

### Task 11: socket, modalità e D-07 nel plugin

**Files:** Create `apps/plugin/src/engine/obsidian-socket.ts`, test; Modify `engine/host.ts`, `main.ts`, `ui/ConnectModal.ts` (passo "Riconciliazione" sul flusso vero), test.

- [ ] Test: `ObsidianSocket` converte l'URL del server in `wss://`/`ws://` + `/api/v1/ws`, su mobile rifiuta `ws://`; l'host passa socket, rete, modalità e `wifiOnly` al motore e chiama `setMode` quando cambiano le impostazioni; il watcher usa il debounce `liveDebounceSec` per il file aperto; `ConnectModal` col server vero mostra il passo "Riconciliazione" quando il vault locale ha file e parte solo dopo la conferma.
- [ ] Commit `feat(plugin): realtime sync, modes and joining a vault with local files`.

## Blocco G — Chiusura

### Task 12

- [ ] `docs/03-sync-protocol.md` §8.2 (socket come campanello, modalità, eco, rete), `docs/spikes/README.md` (test D-6: scrittura remota sulla nota aperta; R-2 col motore vero), `HANDOVER` (decisioni F1–F10, stato), changeset `@kamino/plugin` minor.
- [ ] Verifica completa (build, typecheck, lint, format, test per pacchetto, `test:deep` una volta); revisione finale con **un** subagente; correzioni con test; PR (testo pronto se `gh` non è autenticato).
