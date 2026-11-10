# M2a — Tempo reale sul server: piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **In questo progetto:** esecuzione nella sessione con _executing-plans_, a blocchi con checkpoint col committente; una sola revisione finale con un subagente (CLAUDE.md).

**Goal:** il server spinge le modifiche ai dispositivi in tempo reale (WebSocket + LISTEN/NOTIFY), compatta il journal, espone dispositivi e impostazioni.

**Architecture:** il commit emette `pg_notify` nella sua transazione; una connessione `LISTEN` (con la riconnessione di postgres-js) sveglia un hub in memoria per vault; ogni socket legge dal journal le voci dopo il proprio cursore inviato, una pagina alla volta. pg-boss esegue compattazione e pulizia degli upload. Livelli di dispositivo e vault da un'unica funzione.

**Tech Stack:** Fastify 5, `@fastify/websocket` 11 (`ws` 8), postgres-js `listen`, pg-boss 12, Drizzle, zod, Vitest + testcontainers.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-11-10-m2a-realtime-design.md` (D1–D8).
- `PROTOCOL_VERSION` resta **1**.
- Mai nei log: token, path, nomi, contenuti; solo codici e id. Path e impostazioni cifrati nel DB (`k_meta`, AAD `tabella ‖ colonna ‖ riga`).
- Nessun bypass per l'admin sulle rotte di contenuto; la proprietà si controlla sempre.
- TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`); codice e commenti in inglese; documenti in italiano.
- Commit con `/tmp/kamino-tools/commit.sh "<msg>" <percorsi>` (formato + commitlint: soggetto minuscolo, ≤ 100 caratteri).
- Nuovo pacchetto del workspace → `docker/Dockerfile` (nessuno previsto).

## File

| File | Responsabilità |
|---|---|
| `packages/protocol/src/ws.ts` | messaggi WebSocket, `ClientMessage`/`ServerMessage` |
| `packages/protocol/src/settings.ts` | `ConfigCategory`, `SyncSettings`, `DeviceSettings`, `VAULT_EVENT_ID` |
| `packages/sync-core/src/exclusions.ts` | default S-10 (nessuna categoria) |
| `apps/server/src/realtime/hub.ts` | connessioni per vault/dispositivo, risveglio, chiusure |
| `apps/server/src/realtime/listener.ts` | `LISTEN` con risveglio totale a ogni (ri)connessione |
| `apps/server/src/realtime/socket.ts` | macchina a stati di un socket |
| `apps/server/src/routes/ws.ts` | rotta `/ws` |
| `apps/server/src/jobs/boss.ts` · `jobs/compact.ts` | pg-boss; compattazione |
| `apps/server/src/devices/level.ts` · `devices/service.ts` | livelli; elenco/rinomina/revoca |
| `apps/server/src/routes/devices.ts` | rotte web e plugin dei dispositivi |
| `apps/server/src/vaults/settings.ts` · `routes/settings.ts` | impostazioni cifrate e rotte |

---

## Blocco A — Contratto

### Task 1: messaggi WebSocket e impostazioni in `@kamino/protocol`

**Files:**
- Create: `packages/protocol/src/ws.ts`, `packages/protocol/src/settings.ts`, `packages/protocol/src/ws.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces — Produces:** `ClientMessage`, `ServerMessage`, `Hello`, `WS_PAGE = 500`, `CONFIG_CATEGORIES`, `ConfigCategory`, `SyncSettings`, `DeviceSettings`, `VAULT_EVENT_ID = "_vault"`, `DEFAULT_SYNC_SETTINGS`.

- [ ] **Step 1: test** (`ws.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { ClientMessage, ServerMessage, SyncSettings, DEFAULT_SYNC_SETTINGS } from "./index.js";

