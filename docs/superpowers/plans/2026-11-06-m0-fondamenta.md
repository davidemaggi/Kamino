# M0 — Fondamenta: piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** monorepo che compila, testa e si rilascia; server che parte solo con la master key giusta ed espone health e versione; scheletri di web app e plugin; immagine Docker e compose; CI; esiti degli spike R-1…R-5.

**Architecture:** monorepo pnpm + Turborepo con pacchetti condivisi (`brand`, `protocol`) consumati da `apps/server` (Fastify + Drizzle), `apps/web` (Vite + React + shadcn/ui) e `apps/plugin` (Obsidian, esbuild). Il server carica la configurazione da env/secret, verifica la master key contro un valore di controllo in Postgres, applica le migrazioni sotto advisory lock e solo dopo apre la porta.

**Tech Stack:** Node LTS corrente (24.x), pnpm 10, Turborepo, TypeScript strict, zod 4, Fastify 5 + `fastify-type-provider-zod`, Drizzle ORM + drizzle-kit + `postgres` (postgres.js), pino, Vitest, `@testcontainers/postgresql`, Vite + React + Tailwind + shadcn/ui + react-i18next, esbuild, changesets, commitlint, GitHub Actions. Versioni: l'ultima stabile al momento dell'esecuzione, **fissate** nel lockfile.

**Spec:** `docs/00-vision.md` … `docs/05-data-model.md`, `docs/adr/`, `docs/06-roadmap.md` (sezione M0), `docs/release-names.md`.

## Global Constraints

- TypeScript `strict: true` + `noUncheckedIndexedAccess: true` + `exactOptionalPropertyTypes: true` in tutti i pacchetti.
- Il nome del prodotto e i prefissi vengono **solo** da `packages/brand` (N-10). Nessuna stringa `kamino`/`KAMINO_` scritta a mano fuori da `brand`, salvo i nomi di pacchetto npm, il nome dell'immagine Docker e i file elencati in `docs/renaming.md`.
- Variabili d'ambiente con prefisso `KAMINO_`; ogni segreto accetta anche la variante `<NOME>_FILE` (Docker secret).
- Lessico a tema (clone, Jango, Ordine 66, Kaminoani, archivi Jedi) solo in codice, log, commenti; mai nelle stringhe UI.
- Codice, identificatori, commit in inglese; documentazione in italiano.
- Conventional Commits su ogni commit.
- Plugin: nessuna API Node/Electron; `isDesktopOnly: false`; `id` del plugin senza la parola "obsidian".
- Gli script di `package.json` devono funzionare su Windows, macOS e Linux (niente bash-only; usare script `tsx` o Node).
- Log: mai path di file utente, contenuti, master key, token.
- Versione di prodotto unica; tutte le versioni `0.x.y` e `1.0.y` si chiamano **Ash**.

## Review Focus

1. Master key fornita come file Docker secret con newline finale (`\n` o `\r\n`) → deve essere accettata identica alla stessa chiave senza newline. → test in Task 6.
2. Master key in formato sbagliato (hex invece di base64, lunghezza ≠ 32 byte) → il server non parte e il messaggio dice il formato atteso e come generarne una (`kamino keys generate`), senza stampare il valore. → test in Task 6.
3. Due istanze del server avviate insieme su un DB vuoto → le migrazioni girano una volta sola, la seconda istanza attende e parte. → test in Task 5.
4. Variabile d'ambiente impostata a stringa vuota (`KAMINO_PUBLIC_URL=` nel compose) → trattata come non impostata (si applica il default o l'errore di obbligatorietà), non come valore vuoto. → test in Task 4.
5. `/health/ready` con Postgres irraggiungibile → `503` con `{ status: "unavailable", checks: { database: "down" } }` entro 2 s, non un timeout o un crash. → test in Task 5.

---

