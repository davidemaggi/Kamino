# M4+M5+M6 — Rotte del server: piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **In questo progetto:** esecuzione nella sessione con _executing-plans_, senza checkpoint tra i task (scelta del committente, 2026-11-10); **tre PR** (P1, P2, P3), ognuna con una sola revisione finale con un subagente e l'attesa del merge prima della successiva.

**Goal:** il server implementa le rotte del contratto `@kamino/protocol` dietro le schermate già fatte (area utente, admin/quote/email, pairing) e MSW si spegne per quelle rotte.

**Architecture:** ogni area è un modulo in `apps/server/src/<modulo>/` con un servizio e rotte sottili in `src/routes/`. Le rotte di contenuto controllano la proprietà (404 su vault altrui) e non hanno bypass per l'admin; il modulo `admin` legge solo aggregati e non importa servizi che decifrano. I lavori lunghi (pulizia dei blob, email, export, finalizzazione delle cancellazioni) sono job pg-boss in `src/jobs/`.

**Tech Stack:** Fastify, Drizzle + Postgres, pg-boss, zod (`@kamino/protocol`), `yazl` (ZIP in streaming), `nodemailer` (SMTP), Vitest + testcontainers, Playwright (web).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-11-11-m456-server-routes-design.md` (F1–F12).
- Storico, cestino e conflitti in **sola lettura**: restore/resolve → `501 not_implemented` (F2).
- Proprietà: vault di un altro utente → **404**, mai 403; nessun bypass per l'admin sulle rotte di contenuto.
- Il modulo `src/admin/` non importa `vaults/vault-crypto`, `crypto/dek`, `crypto/field` (per i dati dei vault), `sync/commit`, `blobs/uploads` (test di architettura, Task 8).
- Mai nei log: path, nomi di vault e file, contenuti, token, link, password, indirizzi email nei job.
- Config: variabili `KAMINO_*`, segreti anche come `*_FILE`; precedenza ambiente → UI → default; stringa vuota = non impostata.
- Solo **aggiunte** al modello dati; una migrazione Drizzle per PR (`pnpm --filter @kamino/server exec drizzle-kit generate`).
- UI: nessuna stringa scritta a mano, chiavi i18n it/en; lessico a tema vietato nei testi UI.
- Commit: Conventional Commits, soggetto minuscolo ≤ 100 caratteri, `pnpm exec commitlint --edit` prima di ogni commit (sul Mac `/tmp/kamino-tools/commit.sh`); `pnpm exec prettier --write` sui file toccati prima del commit.
- Test del server: `pnpm --filter @kamino/server test -- <file>` (serve Docker).
- Ogni PR: changeset (`@kamino/server` minor; `@kamino/web`/`@kamino/plugin` patch o minor se cambiano), HANDOVER aggiornato, verifica completa (`pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`).

## File

| File | Responsabilità |
|---|---|
| `apps/server/src/vaults/access.ts` | `ownedVault(db, vaults, userId, vaultId)` → `{ vault, vc }` o `NotFound` |
| `apps/server/src/history/service.ts` | ricerca file, versioni, contenuto, cestino, vista "alla data X" (sola lettura) |
| `apps/server/src/history/zip.ts` | ZIP in streaming con `yazl` |
| `apps/server/src/conflicts/service.ts` | elenco e dettaglio dei conflitti |
| `apps/server/src/vaults/delete.ts` · `src/jobs/purge.ts` | cancellazione del vault (crypto-shredding) e pulizia dei blob |
| `apps/server/src/routes/user-area.ts` | rotte P1 |
| `apps/server/src/system/config.ts` | `system_config` con fonte dei valori |
| `apps/server/src/email/{mailer,outbox,templates}.ts` · `src/jobs/email.ts` | SMTP, outbox, template it/en |
| `apps/server/src/quota/service.ts` | uso e limite, controllo dei byte nuovi |
| `apps/server/src/admin/{users,health,audit}.ts` · `src/routes/admin.ts` | rotte P2 solo aggregati |
| `apps/server/src/users/deletion.ts` · `src/jobs/{export,finalize}.ts` | cancellazione dell'utente (U-12) |
| `apps/server/src/pairing/service.ts` · `src/routes/pairing.ts` | pairing (03 §10) |
| `apps/plugin/src/connection/real-server.ts` | `startPairing`/`claim` veri |
| `apps/web/src/mocks/browser.ts` | elenco degli handler serviti dal server vero |

---

## Blocco P1 — Area utente (PR 1, branch `m456-server-routes`)

### Task 1: accesso al vault di proprietà e catalogo errori

**Files:** Create `apps/server/src/vaults/access.ts`, `apps/server/test/access.test.ts`; Modify `packages/protocol/src/errors.ts` (aggiungi `not_implemented`, `out_of_retention`, `export_expired`), testi it/en in `apps/web/src/i18n/locales/{it,en}.json` sotto `errors.*`.

**Produces:**

```ts
export class NotFound extends Error { readonly status = 404; readonly code = "not_found" }
export async function ownedVault(vaults: VaultService, kek: Kek, userId: string, vaultId: string): Promise<{ vault: Vault; vc: VaultCrypto }>;
// vaultId non UUID, vault inesistente, di un altro utente o cancellato → NotFound
```

- [ ] Test: vault proprio → `vc.vaultId === vaultId`; vault di un altro utente → `NotFound`; id malformato → `NotFound` (non 500); utente admin sul vault di un altro → `NotFound`.
- [ ] Test del catalogo: il test esistente di `errors.ts` (snapshot dei codici) aggiornato con i tre codici nuovi.
- [ ] FAIL → implementa → PASS → commit `feat(server): resolve owned vaults with a single not-found answer`.

### Task 2: storico e cestino in sola lettura

**Files:** Create `apps/server/src/history/service.ts`, `apps/server/test/history.test.ts`.

**Consumes:** `ownedVault`, `readPlain(store, vc, blobId, size, start, end)` da `blobs/uploads.ts`, tabelle `files`, `fileVersions`, `devices`.

**Produces:**

```ts
export const TEXT_PREVIEW_MAX = 1 << 20; // 1 MiB
export const FILE_SEARCH_LIMIT = 200;
export class HistoryService {
  constructor(db: Db, store: BlobStore, now: () => Date);
  search(vc: VaultCrypto, q: string): Promise<FileList>;            // path decifrati, match case-insensitive su NFC, max 200, ordinati per lastChangedAt desc
  versions(vc: VaultCrypto, fileId: string): Promise<FileVersions>; // device = nome del dispositivo o "—" se revocato/sconosciuto
  version(vc: VaultCrypto, versionId: string): Promise<VersionContent>; // text se mime testuale e size ≤ TEXT_PREVIEW_MAX, altrimenti null; previewUrl null
  trash(vc: VaultCrypto, retentionDays: number): Promise<TrashList>; // expiresAt = deletedAt + 7 giorni (cestino, 01)
  /** Live files at `at` (null = now): path → { blobId, size, mtime }. */
  treeAt(vc: VaultCrypto, at: Date | null): Promise<Map<string, { blobId: string; size: number; mtime: number }>>;
}
```

`treeAt(at)`: per ogni file, l'ultima `file_versions` con `createdAt ≤ at`; il path e lo stato vivo/cancellato si ricavano dalle voci del `journal` fino al primo `seq` con `at > at` (le voci portano path cifrato e tipo). Se `at` è prima di `now − retentionDays` o prima della creazione del vault → `OutOfRetention` (400 `out_of_retention`).

- [ ] Test (con `testApp`, vault popolato via `sync.commit` e upload): ricerca per sottostringa e maiuscole diverse; versioni in ordine con `current` sull'ultima; contenuto testuale e binario (PNG → `text: null`); cestino con i file cancellati; `treeAt` prima e dopo una rinomina e una cancellazione; `at` fuori finestra → `OutOfRetention`; versione di un altro vault → `NotFound`.
- [ ] FAIL → implementa → PASS → commit `feat(server): read file history and trash for the owner`.

### Task 3: conflitti in sola lettura

**Files:** Create `apps/server/src/conflicts/service.ts`, `apps/server/test/conflicts-read.test.ts`.

**Produces:**

```ts
export class ConflictService {
  constructor(db: Db, store: BlobStore);
  list(userId: string, vaults: VaultService, kek: Kek): Promise<ConflictList>; // solo vault dell'utente, status open
  detail(vc: VaultCrypto, conflictId: string): Promise<ConflictDetail>;        // testo dei due candidati se testuali (≤ TEXT_PREVIEW_MAX), altrimenti BinaryMeta
}
```

- [ ] Test: conflitto creato con due commit concorrenti sullo stesso file (stessa base) → in elenco con path e due `VersionRef`; dettaglio testuale e binario; conflitto di un altro utente assente dall'elenco e 404 al dettaglio.
- [ ] FAIL → implementa → PASS → commit `feat(server): list and show open conflicts`.

### Task 4: ZIP in streaming

**Files:** Create `apps/server/src/history/zip.ts`, `apps/server/test/zip.test.ts`; Modify `apps/server/package.json` (`yazl`, `@types/yazl`; devDependency `yauzl` per i test).

**Produces:**

```ts
export function zipStream(tree: Map<string, { blobId: string; size: number; mtime: number }>, open: (blobId: string, size: number) => AsyncIterable<Buffer>): NodeJS.ReadableStream;
export function zipFileName(at: Date | null, now: Date): string; // "vault-2026-11-11.zip": mai il nome del vault (non va nei log degli header)
```

Le voci si aggiungono una alla volta (`addReadStream` con `Readable.from(open(...))`), così in memoria c'è al più un segmento per volta; cartelle vuote come voci `dir/`.

- [ ] Test: vault con 3 file e una cartella vuota → decompresso con `yauzl`, contenuti identici allo snapshot; `at` dopo una modifica → contenuto vecchio; file da 20 MB → `process.memoryUsage().arrayBuffers` cresce meno di 16 MB durante lo stream.
- [ ] FAIL → implementa → PASS → commit `feat(server): stream vault zips, also as of a past date`.

### Task 5: cancellazione del vault e pulizia dei blob

**Files:** Create `apps/server/src/vaults/delete.ts`, `apps/server/src/jobs/purge.ts`, `apps/server/test/vault-delete.test.ts`; Modify `apps/server/src/jobs/boss.ts` (job `purge-vault-blobs`), `apps/server/src/db/schema.ts` (`vaults.deleted_at timestamptz null`, `vaults.dek_wrapped` diventa nullable), migrazione.

**Produces:**

```ts
export async function deleteVault(db: Db, hub: Hub, boss: Jobs, vault: Vault, confirmName: string, nameOf: (v: Vault) => string): Promise<void>;
// confirmName ≠ nome → 400 invalid_request (`confirm_mismatch` nel messaggio); in una transazione: dek_wrapped = null, deleted_at = now, devices.revoked_at = now; poi hub.closeVault(vaultId) e job purge
export async function purgeVaultBlobs(db: Db, store: BlobStore, vaultId: string): Promise<void>; // elimina gli oggetti del blob store e le righe; idempotente
```

`VaultService.listForUser` e `byId` escludono i vault con `deleted_at`.

- [ ] Test: conferma sbagliata → 400 e nulla cambia; conferma giusta → vault sparito da `/vaults`, `dek_wrapped` null, token dei dispositivi del vault → `401 device_revoked`, socket chiusi; dopo il job i file del blob store non ci sono più; `purge` ripetuto non fallisce.
- [ ] FAIL → implementa → PASS → commit `feat(server): delete vaults by destroying their key, then purge blobs`.

### Task 6: rotte dell'area utente

**Files:** Create `apps/server/src/routes/user-area.ts`, `apps/server/test/user-area.test.ts`; Modify `apps/server/src/app.ts` (registrazione), `apps/server/src/routes/vaults.ts` (`GET`/`PATCH`/`DELETE /vaults/:id`, `statsOf` riusata).

Rotte (tutte `requireUser`, poi `ownedVault`): `GET/PATCH/DELETE /vaults/:id`, `GET /vaults/:id/files?q=`, `GET /files/:fileId/versions?vault=`, `GET /versions/:id?vault=`, `GET /vaults/:id/trash`, `GET /conflicts`, `GET /conflicts/:id`, `GET /vaults/:id/zip?at=`; `POST /versions/:id/restore`, `POST /trash/:fileId/restore`, `POST /conflicts/:id/resolve`, `POST /conflicts/resolve-all` → `501 not_implemented`.

Nota: `endpoints.ts` della web app chiama `/files/:id/versions` e `/versions/:id` senza il vault. Il server trova il vault con una query su `file_versions`/`files` filtrata per i vault dell'utente (gli id di file e versione sono unici per vault, quindi la query restituisce al più una riga per utente: se più d'una → 404). Nessuna modifica al contratto.

- [ ] Test: ogni rotta per il proprietario (schema zod della risposta valido); ogni rotta con un secondo utente → 404; admin sui vault altrui → 404 (T-02); restore/resolve → 501; ZIP con `Content-Type: application/zip` e `Content-Disposition` da `zipFileName`; `PATCH` rinomina e il nome cifrato cambia nel DB.
- [ ] FAIL → implementa → PASS → commit `feat(server): serve the user area routes`.

### Task 7: web app sul server vero, Playwright, chiusura di P1

**Files:** Modify `apps/web/src/mocks/browser.ts` (handler delle rotte P1 nell'elenco `real`), `apps/web/src/mocks/user-handlers.ts` (esporta i gruppi `vaultDetailHandlers`, `historyHandlers`, `conflictHandlers`), UI "in arrivo" per ripristino e risoluzione (pulsanti disattivati con testo i18n `common.comingSoon`); Create `apps/web/e2e/user-area.spec.ts` (Playwright in modalità ibrida: login → dettaglio vault → storico → ZIP).

- [ ] Test Vitest della web app: con `HYBRID` gli handler P1 non sono attivi; pulsanti di ripristino disattivati con il testo.
- [ ] Playwright contro `pnpm --filter @kamino/server dev` + Postgres di sviluppo.
- [ ] Changeset (`@kamino/server` minor, `@kamino/web` minor); HANDOVER; verifica completa; revisione finale con **un** subagente; correzioni con test; PR "M4: user area on the real server"; attesa del merge.

---

## Blocco P2 — Admin, quote, email (PR 2, branch `m5-admin-email` da `main`)

### Task 8: configurazione di sistema con fonte dei valori

**Files:** Create `apps/server/src/system/config.ts`, `apps/server/test/system-config.test.ts`, `apps/server/test/admin-architecture.test.ts`; Modify `apps/server/src/db/schema.ts` (`system_config`), `apps/server/src/config/schema.ts` (variabili `KAMINO_REGISTRATION`, `KAMINO_DEFAULT_QUOTA_BYTES`, `KAMINO_MAX_RETENTION_DAYS`, `KAMINO_SMTP_HOST`, `_PORT`, `_SECURITY`, `_USERNAME`, `_PASSWORD` (+`_FILE`), `_FROM`, `_ALLOW_INVALID_CERTS`; `KAMINO_MAX_FILE_BYTES` esiste già), migrazione.

**Produces:**

```ts
export class SystemConfigService {
  constructor(db: Db, env: Config, kek: Kek);
  get(): Promise<SystemConfig>;                       // schema di @kamino/protocol, con source per campo
  patch(p: ConfigPatch, actorId: string): Promise<SystemConfig>; // campo da env → ConfigLocked (409 config_locked); audit con vecchio/nuovo per i non segreti
  smtp(): Promise<SmtpSettings | null>;              // null se host o from mancano
  effective(): Promise<{ registration: "closed" | "open"; defaultQuotaBytes: number | null; maxRetentionDays: number; maxFileBytes: number }>;
}
```

La password SMTP si salva in `secret_enc` cifrata con `k_system` (AAD `system_config ‖ secret ‖ smtp.password`).

`admin-architecture.test.ts`: legge gli import di ogni file in `src/admin/` (ricorsivamente sui moduli locali) e fallisce se compare uno dei moduli vietati dei Global Constraints.

- [ ] Test: default; valore da UI; valore da env vince e `patch` → 409; password mai nella risposta (`passwordSet: true`); stringa vuota in env = non impostata; voce di audit `config_changed` senza la password.
- [ ] FAIL → implementa → PASS → commit `feat(server): store system config with the source of each value`.

### Task 9: email con outbox

**Files:** Create `apps/server/src/email/mailer.ts`, `outbox.ts`, `templates.ts`, `apps/server/src/jobs/email.ts`, `apps/server/test/email.test.ts`; Modify `apps/server/package.json` (`nodemailer`, `@types/nodemailer`), `db/schema.ts` (`email_outbox`), `jobs/boss.ts`, migrazione.

**Produces:**

```ts
export type Template = "invite" | "reset" | "admin_reset" | "pairing_link" | "export_ready" | "new_device";
export interface Transport { send(m: { to: string; subject: string; text: string; html: string }): Promise<void> }
export function smtpTransport(s: SmtpSettings): Transport;            // nodemailer
export function render(t: Template, locale: "it" | "en", params: Record<string, string>): { subject: string; text: string; html: string };
export class Outbox {
  constructor(db: Db, kek: Kek, config: SystemConfigService, transport: (s: SmtpSettings) => Transport, now: () => Date);
  enqueue(to: string, t: Template, locale: "it" | "en", params: Record<string, string>): Promise<void>; // smtp assente → SmtpNotConfigured (409)
  drain(): Promise<void>;   // invia le dovute; errore → attempts++, next_at con backoff 1 min → 6 h, dopo 8 tentativi resta con last_error_code
  test(to: string): Promise<SmtpTestResult>; // sincrono, errore tecnico senza la password
}
```

`to_enc` e `params_enc` cifrati con `k_system`; i link vivono solo in `params_enc` e nel corpo inviato.

- [ ] Test con un `Transport` finto in memoria: `enqueue` + `drain` consegnano; errore del trasporto → ritentato con backoff (orologio finto); nessun link e nessun indirizzo nei log catturati (`pino` con stream in memoria); template it/en con il nome di prodotto da `@kamino/brand`; `test()` con errore → `{ ok: false, error }` senza password.
- [ ] FAIL → implementa → PASS → commit `feat(server): send localized email through a durable outbox`.

### Task 10: quote

**Files:** Create `apps/server/src/quota/service.ts`, `apps/server/test/quota.test.ts`; Modify `apps/server/src/blobs/uploads.ts` (`missing` e `create` controllano la quota), `apps/server/src/routes/vaults.ts` (`quota.limitBytes`).

**Produces:**

```ts
export class QuotaService {
  constructor(db: Db, config: SystemConfigService);
  usage(userId: string): Promise<{ usedBytes: number; limitBytes: number | null }>; // somma dei blob distinti di tutti i vault non cancellati dell'utente
  assertRoom(userId: string, newBytes: number): Promise<void>; // usedBytes + newBytes > limit → QuotaExceeded (413 quota_exceeded)
}
```

Limite: `users.quota_bytes` (nuova colonna nullable) → `defaultQuotaBytes` → nessuno. Il controllo riguarda solo i byte di blob che il server non ha (Q-03: cancellazioni, rinomine e commit di contenuti già presenti passano sempre).

- [ ] Test: upload oltre la quota → 413; a quota piena un commit di cancellazione e una rinomina riescono; contenuto già presente in un altro vault dello stesso utente non conta due volte; `/vaults` riporta il limite.
- [ ] FAIL → implementa → PASS → commit `feat(server): enforce storage quotas on new bytes only`.

### Task 11: admin — utenti, salute, audit

**Files:** Create `apps/server/src/admin/users.ts`, `health.ts`, `audit.ts`, `apps/server/src/routes/admin.ts`, `apps/server/test/admin.test.ts`; Modify `apps/server/src/app.ts`, `apps/server/src/auth/http.ts` (`requireAdmin`: sessione, ruolo admin, TOTP attivo), `apps/server/src/realtime/hub.ts` (`closeUser` usato dal blocco).

**Produces:**

```ts
export class AdminUsers {
  list(): Promise<AdminUserList>;                         // solo aggregati (contatori, byte, livello)
  create(r: CreateUserRequest, actorId: string): Promise<CreateUserResponse>; // delivery email → Outbox("invite"), link → link restituito una volta
  update(id: string, r: UpdateUserRequest, actorId: string): Promise<AdminUser>; // ultimo admin attivo → LastAdmin (409)
  block(id: string, actorId: string): Promise<AdminUser>; // + hub.closeUser(id), sessioni revocate
  unblock(id: string, actorId: string): Promise<AdminUser>;
  resetLink(id: string, actorId: string): Promise<ResetLink>; // users.admin_reset_at = now, evento nel registro di sicurezza, email "admin_reset" al vecchio indirizzo se c'è SMTP
}
export async function systemHealth(deps: { db: Db; store: BlobStore; boss: Jobs; config: SystemConfigService; startedAt: Date; now: () => Date }): Promise<SystemHealth>;
export async function auditPage(db: Db, page: number): Promise<AuditPage>;
```

Rotte: `GET/POST /admin/users`, `GET/PATCH/DELETE /admin/users/:id` (`DELETE` → Task 12), `POST /admin/users/:id/{block,unblock,reset-link}`, `GET/PATCH /admin/config`, `POST /admin/config/smtp-test`, `GET /admin/health`, `GET /admin/audit?page=`. `POST /auth/forgot` usa l'`Outbox` quando c'è SMTP (risposta identica che l'utente esista o no).

- [ ] Test: utente non admin → 403; admin senza TOTP → 403; creazione con link e con email (outbox); `last_admin`; blocco → socket WS dell'utente chiusi subito e token rifiutati, sblocco → riprendono; reset-link visibile nel `/me` dell'utente e nel suo registro di sicurezza; salute con SMTP `off` quando non configurato; audit paginato con le azioni attese; **nessun nome di vault o path** in nessuna risposta admin (il test crea un vault con un nome riconoscibile e cerca la stringa in tutte le risposte); `forgot` con SMTP mette in outbox, senza no.
- [ ] FAIL → implementa → PASS → commit `feat(server): serve admin users, config, health and audit`.

### Task 12: cancellazione dell'utente con export

**Files:** Create `apps/server/src/users/deletion.ts`, `apps/server/src/jobs/export.ts`, `apps/server/src/jobs/finalize.ts`, `apps/server/src/routes/exports.ts`, `apps/server/test/user-deletion.test.ts`; Modify `db/schema.ts` (`exports`), `jobs/boss.ts`, `auth/service.ts` (stato `deleting` rifiuta login, sessioni e token), migrazione.

**Produces:**

```ts
export const DELETION_GRACE_MS = 7 * 24 * 3600_000;
export async function startUserDeletion(deps, userId: string, r: DeleteUserRequest, actorId: string): Promise<AdminUser>;
// confirmUsername ≠ username → 400; ultimo admin → 409 last_admin; sendZip senza SMTP → 409 smtp_not_configured
// status = deleting, deletion_scheduled_at = now + 7 g (o now senza export); sessioni revocate; hub.closeUser
export async function runExport(deps, userId: string): Promise<void>;   // un unico ZIP con una cartella per vault (zipStream), cifrato con chiave = HKDF(k_system, token) e salvato nel blob store; email "export_ready" con il link /exports/<token>
export async function finalizeDeletion(deps, userId: string): Promise<void>; // per ogni vault deleteVault senza conferma; export distrutto; utente anonimizzato (username/email → "deleted-<id>"), stato deleted
```

`GET /exports/:token`: nessuna sessione (il token è la prova); token sconosciuto o scaduto → `410 export_expired`. Il token non va mai nei log (l'URL della richiesta è già sostituito dal logger per le rotte con token: aggiungi `/exports/` all'elenco).

- [ ] Test: conferma sbagliata → 400; durante i 7 giorni login → rifiutato, token dei dispositivi → `user_blocked`; export scaricabile col token e identico ai vault; senza token o con un token sbagliato → 410; dopo `finalizeDeletion` DEK distrutte, blob eliminati, export distrutto, voce `user_deleted` nell'audit senza il link; il link non compare nei log.
- [ ] FAIL → implementa → PASS → commit `feat(server): delete users with an optional zip export and crypto-shredding`.

### Task 13: web app su admin ed email, chiusura di P2

**Files:** Modify `apps/web/src/mocks/browser.ts` (handler admin nell'elenco `real`), `apps/web/src/mocks/handlers.ts` (gruppo `adminHandlers` esportato); Create `apps/web/e2e/admin.spec.ts` (crea utente con link, blocca/sblocca, configurazione con un campo bloccato da env).

- [ ] Changeset (`@kamino/server` minor, `@kamino/web` patch); `docs/self-hosting.md` con le variabili SMTP e quote; HANDOVER; verifica completa; revisione finale con **un** subagente; correzioni con test; PR "M5: admin, quotas and email"; attesa del merge.

---

## Blocco P3 — Pairing (PR 3, branch `m6-pairing` da `main`)

### Task 14: pairing sul server

**Files:** Create `apps/server/src/pairing/service.ts`, `apps/server/src/routes/pairing.ts`, `apps/server/test/pairing.test.ts`; Modify `db/schema.ts` (`pairings`), `packages/protocol/src/devices-auth.ts` (`PairingClaimRequest`, `PairingClaimResponse`, `PairingClaimState`), `packages/protocol/src/ws.ts` (`pairing_request` in `ServerMessage`), `apps/server/src/realtime/hub.ts` (`sendToVault(vaultId, msg)`), migrazione.

**Produces:**

```ts
export const PAIRING_TTL_MS = 10 * 60_000;
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // niente 0/O, 1/I
export class PairingService {
  offer(vault: Vault, origin: { userId: string; deviceId?: string }, opts: { email: boolean }): Promise<PairingOffer>; // link = `obsidian://${PROTOCOL_ACTION}?server=<publicUrl>&token=<token>`
  state(pairingId: string, userId: string): Promise<PairingState>;
  claim(token: string, r: { deviceName: string; platform: string; pluginVersion: string }): Promise<{ claimId: string; claimSecret: string; verificationCode: string }>;
  // token usato → PairingAlreadyClaimed (409) e lo stato dell'origine mostra la richiesta già presa
  approve(pairingId: string, userId: string): Promise<PairingState>; // crea il dispositivo con VaultService.linkDevice
  deny(pairingId: string, userId: string): Promise<PairingState>;
  cancel(pairingId: string, userId: string): Promise<PairingState>;
  poll(claimId: string, claimSecret: string): Promise<PairingClaimState>; // approved → deviceToken una volta sola, poi "consumed"
}
```

Token, claim secret: 256 bit casuali, salvati solo come SHA-256. Flusso chiuso (approvato, rifiutato, annullato, scaduto) → `409 pairing_closed`. Rate limit su `claim` e `poll` con `auth/rate-limit.ts`. Email "pairing_link" con `?email=1`.

- [ ] Test: flusso completo → il nuovo dispositivo ottiene un token valido su `/device`; deny; cancel; scadenza (orologio finto); doppio claim → 409 e l'origine lo vede; `poll` con secret sbagliato → 404; secondo `poll` dopo `approved` non riconsegna il token; `pairing_request` arriva sul WS dei dispositivi del vault; vault di un altro utente → 404; il token del link non compare nei log.
- [ ] FAIL → implementa → PASS → commit `feat(server): pair devices with one-time links and a verification code`.

### Task 15: pairing nel plugin e nella web app, chiusura di P3

**Files:** Modify `apps/plugin/src/connection/real-server.ts` (`startPairing`, `claim`, polling con backoff fino alla scadenza), `apps/plugin/src/main.ts` (protocol handler: avviso se il vault non è vuoto), test del plugin; `apps/web/src/mocks/browser.ts` (handler di pairing nell'elenco `real`); Create `apps/server/test/engine-pairing.test.ts` (dispositivo collegato via pairing che sincronizza con il motore vero), `apps/web/e2e/pairing.spec.ts`.

- [ ] Test del plugin con `Http` finto: claim → codice mostrato → approvato → token salvato e motore avviato; negato → messaggio; vault non vuoto → avviso prima di procedere.
- [ ] Changeset (`@kamino/server` minor, `@kamino/plugin` minor, `@kamino/web` patch); HANDOVER (M4–M6 chiuse; test con una persona reale per l'uscita di M6); verifica completa; revisione finale con **un** subagente; correzioni con test; PR "M6: pairing with QR and magic link"; attesa del merge.