describe("ws messages", () => {
  it("parses every client message and rejects unknown types", () => {
    const hello = {
      type: "hello",
      deviceToken: "t".repeat(43),
      protocol: { min: 1, max: 1 },
      cursor: 0,
      pluginVersion: "0.1.0",
      platform: "macos",
    };
    expect(ClientMessage.parse(hello).type).toBe("hello");
    expect(ClientMessage.parse({ type: "ack", seq: 3 }).type).toBe("ack");
    expect(
      ClientMessage.parse({ type: "status", pendingOps: 0, pendingBytes: 0, deferredFiles: 0 })
        .type,
    ).toBe("status");
    expect(ClientMessage.parse({ type: "pong" }).type).toBe("pong");
    expect(ClientMessage.safeParse({ type: "nope" }).success).toBe(false);
  });
  it("parses server messages", () => {
    expect(ServerMessage.parse({ type: "changes", entries: [], head: 0, hasMore: false }).type).toBe(
      "changes",
    );
    expect(ServerMessage.parse({ type: "error", code: "cursor_too_old", message: "x" }).type).toBe(
      "error",
    );
  });
  it("settings: S-10 default syncs no config category; bounded patterns", () => {
    expect(Object.values(DEFAULT_SYNC_SETTINGS.config).every((v) => !v)).toBe(true);
    expect(SyncSettings.safeParse({ ...DEFAULT_SYNC_SETTINGS, patterns: ["x".repeat(501)] }).success).toBe(false);
  });
});
```

- [ ] **Step 2:** `pnpm --filter @kamino/protocol exec vitest run src/ws.test.ts` → FAIL (moduli mancanti).
- [ ] **Step 3: implementazione**

`settings.ts`:

```ts
import { z } from "zod";

/** Categories of the configuration folder (03 §11, S-10). */
export const CONFIG_CATEGORIES = ["base", "appearance", "hotkeys", "pluginList", "plugins"] as const;
export const ConfigCategory = z.enum(CONFIG_CATEGORIES);
export type ConfigCategory = z.infer<typeof ConfigCategory>;

export const SyncSettings = z.object({
  config: z.object({
    base: z.boolean(),
    appearance: z.boolean(),
    hotkeys: z.boolean(),
    pluginList: z.boolean(),
    plugins: z.boolean(),
  }),
  /** Glob patterns on canonical paths (S-09). */
  patterns: z.array(z.string().min(1).max(500)).max(200),
});
export type SyncSettings = z.infer<typeof SyncSettings>;

export const DEFAULT_PATTERNS = [".trash/**", ".git/**", "**/.DS_Store", "**/Thumbs.db", "**/desktop.ini"];
/** S-10: by default only notes and attachments, no configuration category. */
export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  config: { base: false, appearance: false, hotkeys: false, pluginList: false, plugins: false },
  patterns: DEFAULT_PATTERNS,
};

export const DeviceSettings = z.object({ override: SyncSettings.nullable(), effective: SyncSettings });
export type DeviceSettings = z.infer<typeof DeviceSettings>;
export const DeviceSettingsPut = z.object({ override: SyncSettings.nullable() });

/** fileId and path of journal entries that concern the vault, not a file (`ignorable`). */
export const VAULT_EVENT_ID = "_vault";
```

`ws.ts`:

```ts
import { z } from "zod";
import { DeviceStatusReport } from "./devices-auth.js";
import { ErrorCode } from "./errors.js";
import { SyncSettings } from "./settings.js";
import { JournalEntry } from "./sync.js";

export const WS_PAGE = 500;
export const Hello = z.object({
  type: z.literal("hello"),
  deviceToken: z.string().min(1).max(200),
  protocol: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }),
  cursor: z.number().int().min(0),
  pluginVersion: z.string().max(50),
  platform: z.string().max(20),
});
export const ClientMessage = z.discriminatedUnion("type", [
  Hello,
  z.object({ type: z.literal("ack"), seq: z.number().int().min(0) }),
  DeviceStatusReport.extend({ type: z.literal("status") }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("pong") }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export const ServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    protocol: z.number().int(),
    head: z.number().int().min(0),
    deviceId: z.string(),
    serverVersion: z.string(),
    codename: z.string(),
  }),
  z.object({
    type: z.literal("changes"),
    entries: z.array(JournalEntry),
    head: z.number().int().min(0),
    hasMore: z.boolean(),
  }),
  z.object({ type: z.literal("device_revoked") }),
  z.object({ type: z.literal("vault_settings_changed"), settings: SyncSettings }),
  z.object({ type: z.literal("error"), code: ErrorCode, message: z.string() }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("pong") }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