### Task 1: Monorepo e tooling di base

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json`, `.editorconfig`, `.gitattributes` (`* text=auto eol=lf`), `.gitignore`, `.nvmrc`, `vitest.workspace.ts`
- Create: `packages/tsconfig/` (preset `node.json`, `react.json`, `obsidian.json`)
- Modify: `README.md` (descrizione breve, link a `docs/`)

**Interfaces:**
- Produces: script root `pnpm build | typecheck | lint | test | format`, ognuno delegato a `turbo run <task>`; ogni pacchetto definisce `typecheck`, `lint`, `test`, `build` (dove serve).

- [ ] **Step 1:** Creare i file di configurazione. `pnpm-workspace.yaml` include `apps/*` e `packages/*`. `turbo.json`: `build` dipende da `^build`, output `dist/**`; `test` e `typecheck` dipendono da `^build`.
- [ ] **Step 2:** Verificare: `pnpm install && pnpm typecheck && pnpm lint` → exit 0 (nessun pacchetto ancora: turbo riporta 0 task).
- [ ] **Step 3: Commit** — `chore: initialize pnpm + turborepo monorepo`

### Task 2: `packages/brand`

**Files:**
- Create: `packages/brand/package.json` (`@kamino/brand`, privato), `src/index.ts`, `src/index.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const PRODUCT_NAME: string;        // "Kamino"
  export const PRODUCT_SLUG: string;        // "kamino"  (URI obsidian://, nomi tecnici)
  export const PLUGIN_ID: string;           // "kamino-sync"
  export const ENV_PREFIX: string;          // "KAMINO_"
  export const PACKAGE_SCOPE: string;       // "@kamino"
  export function envName(key: string): string;  // envName("PUBLIC_URL") === "KAMINO_PUBLIC_URL"
  ```

- [ ] **Step 1: Test** — `envName("PUBLIC_URL")` è `"KAMINO_PUBLIC_URL"`; `PLUGIN_ID` non contiene `"obsidian"`; `PRODUCT_SLUG` corrisponde a `/^[a-z][a-z0-9-]*$/`.
- [ ] **Step 2:** `pnpm --filter @kamino/brand test` → FAIL.
- [ ] **Step 3:** Implementare le costanti.
- [ ] **Step 4:** test → PASS.
- [ ] **Step 5:** Creare `docs/renaming.md`: elenco dei punti che non leggono `brand` (nomi dei pacchetti npm `@kamino/*`, immagine Docker `kamino`, `manifest.json` del plugin generato in build, workflow CI) e la procedura di rinomina.
- [ ] **Step 6: Commit** — `feat(brand): add single source for product naming`

### Task 3: `packages/protocol` (versione, errori, negoziazione)

**Files:**
- Create: `packages/protocol/package.json` (`@kamino/protocol`), `src/version.ts`, `src/errors.ts`, `src/version-info.ts`, `src/index.ts`, `src/*.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const PROTOCOL_VERSION = 1;
  export const PROTOCOL_MIN_SUPPORTED = 1;
  export type ProtocolRange = { min: number; max: number };
  export function negotiateProtocol(client: ProtocolRange, server: ProtocolRange):
    { ok: true; version: number } | { ok: false; reason: "client_too_old" | "server_too_old" };
  export const ErrorCode: z.ZodEnum<[...]>;   // tutti i codici di 03 §5.4 + cursor_too_old, hash_mismatch, stale_resolution, pairing_already_claimed, unauthorized, not_found, internal
  export const ErrorBody: z.ZodObject<...>;   // { error: { code, message, retryable, details? } }
  export const VersionInfo: z.ZodObject<...>; // { version, codename, protocol: {min,max}, commit, buildDate }
  ```

- [ ] **Step 1: Test** —
  - `negotiateProtocol({min:1,max:3},{min:2,max:4})` → `{ ok: true, version: 3 }`
  - `negotiateProtocol({min:1,max:1},{min:2,max:3})` → `{ ok: false, reason: "client_too_old" }`
  - `negotiateProtocol({min:4,max:5},{min:2,max:3})` → `{ ok: false, reason: "server_too_old" }`
  - `ErrorCode.options` contiene `"quota_exceeded"`, `"device_revoked"`, `"protocol_unsupported"`, `"cursor_too_old"`.
  - `VersionInfo.parse` rifiuta un oggetto senza `codename`.
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** Implementare.
- [ ] **Step 4:** test → PASS.
- [ ] **Step 5: Commit** — `feat(protocol): add protocol version negotiation and error catalog`

### Task 4: Release tooling e registro dei nomi in codice

**Files:**
- Create: `.changeset/config.json` (`fixed: [["@kamino/server","@kamino/web","@kamino/plugin"]]`, pacchetti `packages/*` privati e ignorati), `commitlint.config.js`, `release-names.json`, `scripts/release-names.ts`, `scripts/release-names.test.ts`
- Modify: `package.json` root (script `release-names:check`, devDeps)

**Interfaces:**
- Produces:
  ```ts
  type Registry = { entries: { range: string; codename: string; date: string | null; notes?: string }[] };
  // range: "0.x", "1.0", "1.1", "2.0", ... (MAJOR.MINOR, oppure "0.x")
  export function codenameFor(version: string, registry: Registry): string;  // lancia se manca
  export function validateRegistry(registry: Registry): string[];            // elenco errori, [] se valido
  ```
  `release-names.json` iniziale: `0.x → Ash`, `1.0 → Ash`.

- [ ] **Step 1: Test** —
  - `codenameFor("0.3.7", reg) === "Ash"`, `codenameFor("1.0.4", reg) === "Ash"`.
  - con `1.1 → Alison`: `codenameFor("1.1.2", reg) === "Alison"`.
  - `codenameFor("1.2.0", reg)` lancia `Error` con messaggio che contiene `"1.2"`.
  - `validateRegistry` segnala: `2.0 → Cody` (lettera ≠ B), due voci con `Rex` (riuso, case-insensitive), `1.1 → Ash` (Ash riservato a 0.x e 1.0).
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** Implementare; lo script CLI `pnpm release-names:check` valida il registro e verifica che la versione corrente di `apps/server/package.json` abbia un nome.
- [ ] **Step 4:** test → PASS; `pnpm release-names:check` → exit 0.
- [ ] **Step 5: Commit** — `build: add changesets, commitlint and codename registry`

### Task 5: Server — config, app Fastify, health, version, DB e migrazioni

**Files:**
- Create: `apps/server/package.json` (`@kamino/server`), `tsconfig.json`, `src/config/schema.ts`, `src/config/load.ts`, `src/config/load.test.ts`, `src/observability/logger.ts`, `src/observability/logger.test.ts`, `src/app.ts`, `src/routes/health.ts`, `src/routes/version.ts`, `src/db/client.ts`, `src/db/schema.ts`, `src/db/migrate.ts`, `drizzle/` (migrazione iniziale), `src/main.ts`, `test/helpers/postgres.ts`, `test/app.test.ts`, `test/migrate.test.ts`, `src/build-info.ts`

**Interfaces:**
- Consumes: `@kamino/brand` (`envName`), `@kamino/protocol` (`VersionInfo`, `PROTOCOL_VERSION`, `PROTOCOL_MIN_SUPPORTED`), `codenameFor` + `release-names.json` (Task 4) per calcolare il codename in `build-info.ts` al momento della build.
- Produces:
  ```ts
  // config
  export type ConfigSource = "env" | "file" | "default";   // "db" arriverà in M5
  export type Config = { publicUrl: string; port: number; databaseUrl: string; masterKey: string; logLevel: "debug"|"info"|"warn"|"error" };
  export function loadConfig(env: Record<string, string | undefined>, readFile?: (p: string) => string):
    { config: Config; sources: Record<keyof Config, ConfigSource> };
  // env: KAMINO_PUBLIC_URL (obbligatoria), KAMINO_PORT (default 8080), KAMINO_DATABASE_URL | _FILE (obbligatoria),
  //      KAMINO_MASTER_KEY | KAMINO_MASTER_KEY_FILE (obbligatoria), KAMINO_LOG_LEVEL (default "info")
  export class ConfigError extends Error { readonly issues: string[] }

  // app
  export function buildApp(deps: { config: Config; db: Db; logger: Logger; buildInfo: BuildInfo }): FastifyInstance;
  // GET /health/live  → 200 { status: "ok" }
  // GET /health/ready → 200 { status: "ok", checks: { database: "up" } } | 503 { status: "unavailable", checks: { database: "down" } }
  // GET /version      → 200 VersionInfo (codename da release-names.json incluso in build-info)

  // migrazioni
  export function runMigrations(db: Db): Promise<void>;  // pg_advisory_lock(<costante>) attorno a drizzle migrate
  ```
  Logger: pino con `redact` su `masterKey`, `*.token`, `*.password`, `req.headers.authorization`, `req.headers.cookie`.

- [ ] **Step 1: Test config (`load.test.ts`)** —
  - env minimale valido → `config.port === 8080`, `sources.port === "default"`.
  - `KAMINO_DATABASE_URL_FILE` → legge dal file, `sources.databaseUrl === "file"`; se sono impostate sia la variabile sia `_FILE` → `ConfigError` ("usa solo una delle due").
  - **Review Focus 4:** `KAMINO_PUBLIC_URL=""` → `ConfigError` con un issue che nomina `KAMINO_PUBLIC_URL`; `KAMINO_PORT=""` → `port === 8080`.
  - `KAMINO_PORT="abc"` → `ConfigError`.
- [ ] **Step 2: Test logger** — un log con `{ masterKey: "x", headers: { authorization: "Bearer y" } }` non contiene `"x"` né `"y"` nell'output serializzato.
- [ ] **Step 3: Test app (`app.test.ts`, Postgres via testcontainers)** —
  - `GET /health/live` → 200.
  - `GET /health/ready` con DB su → 200 `checks.database === "up"`.
  - **Review Focus 5:** con un `Db` che punta a una porta chiusa → 503 `{ status: "unavailable", checks: { database: "down" } }` e la risposta arriva in < 2000 ms (timeout della query di ping: 1000 ms).
  - `GET /version` → valida contro `VersionInfo`, `codename === "Ash"`, `protocol` = `{ min: PROTOCOL_MIN_SUPPORTED, max: PROTOCOL_VERSION }`.
- [ ] **Step 4: Test migrazioni (`migrate.test.ts`)** — **Review Focus 3:** due `runMigrations` lanciate in parallelo su due connessioni allo stesso DB vuoto → entrambe risolvono senza errori, la tabella `__drizzle_migrations` contiene ogni migrazione una sola volta.
- [ ] **Step 5:** test → FAIL.
- [ ] **Step 6:** Implementare. Schema iniziale Drizzle: solo la tabella `key_check` (`kek_id text pk`, `check_value bytea not null`, `created_at timestamptz not null default now()`, `retired_at timestamptz null`) come da [05 §3](../../05-data-model.md). `main.ts`: `loadConfig` → logger → db → (Task 6: verifica chiave) → `runMigrations` → `buildApp().listen` ; `SIGTERM` → `app.close()` → chiusura DB.
- [ ] **Step 7:** test → PASS.
- [ ] **Step 8: Commit** — `feat(server): add config, health, version endpoints and migrations`

### Task 6: Server — master key: caricamento, verifica, CLI

**Files:**
- Create: `apps/server/src/crypto/keyring.ts`, `src/crypto/keyring.test.ts`, `src/crypto/key-check.ts`, `test/key-check.test.ts`, `src/cli/index.ts`, `src/cli/commands/{migrate,keys-generate,keys-verify}.ts`, `test/cli.test.ts`
- Modify: `apps/server/src/main.ts` (verifica prima delle migrazioni applicative), `package.json` (`bin: { kamino: dist/cli/index.js }`)

**Interfaces:**
- Consumes: `Config.masterKey` (Task 5), `Db`, tabella `key_check`.
- Produces:
  ```ts
  export type Kek = { id: string; key: Uint8Array };   // id = primi 16 hex di SHA-256("kamino-kek-id" ‖ key)
  export function parseMasterKey(raw: string): Kek;    // base64 (standard o url-safe) di esattamente 32 byte; trim di spazi e newline
  export class MasterKeyError extends Error {}
  export function generateMasterKey(): string;         // base64 di 32 byte casuali
  export function ensureKeyCheck(db: Db, kek: Kek): Promise<"created" | "verified">;
  // tabella vuota → crea check_value = AES-256-GCM(kek, "kamino-key-check", AAD = kek.id) → "created"
  // riga attiva con stesso kek_id e decifratura ok → "verified"
  // kek_id diverso o decifratura fallita → MasterKeyError("master key does not match this database")
  ```
  CLI: `kamino migrate`, `kamino keys generate` (stampa una nuova chiave su stdout), `kamino keys verify` (carica config, esegue `ensureKeyCheck` in sola lettura: exit 0 se `verified`, exit 1 altrimenti).

- [ ] **Step 1: Test `keyring`** —
  - **Review Focus 1:** `parseMasterKey(k + "\n").id === parseMasterKey(k).id` e idem con `"\r\n"`.
  - **Review Focus 2:** chiave hex da 64 caratteri → `MasterKeyError` il cui messaggio contiene `"base64"`, `"32 bytes"` e `"kamino keys generate"`, e **non** contiene la chiave fornita; base64 di 16 byte → `MasterKeyError`.
  - `parseMasterKey(generateMasterKey())` non lancia.
- [ ] **Step 2: Test `key-check` (Postgres reale)** — prima chiamata → `"created"`; seconda con la stessa chiave → `"verified"`; con un'altra chiave → `MasterKeyError`.
- [ ] **Step 3: Test CLI** — `keys generate` stampa una stringa accettata da `parseMasterKey`; `keys verify` con chiave giusta → exit 0, sbagliata → exit 1 con messaggio su stderr.
- [ ] **Step 4: Test avvio** — `main` con chiave sbagliata su DB già inizializzato → il processo termina con exit code ≠ 0 **senza** aprire la porta (verificato tentando una connessione TCP).
- [ ] **Step 5:** test → FAIL. **Step 6:** implementare con `node:crypto` (`createCipheriv('aes-256-gcm')`). **Step 7:** test → PASS.
- [ ] **Step 8: Commit** — `feat(server): verify master key at startup and add key CLI`

### Task 7: Web app — scheletro

**Files:**
- Create: `apps/web/` (Vite + React + TS), `tailwind` config, `components.json` (shadcn), `src/main.tsx`, `src/i18n/index.ts`, `src/i18n/locales/{it,en}.json`, `src/theme/ThemeProvider.tsx`, `src/pages/AboutPage.tsx`, `src/pages/AboutPage.test.tsx`, `src/api/client.ts`
- Modify: `apps/server/src/app.ts` (servire `apps/web/dist` con `@fastify/static`, fallback SPA su `index.html` per le rotte non `/api`, `/health`, `/version`)

**Interfaces:**
- Consumes: `GET /version` → `VersionInfo`.
- Produces: `ThemeProvider` con `theme: "light" | "dark" | "system"` persistito in `localStorage`; i18n con lingua iniziale da `navigator.language` (`it*` → `it`, altrimenti `en`).

- [ ] **Step 1: Test `AboutPage`** — con `/version` mockato (`version: "0.1.0", codename: "Ash"`) mostra `"0.1.0"` e `"Ash"`; in `it` l'etichetta è `"Versione"`, in `en` `"Version"`; nessuna stringa UI contiene termini del lessico a tema (test che scorre i JSON delle traduzioni e rifiuta `/clone|jango|ordine 66|kaminoan|jedi/i`).
- [ ] **Step 2:** FAIL → **Step 3:** implementare (UI minimale e provvisoria: il design system arriva dalla Fase UI) → **Step 4:** PASS.
- [ ] **Step 5:** test server: `GET /` restituisce l'`index.html` della build quando presente.
- [ ] **Step 6: Commit** — `feat(web): add web app skeleton with i18n, theme and about page`

### Task 8: Plugin — scheletro

**Files:**
- Create: `apps/plugin/package.json` (`@kamino/plugin`), `esbuild.config.mjs`, `scripts/write-manifest.ts`, `versions.json`, `src/main.ts`, `src/settings/SettingsTab.ts`, `src/i18n/{index.ts,it.json,en.json}`, `src/__mocks__/obsidian.ts`, `test/manifest.test.ts`, `test/settings.test.ts`

**Interfaces:**
- Consumes: `@kamino/brand` (`PLUGIN_ID`, `PRODUCT_NAME`), codename da `release-names.json` iniettato in build.
- Produces: build in `apps/plugin/dist/` con `main.js`, `manifest.json`, `styles.css`. `manifest.json` generato da `write-manifest.ts`: `{ id: PLUGIN_ID, name: PRODUCT_NAME, version, minAppVersion, description, author, isDesktopOnly: false }`. esbuild: `external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"]`, formato `cjs`.

- [ ] **Step 1: Test manifest** — il manifest generato ha `isDesktopOnly === false`, `id` senza `"obsidian"`, `version` uguale a `package.json`; `versions.json` contiene la chiave `version` con valore `minAppVersion`.
- [ ] **Step 2: Test bundle** — il `main.js` buildato non contiene `require("fs")`, `require("path")`, `require("electron")`, `require("crypto")` (regex sul bundle).
- [ ] **Step 3: Test settings** — con il mock di `obsidian`, la tab delle impostazioni mostra versione e `"Ash"`; lingua `it` se `moment.locale()` inizia con `it`.
- [ ] **Step 4:** FAIL → **Step 5:** implementare → **Step 6:** PASS.
- [ ] **Step 7: Commit** — `feat(plugin): add obsidian plugin skeleton`

### Task 9: Docker e compose per i tre scenari

**Files:**
- Create: `docker/Dockerfile`, `.dockerignore`, `docker/compose.lan.yml`, `docker/compose.tunnel.yml`, `docker/compose.caddy.yml`, `docker/Caddyfile.example`, `docker/.env.example`, `docs/self-hosting.md` (bozza: i tre scenari, generare e custodire la master key)

**Interfaces:**
- Produces: immagine con utente non root, `ENTRYPOINT ["node","dist/main.js"]`, `HEALTHCHECK` su `/health/live`, web app inclusa in `public/`. I compose usano `secrets: kamino_master_key` → `KAMINO_MASTER_KEY_FILE=/run/secrets/kamino_master_key`. `compose.tunnel.yml` include `cloudflared` come servizio opzionale (profilo `cloudflare`) e documenta Tailscale nei commenti.

- [ ] **Step 1:** Scrivere Dockerfile multi-stage (`pnpm deploy --prod` per `@kamino/server`).
- [ ] **Step 2: Verifica** — `docker compose -f docker/compose.lan.yml up -d --build`, poi `curl -fsS http://localhost:8080/health/ready` → `{"status":"ok",...}` e `curl -fsS http://localhost:8080/version` → `codename":"Ash"`.
- [ ] **Step 3: Verifica** — riavvio con un secret contenente un'altra chiave → il container esce (`docker compose ps` mostra `exited`), log con `master key does not match this database`.
- [ ] **Step 4:** `docker image ls` → dimensione dell'immagine annotata in `docs/self-hosting.md` (obiettivo < 250 MB).
- [ ] **Step 5: Commit** — `build(docker): add image and compose examples for lan, tunnel and caddy`

### Task 10: CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1:** Job su `ubuntu-latest` e `windows-latest` (matrice): `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm release-names:check`. Su Linux anche: commitlint sui commit della PR, `docker build`. I test con testcontainers girano solo su Linux (skip esplicito su Windows con `describe.skipIf`).
- [ ] **Step 2: Verifica** — `act` o push su un branch → workflow verde.
- [ ] **Step 3: Commit** — `ci: add lint, typecheck, test, build and docker jobs`

### Task 11: CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (creato in fase di design; aggiornare comandi reali e struttura verificati in questa milestone)

- [ ] **Step 1:** Verificare che ogni comando elencato in `CLAUDE.md` esegua con successo; correggere quelli che non corrispondono.
- [ ] **Step 2: Commit** — `docs: update CLAUDE.md with verified commands`

### Task 12: Spike R-1…R-5 (usa e getta)

Prototipi **fuori** da `apps/` (cartella `spikes/`, esclusa dal workspace pnpm e cancellata a fine milestone). Ogni spike produce `docs/spikes/R-n.md` con: domanda, setup (dispositivi, versioni di Obsidian), misure, conclusione, impatto su ADR/requisiti. Richiedono **dispositivi reali** (iPhone, Android, desktop): il committente esegue i test sul telefono seguendo le istruzioni del documento.

- [ ] **R-1 File grandi su mobile:** plugin di prova che legge con `vault.adapter.readBinary` file da 50/200/500 MB, calcola SHA-256 incrementale con `@noble/hashes`, li invia a chunk da 4 MiB a un server di prova e li riscrive con `writeBinary`. Misurare memoria e tempo; verificare l'esistenza di API di lettura parziale/append binario. Conclusione: limite effettivo per mobile.
- [ ] **R-2 Tipo di rete:** valore di `navigator.connection?.type` / `effectiveType` su Android e iOS in Wi-Fi e dati mobili.
- [ ] **R-3 `@codemirror/merge` nel plugin:** vista di merge in un modal su desktop e mobile con CodeMirror di Obsidian esterno; annotare versioni compatibili.
- [ ] **R-4 WebSocket su mobile:** comportamento a background/resume, cambio Wi-Fi ↔ dati; tempo di riconnessione + catch-up.
- [ ] **R-5 Eventi massivi:** vault sintetico da 10.000 file; spostare una cartella da 2.000 file; contare e temporizzare gli eventi `rename` ricevuti.
- [ ] **Chiusura:** aggiornare `02-architecture.md` §10 con gli esiti; se un esito cambia una decisione, nuova ADR. Cancellare `spikes/`.
- [ ] **Commit** — `docs(spikes): record findings for R-1..R-5`