```

`index.ts`: `export * from "./settings.js"; export * from "./ws.js";`

- [ ] **Step 4:** test → PASS; `pnpm --filter @kamino/protocol build`.
- [ ] **Step 5:** commit `feat(protocol): add websocket messages and sync settings`.

### Task 2: `sync-core` usa le impostazioni del contratto (default S-10)

**Files:** Modify `packages/sync-core/src/exclusions.ts`, `exclusions.test.ts`, `client.test.ts`, `sim/world.ts`

- [ ] **Step 1: test** in `exclusions.test.ts`:

```ts
it("S-10: by default no configuration category is synced", () => {
  expect(classify(".obsidian/app.json", DEFAULT_SETTINGS)).toMatchObject({ synced: false });
});
```

(adatta l'asserzione alla forma restituita da `classify` per un path escluso, come nei test esistenti di righe 65–71).

- [ ] **Step 2:** FAIL (oggi tutte le categorie sono attive).
- [ ] **Step 3:** in `exclusions.ts` sostituisci `SyncSettings`, `DEFAULT_PATTERNS`, `CONFIG_CATEGORIES`, `ConfigCategory` con i re-export da `@kamino/protocol` e `export const DEFAULT_SETTINGS = DEFAULT_SYNC_SETTINGS;`. Nei test che volevano tutte le categorie (riga 31 di `exclusions.test.ts`, `client.test.ts:25`, `sim/world.ts:92`) usa una costante esplicita:

```ts
const ALL_CONFIG: SyncSettings["config"] = { base: true, appearance: true, hotkeys: true, pluginList: true, plugins: true };
// es. world.ts: settings: { config: ALL_CONFIG, patterns: spec.patterns ?? DEFAULT_SETTINGS.patterns }
```

- [ ] **Step 4:** `pnpm --filter @kamino/sync-core test` e `test:deep` (3000 scenari) → PASS; build.
- [ ] **Step 5:** commit `feat(sync-core): sync no configuration category by default`.

---

## Blocco B — WebSocket e fan-out

### Task 3: migrazione, notifica nel commit e `cursor_too_old` su REST

**Files:**
- Modify: `apps/server/src/db/schema.ts`, `apps/server/src/sync/commit.ts`, `apps/server/src/routes/sync.ts`
- Create: `apps/server/drizzle/0003_*.sql` (`pnpm --filter @kamino/server db:generate`)
- Test: `apps/server/test/sync-flow.test.ts`

**Interfaces — Produces:** `NOTIFY_CHANNEL = \`${PRODUCT_SLUG}_vault\`` (in `sync/commit.ts`); `class CursorTooOld extends Error`; `SyncService.changes(vc, after, limit)` lancia `CursorTooOld` se `after < journal_floor`, letto nella stessa transazione `repeatable read` delle voci.

- [ ] **Step 1: test** (nuovo `it` in `sync-flow.test.ts`):

```ts
it("a cursor below the journal floor gets 410 cursor_too_old; commits notify", async () => {
  const a = await linkDevice(t, await user(t, "mario"));
  await t.db.$client`update vaults set journal_floor = 5 where id = ${a.vaultId}`;
  const r = await a.call("GET", `/vaults/${a.vaultId}/changes?after=4`);
  expect(r.statusCode).toBe(410);
  expect(r.json().error.code).toBe("cursor_too_old");
  expect((await a.call("GET", `/vaults/${a.vaultId}/changes?after=5`)).statusCode).toBe(200);
  const heard: string[] = [];
  const sub = await t.db.$client.listen("kamino_vault", (p) => heard.push(p));
  await t.db.$client`update vaults set journal_floor = 0, head_seq = 0 where id = ${a.vaultId}`;
  const h = await uploadContent(a, Buffer.from("x"));
  await a.call("POST", `/vaults/${a.vaultId}/commits`, {
    ops: [{ type: "put", opId: "o1", fileId: "f1", versionId: "v1", path: "a.md", baseVersionId: null, contentHash: h, size: 1, mtime: 1 }],
  });
  await expect.poll(() => heard).toEqual([`${a.vaultId}:1`]);
  await sub.unlisten();
});
```

- [ ] **Step 2:** FAIL (colonna mancante).
- [ ] **Step 3:** schema: in `vaults` aggiungi `journalFloor: bigint("journal_floor", { mode: "number" }).notNull().default(0)`, `settingsEnc: bytea("settings_enc")`; in `devices` `settingsOverrideEnc: bytea("settings_override_enc")`. `db:generate`, prettier sul meta JSON. In `applyOne`, dopo l'inserimento della voce di journal (dove si incrementa `head_seq`):

```ts
await tx.execute(sql`select pg_notify(${NOTIFY_CHANNEL}, ${`${vc.vaultId}:${seq}`})`);
```

`changes` dentro `this.db.transaction(async (tx) => { … }, { isolationLevel: "repeatable read", accessMode: "read only" })`: legge `head_seq, journal_floor` del vault, `if (after < floor) throw new CursorTooOld()`, poi le voci. Nella rotta `changes`: `catch (e) { if (e instanceof CursorTooOld) return fail(reply, 410, "cursor_too_old"); throw e; }`.
- [ ] **Step 4:** test → PASS; intera suite del server verde.
- [ ] **Step 5:** commit `feat(server): notify commits and report cursor_too_old`.

### Task 4: hub e listener

**Files:** Create `apps/server/src/realtime/hub.ts`, `apps/server/src/realtime/listener.ts`, `apps/server/test/hub.test.ts`

**Interfaces — Produces:**

```ts
export interface Conn { readonly vaultId: string; readonly deviceId: string; readonly userId: string; wake(): void; close(code: number, message?: ServerMessage): void; }
export class Hub {
  add(c: Conn): void;          // max 5 per device: closes the oldest (4409)
  remove(c: Conn): void;
  notify(vaultId: string): void;
  wakeAll(): void;
  closeDevice(deviceId: string, message: ServerMessage, code?: number): void;
  closeUser(userId: string, message: ServerMessage, code?: number): void;
  size(): number;
}
export async function startListener(db: Db, hub: Hub): Promise<{ stop(): Promise<void> }>;
```

- [ ] **Step 1: test** (`hub.test.ts`, unità senza Docker per l'hub; listener con Postgres):

```ts
const conn = (vaultId: string, deviceId: string, log: string[]): Conn => ({
  vaultId, deviceId, userId: "u",
  wake: () => log.push(`wake ${deviceId}`),
  close: (code) => log.push(`close ${deviceId} ${code}`),
});
it("wakes only the vault's connections; caps sockets per device", () => {
  const hub = new Hub(); const log: string[] = [];
  const a = conn("v1", "d1", log); hub.add(a); hub.add(conn("v2", "d2", log));
  hub.notify("v1");
  expect(log).toEqual(["wake d1"]);
  for (let i = 0; i < 5; i++) hub.add(conn("v1", "d1", log));
  expect(log).toContain("close d1 4409"); // the oldest went away
  expect(hub.size()).toBe(6);
});
it("listener wakes on NOTIFY and wakes everyone on (re)connect", async () => {
  // Postgres da testcontainers: startListener(db, hub) → wakeAll al primo collegamento;
  // `select pg_notify('kamino_vault', 'v1:1')` → hub.notify("v1").
});
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** `Hub` con `Map<vaultId, Set<Conn>>` e `Map<deviceId, Conn[]>`. `startListener`:

```ts
export async function startListener(db: Db, hub: Hub) {
  // postgres-js re-subscribes after a dropped connection and calls onlisten again:
  // a notification may have been missed meanwhile, so every socket re-reads its journal.
  const sub = await db.$client.listen(
    NOTIFY_CHANNEL,
    (payload) => {
      const vaultId = payload.split(":")[0];
      if (vaultId) hub.notify(vaultId);
    },
    () => hub.wakeAll(),
  );
  return { stop: () => sub.unlisten() };
}
```

- [ ] **Step 4:** PASS. **Step 5:** commit `feat(server): add the realtime hub and notify listener`.

### Task 5: socket e rotta `/ws`

**Files:**
- Create: `apps/server/src/realtime/socket.ts`, `apps/server/src/routes/ws.ts`, `apps/server/test/ws.test.ts`, `apps/server/test/helpers/ws.ts`
- Modify: `apps/server/src/app.ts` (registra `@fastify/websocket` con `{ options: { maxPayload: 65_536 } }`, crea `Hub`, avvia il listener con `deps.realtime?.listen !== false`, `onClose` → `stop()`), `apps/server/src/main.ts`, `apps/server/package.json` (`pnpm --filter @kamino/server add @fastify/websocket`), `apps/server/test/helpers/app.ts` (espone `hub`, accetta `realtime: { helloMs, heartbeatMs }`)

**Interfaces — Consumes:** `Hub`, `Conn` (Task 4); `SyncService.changes`, `SyncService.ack`, `CursorTooOld` (Task 3); `ClientMessage`, `ServerMessage`, `WS_PAGE` (Task 1). **Produces:** `class DeviceSocket implements Conn`; `AppDeps.realtime?: { helloMs?: number; heartbeatMs?: number; listen?: boolean }`; `TestApp.hub`, `TestApp.ws(): Promise<TestWs>` con `send(msg)`, `next(type?)`, `closed()`.

Comportamento di `DeviceSocket` (stati `waiting → live → closed`):

1. Alla connessione: timer `helloMs` (default 5000) → `close(4401)` se non arriva `hello`.
2. `hello`: valida; protocollo: `max(min(msg.protocol.max, PROTOCOL_VERSION), …)` — se gli intervalli non si sovrappongono → `error protocol_unsupported` + chiusura `4426`. Token → device con la stessa query di `deviceGuard` (estrai `findDeviceByToken(db, token)` in `devices/auth.ts` e usala in entrambi): assente → `error unauthorized` (4401); revocato → `device_revoked` (4403); utente non attivo → `error user_blocked` (4403). Vault non attivo → `error not_found`.
3. `welcome { protocol, head, deviceId, serverVersion, codename }`, `hub.add(this)`, `sent = msg.cursor`, poi `pump()`.
4. `pump()`: se sta già pompando → `dirty = true` e ritorna. Altrimenti ciclo: `changes(vc, sent, WS_PAGE)`; se `entries.length` → invia `changes` e **attende il callback di `ws.send`** (contropressione); `sent = ultimo seq`; se una voce è `vault_settings_changed` invia anche `vault_settings_changed { settings }` (Task 11); continua finché `hasMore || dirty`. `CursorTooOld` → `error cursor_too_old` + chiusura `4410`.
5. `wake()` → `pump()`.
6. `ack` → `sync.ack(deviceId, vaultId, seq)`; `status` → stesso aggiornamento della rotta REST (estrai `recordStatus(db, deviceId, report, now)` in `devices/status.ts` e usalo da entrambe).
7. Heartbeat ogni `heartbeatMs` (default 30000): se nessun messaggio dal client da `2 × heartbeatMs` → chiusura `4408`; altrimenti invia `ping` e **ricontrolla** dispositivo e utente (revoca o blocco fatti da un'altra istanza) → `device_revoked` / `error user_blocked` e chiusura. `ping` del client → `pong`.
8. Messaggio non JSON o non valido → `error invalid_request` + chiusura `4400`. Chiusura → `hub.remove(this)`, timer cancellati.
9. Log: solo `deviceId` e codici.

- [ ] **Step 1: test** (`ws.test.ts`, `testApp(..., { realtime: { helloMs: 200, heartbeatMs: 100 } })`, client con `app.injectWS("/api/v1/ws")`):

```ts
it("hello → welcome → catch-up in pages → live push between two devices", async () => {
  const a = await linkDevice(t, enroll); const b = await linkDevice(t, enroll, a.vaultId, "iPhone");
  for (let i = 1; i <= 3; i++) await putFile(a, `n${i}.md`); // helper: upload + commit
  const ws = await t.ws();
  ws.send(hello(b.token, 1));
  expect((await ws.next("welcome")).head).toBe(3);
  expect((await ws.next("changes")).entries.map((e) => e.seq)).toEqual([2, 3]);
  await putFile(a, "n4.md");
  expect((await ws.next("changes")).entries.map((e) => e.seq)).toEqual([4]);
  ws.send({ type: "ack", seq: 4 });
  await expect.poll(async () => cursorOf(t, b.deviceId)).toBe(4);
});
it("no hello → closed 4401; bad token → unauthorized; wrong protocol → protocol_unsupported", …);
it("revoking from the web closes the device's sockets with device_revoked", …);
it("cursor below the floor → cursor_too_old and close 4410", …);
it("silent client is dropped after two heartbeats; ping gets pong", …);
it("a blocked user is disconnected at the next heartbeat", …);
it("invalid JSON → invalid_request and close 4400", …);
```

(Scrivi ogni `it` per intero nel file, con gli stessi helper; i codici di chiusura si leggono da `ws.closed()` → `{ code }`.)

- [ ] **Step 2:** FAIL. **Step 3:** implementa come sopra. **Step 4:** PASS + suite intera.
- [ ] **Step 5:** commit `feat(server): stream journal changes over websocket`.

### Task 6: fan-out tra due istanze

**Files:** Test `apps/server/test/ws-fanout.test.ts`

- [ ] **Step 1: test:** due `testApp` sullo **stesso** database (la seconda senza rieseguire la creazione dei dati), dispositivo A su istanza 1 via REST, dispositivo B in WebSocket sull'istanza 2: un commit su 1 arriva a B. Poi `select pg_terminate_backend(pid) from pg_stat_activity where query like 'LISTEN%'` sull'istanza 2: dopo la riconnessione automatica un nuovo commit arriva comunque a B (e il risveglio totale non perde la voce scritta mentre il listener era giù).
- [ ] **Step 2–4:** se fallisce, correggi listener/hub; PASS.
- [ ] **Step 5:** commit `test(server): fan out commits across two server instances`.

---

## Blocco C — pg-boss e compattazione

### Task 7: compattazione del journal

**Files:** Create `apps/server/src/jobs/compact.ts`, `apps/server/test/compact.test.ts`

**Interfaces — Produces:** `compactJournal(db: Db, now: number): Promise<{ vaults: number; deleted: number }>`; `INACTIVE_DEVICE_MS = 90 * 86_400_000`.

Regola per ogni vault attivo, in una transazione con `SELECT … FOR UPDATE` sulla riga del vault:

```ts
// Active devices hold the journal: not revoked and seen within 90 days.
const minCursor = (select min(cursor_seq) from devices where vault_id = v and revoked_at is null
                   and coalesce(last_seen_at, created_at) > now - INACTIVE_DEVICE_MS) ?? head_seq;
// History retention keeps entries younger than retention_days.
const oldEnough = (select max(seq) from journal where vault_id = v and at < now - retention_days * day) ?? 0;
const cut = Math.min(minCursor, oldEnough);
if (cut > journal_floor) { delete from journal where vault_id = v and seq <= cut; update vaults set journal_floor = cut; }
```

- [ ] **Step 1: test:** vault con 10 voci; dispositivo A con cursore 8, B con cursore 3; retention 0 → `cut = 3`; B inattivo da 91 giorni → `cut = 8`; retention 30 giorni con voci di oggi → nessuna eliminazione; dispositivo revocato non conta; `changes?after=2` dopo il taglio a 3 → `410`; `after=3` → voci 4…10.
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5:** commit `feat(server): compact the journal behind active cursors and retention`.

### Task 8: pg-boss

**Files:**
- Create: `apps/server/src/jobs/boss.ts`, `apps/server/test/jobs.test.ts`
- Modify: `apps/server/src/main.ts` (sostituisce il `setInterval` di M1c), `apps/server/package.json` (`pg-boss@^12`), `docs/self-hosting.md` (nessuna variabile nuova: lo schema `pgboss` si crea da solo)

**Interfaces — Produces:**

```ts
export const JOBS = { compact: "journal-compact", sweep: "upload-sweep" } as const;
export async function startJobs(url: string, handlers: { compact(): Promise<unknown>; sweep(): Promise<unknown> }, log: Logger): Promise<{ stop(): Promise<void>; runNow(name: keyof typeof JOBS): Promise<void> }>;
```

`startJobs`: `new PgBoss({ connectionString: url, schema: "pgboss" })`, `boss.on("error", (e) => log.error({ err: e.name }, "jobs error"))`, `start()`, `createQueue` per ogni nome, `work(name, async () => handler())`, `schedule(JOBS.compact, "17 3 * * *")`, `schedule(JOBS.sweep, "7 * * * *")`. `runNow` = `send` + attesa del completamento (per i test). In `main.ts` si avvia **dopo** `runMigrations` (quindi dopo la verifica della chiave) e si ferma nello `shutdown`.

- [ ] **Step 1: test:** `startJobs` sul database di test, `runNow("compact")` esegue l'handler (spia), `stop()` chiude senza errori; lo schema `pgboss` esiste dopo `start`.
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5:** commit `feat(server): run compaction and upload cleanup as pg-boss jobs`.

---

## Blocco D — Dispositivi e livelli

### Task 9: un'unica funzione per i livelli

**Files:** Create `apps/server/src/devices/level.ts`, `apps/server/test/level.test.ts`; Modify `apps/server/src/routes/vaults.ts`

**Interfaces — Produces:**

```ts
export interface DeviceFacts { cursor: number; pending: number; deferred: number; lastSync: Date | null; lastAck: Date | null; error: string | null; revoked: boolean }
export function deviceLevel(d: DeviceFacts, headSeq: number): Level; // revoked → "blocked"; error → "attention"; behind/queued/never synced → "working"; else "safe"
export function vaultLevel(openConflicts: number, devices: DeviceFacts[], headSeq: number): Level; // decision > attention > working (also no active device) > safe; revoked devices ignored
```

- [ ] **Step 1: test** (unità, tabella di casi per entrambe le funzioni, compresi: nessun dispositivo → `working`; solo dispositivi revocati → `working`; errore + conflitto → `decision`).
- [ ] **Step 2–4:** FAIL → implementa → in `routes/vaults.ts` sostituisci il calcolo locale con `vaultLevel` (la query seleziona anche `revokedAt`; filtra i revocati come oggi) → `level.test.ts` e `vaults-web.test.ts` PASS.
- [ ] **Step 5:** commit `refactor(server): compute device and vault levels in one place`.

### Task 10: rotte dei dispositivi (web e plugin) e modalità ibrida

**Files:**
- Create: `apps/server/src/devices/service.ts`, `apps/server/src/routes/devices.ts`, `apps/server/test/devices.test.ts`
- Modify: `apps/server/src/app.ts`, `apps/server/src/routes/enroll.ts` (`DELETE /device` chiude anche i socket), `apps/web/src/mocks/user-handlers.ts` (le quattro rotte dei dispositivi in un array esportato `deviceHandlers`), `apps/web/src/mocks/browser.ts` (`real = [...authHandlers, ...vaultListHandlers, ...deviceHandlers]`)

**Interfaces — Produces:** `DeviceService(db, vaults: VaultService, hub: Hub, now)` con `list(userId): Promise<Device[]>`, `get(userId, id)`, `rename(userId, id, name)`, `revoke(userId, id)`, `ofVault(vaultId)`, `toDto(row, vault)`. DTO: `lag = max(0, head − cursor)`, `pending = pendingOps`, `lastError = lastErrorCode`, `lastSeenAt = (lastSeenAt ?? createdAt).toISOString()`, `level = deviceLevel(...)`, `revoked = revokedAt !== null`, `vaultName = vaults.nameOf(v)`. `revoke` imposta `revoked_at` e chiama `hub.closeDevice(id, { type: "device_revoked" }, 4403)`; un dispositivo già revocato → `204` (idempotente).

Rotte: web (`requireUser`, filtro `devices.user_id = sessione`, altrimenti `404`): `GET /devices`, `GET /devices/:id`, `PATCH /devices/:id` (`DevicePatch`), `POST /devices/:id/revoke` → `204`. Plugin (`deviceGuard`): `GET /device`, `GET /vault/devices`.

- [ ] **Step 1: test:** `DeviceList.parse` dell'elenco web; `lag`/`pending`/`level` dopo commit, ack e status; rinomina; revoca → il dispositivo riceve `401 device_revoked` sulle REST e `device_revoked` sul socket aperto; dispositivi di un altro utente → `404` (anche per un admin); `GET /vault/devices` mostra solo il vault del dispositivo.
- [ ] **Step 2–4:** FAIL → implementa → PASS; test delle mock web (`pnpm --filter @kamino/web exec vitest run src/mocks`) verdi.
- [ ] **Step 5:** commit `feat(server): list, rename and revoke devices from the web and the plugin`.

---

## Blocco E — Impostazioni

### Task 11: default del vault e override del dispositivo

**Files:**
- Create: `apps/server/src/vaults/settings.ts`, `apps/server/src/routes/settings.ts`, `apps/server/test/settings.test.ts`
- Modify: `apps/server/src/app.ts`, `apps/server/src/realtime/socket.ts` (messaggio `vault_settings_changed`)

**Interfaces — Produces:**

```ts
export class SettingsService {
  constructor(db: Db, vaults: VaultService, now?: () => number);
  vaultSettings(vaultId: string): Promise<SyncSettings>;                 // null in DB → DEFAULT_SYNC_SETTINGS
  setVaultSettings(vaultId: string, deviceId: string, s: SyncSettings): Promise<{ seq: number }>;
  deviceSettings(device: { id: string; vaultId: string }): Promise<DeviceSettings>;
  setDeviceOverride(device: { id: string; vaultId: string }, o: SyncSettings | null): Promise<DeviceSettings>;
}
```

- Cifratura: `vc.enc("vaults", "settings", vaultId, JSON)` e `vc.enc("devices", "settings_override", deviceId, JSON)`.
- `setVaultSettings`: transazione, `SELECT … FOR UPDATE` sul vault, `seq = head_seq + 1`, aggiorna `settings_enc` e `head_seq`, inserisce la voce `{ type: "vault_settings_changed", fileId: VAULT_EVENT_ID, kind: "file", path: VAULT_EVENT_ID (cifrato con AAD journal ‖ path ‖ vaultId:seq), deviceId, at }`, poi `pg_notify` come il commit. In `changes` le voci con `type === "vault_settings_changed"` escono con `ignorable: true`.
- `effective = override ?? vaultSettings` (S-10: i dispositivi non personalizzati seguono il default).
- Rotte (plugin, `deviceGuard`): `GET`/`PUT /vault/settings` (`SyncSettings`), `GET`/`PUT /device/settings` (`DeviceSettingsPut` → `DeviceSettings`).

- [ ] **Step 1: test:** default S-10 senza righe; `PUT /vault/settings` → voce di journal `vault_settings_changed` con `ignorable: true` in `changes`, messaggio `vault_settings_changed { settings }` sul socket di un altro dispositivo; override `null` segue il default, override impostato no; impostazioni cifrate a riposo (i pattern non compaiono come testo nel dump di `vaults`/`devices`); validazione (`patterns` troppo lunghi → `400`).
- [ ] **Step 2–4:** FAIL → implementa → PASS.
- [ ] **Step 5:** commit `feat(server): store vault settings and device overrides encrypted`.

---

## Blocco F — Test multi-client

### Task 12: client di protocollo con rete inaffidabile

**Files:** Create `apps/server/test/multi-client.test.ts`, `apps/server/test/helpers/protocol-client.ts`

`ProtocolClient` (per dispositivo): stato `Map<fileId, { path, versionId, contentHash }>`, `cursor`, `seen: number[]` (dall'ultimo snapshot). Operazioni:
- `connect()`: WebSocket con `hello(cursor)`; ogni `changes` applica le voci in ordine (`file_put`/`file_restored` → set, `file_moved` → path, `file_deleted` → delete, `ignorable` → skip) e invia `ack` dell'ultimo `seq`; `error cursor_too_old` → `GET /snapshot`, stato = snapshot, `cursor = head`, `seen = []`, poi riconnessione.
- `drop()`: chiude il socket senza preavviso; `pull()`: `GET /changes` dal cursore (modalità senza WebSocket).
- `act(rng)`: put nuovo, edit con la base nota (a volte vecchia → conflitto), move, delete; a volte ripete lo stesso commit (stesso `opId`).

Scenario (fast-check, `numRuns` da `MULTI_RUNS`, default 15; 3 client, 40 passi): a ogni passo un client a caso fa `act`, `drop`, `connect`, `pull`, oppure il test lancia `compactJournal(db, now)`. Alla fine: tutti si connettono, si attende che `cursor === head` per tutti.

- [ ] **Step 1: test** con le asserzioni: per ogni client `seen` è strettamente crescente e contiguo (nessun buco né doppione dopo l'ultimo snapshot); `state` uguale a `snapshot.files` (fileId, path, versionId, contentHash); nessuna risposta `500`.
- [ ] **Step 2:** esegui; ogni fallimento trovato è un bug del server: correggilo con un test di regressione fissato (come in M1c).
- [ ] **Step 3:** `MULTI_RUNS=200` una volta in locale → verde.
- [ ] **Step 4:** commit `test(server): multi-client protocol convergence over websocket`.

---

## Blocco G — Documenti, verifica, revisione, PR

### Task 13: chiusura

- [ ] `docs/03-sync-protocol.md` §7: nota "Implementazione M2a" (codici di chiusura 4400/4401/4403/4408/4409/4410/4426, pagine da 500, ricontrollo della revoca al battito); §6.3: `journal_floor`, `410 cursor_too_old`; §11: default S-10 e `VAULT_EVENT_ID`.
- [ ] `docs/05-data-model.md`: `journal_floor`, `settings_enc`, `settings_override_enc`, schema `pgboss`.
- [ ] `docs/self-hosting.md`: proxy davanti al server devono inoltrare l'upgrade WebSocket su `/api/v1/ws` (Caddy lo fa da solo; Cloudflare Tunnel/Tailscale sì; nginx: `proxy_set_header Upgrade/Connection`).
- [ ] `docs/HANDOVER.md`: decisioni D1–D8, stato, prossimi passi (M2b dopo M1d), punti aperti.
- [ ] Changeset `.changeset/m2a-realtime.md` (`@kamino/server` minor, `@kamino/web` patch).
- [ ] Verifica completa: `pnpm build`, `typecheck`, `lint`, `format:check`, `pnpm exec turbo run test --force`, `pnpm --filter @kamino/sync-core test:deep`; Docker (`compose.lan.yml`, volumi puliti con un progetto separato `-p kamino-verify`): WebSocket reale con `ws` da Node — `hello`, commit da REST, push ricevuto.
- [ ] Revisione finale con **un** subagente su `git diff main...HEAD`; correggere i rilievi con test.
- [ ] PR; attendere il merge del committente.
