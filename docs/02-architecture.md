# 02 — Architettura

> Stato: **approvato** (2026-11-06)
> Diagrammi (draw.io): [contesto e container](diagrams/01-containers.drawio) · [flusso di sync](diagrams/02-sync-flow.drawio) · [gerarchia delle chiavi](diagrams/03-key-hierarchy.drawio)

## 1. Panoramica

```
 ┌───────────────────────┐        HTTPS (REST)  +  WSS (push)        ┌──────────────────────────────┐
 │ Obsidian + plugin     │ ───────────────────────────────────────▶ │ kamino (container)           │
 │ (desktop / mobile)    │ ◀─────────────────────────────────────── │  Fastify: API + WS + static  │
 └───────────────────────┘                                           │  pg-boss workers             │
                                                                     │  crypto (keyring)            │
 ┌───────────────────────┐        HTTPS (REST, cookie di sessione)   │                              │
 │ Browser: web app      │ ───────────────────────────────────────▶ │                              │
 │ (React, servita dal   │                                           └───────┬───────────────┬──────┘
 │  server stesso)       │                                                   │               │
 └───────────────────────┘                                          ┌────────▼──────┐ ┌──────▼─────────────┐
                                                                    │ PostgreSQL    │ │ Blob storage        │
                                                                    │ metadati,     │ │ filesystem (volume) │
                                                                    │ journal, job  │ │ oppure S3/MinIO     │
                                                                    └───────────────┘ └─────────────────────┘
                                     (opzionale) SMTP ◀── server
```

Un'unica istanza applicativa (`kamino`) serve API REST, WebSocket e i file statici della web app. Postgres è l'unica fonte di verità per metadati, journal e code di job. I contenuti dei file vivono, cifrati, nel blob storage. Il TLS, quando c'è, è a carico di chi installa. Ci sono tre scenari di riferimento, ciascuno con il suo compose di esempio (N-02b):

| Scenario | TLS | Note |
|---|---|---|
| Casa / LAN | nessuno (HTTP) | il più semplice; **solo desktop**; avviso in UI |
| Tailscale / Cloudflare Tunnel | fornito dal servizio | nessuna porta aperta; Cloudflare vede il traffico in chiaro; limite di 100 MB per richiesta sul piano gratuito di Cloudflare, compatibile con i chunk da 4 MiB |
| Dominio pubblico | Caddy + Let's Encrypt | certificato automatico |

## 2. Monorepo

pnpm workspaces + Turborepo ([ADR-0002](adr/0002-monorepo-pnpm-turborepo.md)).

```
kamino/
├── apps/
│   ├── server/          Fastify, Drizzle, pg-boss, modulo crypto
│   ├── web/             React + Vite + shadcn/ui + Tailwind + TanStack Query + react-i18next
│   └── plugin/          plugin Obsidian (esbuild)
├── packages/
│   ├── protocol/        schemi zod, tipi, numero di versione del protocollo, codici errore
│   ├── sync-core/       logica pura di sync condivisa (vedi §5), property-based testing
│   ├── ui-diff/         componente di diff/merge su @codemirror/merge, usato da web e plugin
│   ├── i18n/            cataloghi di traduzione condivisi (stringhe comuni web/plugin)
│   ├── brand/           nome del prodotto, id plugin, prefissi: UNICA fonte (N-10)
│   └── tsconfig/, eslint-config/
├── docker/              Dockerfile, compose di esempio
├── docs/
└── release-names.json   registro macchina dei nomi in codice (vedi release-names.md)
```

Il pacchetto `brand` esporta costanti (`PRODUCT_NAME`, `PLUGIN_ID`, `ENV_PREFIX`, `PACKAGE_SCOPE`...). Gli identificatori che non possono leggere una costante a runtime (nome dei pacchetti npm, nome dell'immagine Docker) sono elencati in un unico file `docs/renaming.md` *(da creare in M0)* con la procedura di rinomina.

## 3. Scelte tecnologiche

| Area | Scelta | ADR |
|---|---|---|
| Server HTTP/WS | Fastify + `fastify-type-provider-zod` + `@fastify/websocket` | [0006](adr/0006-fastify.md) |
| ORM / migrazioni | Drizzle ORM + drizzle-kit, migrazioni eseguite all'avvio con lock | [0007](adr/0007-drizzle.md) |
| Job in background | pg-boss (solo Postgres) | [0008](adr/0008-pg-boss.md) |
| UI web | shadcn/ui + Tailwind CSS | [0009](adr/0009-shadcn-ui.md) |
| Diff/merge | `@codemirror/merge` (CodeMirror 6, lo stesso motore di Obsidian) | [0016](adr/0016-codemirror-merge.md) |
| Sync | journal append-only per vault in Postgres + cursori, nessun broker | [0003](adr/0003-change-journal-postgres.md) |
| Trasporto | scritture e upload via HTTP; push e stream delle modifiche via WebSocket | [0017](adr/0017-http-per-scritture-ws-per-push.md) |
| Crittografia | envelope encryption a riposo, non E2EE | [0010](adr/0010-envelope-encryption.md) |
| Deploy | immagine unica + Postgres; storage fs o S3 | [0013](adr/0013-deploy-immagine-unica.md) |
| Versioni | versione di prodotto unica (changesets) + protocollo intero | [0011](adr/0011-versionamento.md) |
| Log | pino (JSON) con redazione per allowlist | — |
| Metriche | prom-client, `/metrics` (aggregate) | — |
| Hash lato client | `@noble/hashes` (SHA-256 incrementale; WebCrypto non supporta digest incrementale) | — |
| Test | Vitest, fast-check, Playwright, test di integrazione multi-client | — |

## 4. Server (`apps/server`)

Moduli (cartelle) con confini espliciti; ogni modulo espone un'interfaccia di servizio, le rotte Fastify sono un sottile adattatore.

| Modulo | Responsabilità |
|---|---|
| `config` | Caricamento configurazione: env/secret → DB → default; precedenza "ambiente vince" ([ADR-0015](adr/0015-precedenza-configurazione.md)); validazione zod; espone anche "da dove viene ogni valore" alla UI admin. |
| `crypto` | **Modulo isolato**: keyring (KEK corrente + precedente), wrap/unwrap DEK, derivazione sottochiavi (HKDF), cifratura stream a segmenti dei blob, cifratura campi, HMAC deterministici. Nessuna dipendenza da DB o HTTP. Testato con vettori noti e property-based. |
| `auth` | Login, sessioni web (cookie), Argon2id, TOTP + codici di recupero, reset password, inviti, token dei dispositivi, rate limiting e lockout. |
| `users` | Ciclo di vita utente (attivo, bloccato, in cancellazione, cancellato), ruoli. |
| `quota` | Limiti per tipo (oggi `storage_bytes`), contabilità dell'uso, controllo preventivo sugli upload. |
| `vaults` | Vault, impostazioni, chiavi dati (DEK), export ZIP. |
| `devices` | Dispositivi, stato di sync derivato, revoca. |
| `pairing` | Token di abbinamento, codice di verifica, approvazione. |
| `sync` | Commit di operazioni, assegnazione della sequenza, rilevamento conflitti, stream del journal, hub WebSocket. |
| `blobs` | Sessioni di upload a chunk, adattatore di storage (`fs` / `s3`), download con Range, garbage collection. |
| `conflicts` | Registro conflitti, risoluzione. |
| `history` | Retention, cestino, ripristino, snapshot "alla data X". |
| `admin` | API admin: solo aggregati. Nessuna dipendenza verso moduli che restituiscono contenuti decifrati (verificato da un test di architettura sulle import). |
| `mail` | Trasporto SMTP (nodemailer), template localizzati, test di configurazione, outbox. |
| `audit` | Audit log append-only. |
| `jobs` | Registrazione dei worker pg-boss (vedi §7). |
| `observability` | Logger, metriche, health, `/version`. |
| `cli` | Comandi: `setup`, `admin reset-2fa`, `keys rotate`, `keys verify`, `backup create`, `backup verify`, `migrate`. Stesso binario del server. |

### 4.1 Autorizzazione

- Ogni rotta che restituisce o modifica contenuti di un vault verifica che il vault appartenga all'**utente della sessione** o al **dispositivo del token** (che appartiene a quel vault). **Non esiste bypass per il ruolo admin.**
- Le rotte `/api/admin/*` restituiscono solo aggregati; il modulo `admin` non importa servizi che decifrano.
- Test di autorizzazione dedicati: per ogni rotta di contenuto, un admin non proprietario riceve 404 (non 403, per non confermare l'esistenza).

### 4.2 Fan-out realtime

Il processo mantiene in memoria le connessioni WebSocket per vault. Dopo ogni commit il server emette `NOTIFY kamino_vault, '<vaultId>:<seq>'`; ogni istanza in `LISTEN` sveglia le connessioni di quel vault, che leggono dal journal le voci dopo il proprio cursore. Con un'istanza sola è un piccolo costo; con più istanze funziona senza modifiche (N-08).

### 4.3 Web app in HTTP

In un contesto non sicuro (HTTP fuori da `localhost`) i browser disabilitano `crypto.subtle`, `crypto.randomUUID` e altre API. La web app **non deve dipendere** da queste API: niente crittografia nel browser (la fa il server), ID generati dal server o con `crypto.getRandomValues`.

## 5. Logica condivisa (`packages/sync-core`)

Codice puro, senza I/O, orologio né casualità (ID e tempi arrivano come input), usato da plugin e server (e dal simulatore di test). Implementato in M1a (spec [`2026-11-09-m1a-sync-core-design.md`](superpowers/specs/2026-11-09-m1a-sync-core-design.md)):

- `paths`: normalizzazione dei path (NFC, separatori, `{config}`), chiave di collisione case-insensitive e "larga", rappresentabilità per piattaforma, suffissi `(1)`;
- `exclusions`: glob, categorie della configDir, esclusioni obbligatorie e predefinite;
- `arbiter` + `store`: le regole di commit del server (03 §5.3) come funzione pura `decide(vista, op)`; il server la chiama dentro la transazione, `MemoryStore` la usa in memoria (simulatore e oracolo dei test del server);
- `client`: il dispositivo come riduttore puro `step(stato, evento) → stato + effetti`, con `persist` sempre come primo effetto. L'**outbox è ricavata dall'indice** durevole (una op per file per invio); si salvano a parte solo le op inviate con esito ignoto, ripetute identiche. Comprende applicazione delle voci remote, regole automatiche (C-06) e collegamento con contenuto locale (D-07, V-05);
- `sim` (solo test): N client, rete che perde/duplica/riordina, crash anche a metà degli effetti.

Proprietà verificate con fast-check: **convergenza** (a fine scenario ogni client ha lo stato vivo del server, salvo file non rappresentabili o in conflitto dove è perdente) e **nessuna perdita** (nessun contenuto locale viene sovrascritto o cestinato se il server non lo ha; ogni contenuto sincronizzato è sul server come versione o candidata), più idempotenza delle op registrate e invarianti dell'arbitro. I controesempi trovati restano come test di regressione esatti.

## 6. Plugin (`apps/plugin`)

| Componente | Responsabilità |
|---|---|
| `transport` | Client REST (`requestUrl`) e WebSocket, riconnessione con backoff + jitter, negoziazione del protocollo. |
| `watcher` | Eventi del vault (`create`, `modify`, `delete`, `rename`) con debounce; soppressione dell'eco per i file scritti dal plugin stesso (confronto hash con l'indice). |
| `scanner` | Scansione incrementale all'avvio e al resume: confronto `mtime`+`size` con l'indice, hash solo se cambiati. Rileva modifiche fatte a Obsidian chiuso. |
| `index` | Stato locale per file: `fileId`, path, `versionId` base, hash, size, mtime. |
| `outbox` | Coda durevole delle operazioni locali non confermate. |
| `applier` | Applica le modifiche remote al vault (scrittura atomica: file temporaneo + rename dove l'adapter lo consente). |
| `ui` | Indicatore: barra di stato (desktop); icona nel ribbon e notice (tutte le piattaforme); su mobile, azione nell'intestazione della nota attiva dal livello Attenzione in su (vedi [design system](ui/design-system.md)). Pannello di stato, impostazioni, modali di onboarding, pairing, approvazione, conflitti (con `ui-diff`). |
| `protocol-handler` | `registerObsidianProtocolHandler('kamino', ...)` per QR/magic link. |

**Stato locale**: file JSON nella cartella del plugin (`<configDir>/plugins/<PLUGIN_ID>/`, sempre esclusa dal sync), scritti in modo atomico; l'indice è separato dalle impostazioni. Se le prestazioni su vault grandi lo richiedono, il builder può passare a IndexedDB con chiave per vault: la scelta è lasciata al builder, a patto che lo stato sopravviva al riavvio e la sua perdita sia recuperabile (vedi sotto).

**Perdita dello stato locale** (reinstallazione del plugin, cartella cancellata): il dispositivo si ricollega come in D-07 (contenuto locale presente → confronto, nessuna sovrascrittura).

**Mobile**: niente background ad app chiusa. Il WebSocket viene chiuso quando l'app va in background (`visibilitychange`) e riaperto al resume con un catch-up "tutto dopo N". In modalità Periodica non resta aperto alcun WebSocket.

**Bundle**: `@codemirror/state` e `@codemirror/view` sono esterni (forniti da Obsidian); `@codemirror/merge` viene incluso nel bundle e deve essere compatibile con la versione di CodeMirror di Obsidian (verificato nello spike R-3).

## 7. Job in background (pg-boss)

| Job | Frequenza | Funzione |
|---|---|---|
| `blob-gc` | giornaliero | mark-and-sweep: elimina i blob non referenziati da alcuna versione conservata (retention, cestino, conflitti aperti), con periodo di grazia di 24 h per upload recenti. |
| `retention-purge` | orario | elimina versioni oltre la retention e voci di cestino oltre 7 giorni (rispettando H-04). |
| `upload-cleanup` | orario | elimina sessioni di upload scadute e i chunk parziali. |
| `export-zip` | on demand | costruisce lo ZIP del vault (anche alla data X) in streaming su storage temporaneo cifrato, link a scadenza. |
| `user-deletion-finalize` | orario | finalizza le cancellazioni scadute (crypto-shredding + purge). |
| `quota-reconcile` | giornaliero | ricalcola l'uso reale e corregge eventuali derive del contatore incrementale. |
| `device-health` | orario | calcola i dispositivi fermi; oggi alimenta la dashboard, in futuro le notifiche (E-06). |
| `mail-send` | on demand | invio email dall'outbox, con retry. |

## 8. Deploy

- Immagine `kamino` multi-stage (Node LTS su base Alpine o distroless), utente non root, `HEALTHCHECK` su `/health/live`.
- All'avvio: la master key viene validata nel formato (prima di ogni connessione al database), poi migrazioni (advisory lock) → verifica/inizializzazione del key check → avvio worker → apertura porta. Oggi l'ordine è migrazioni → verifica, perché l'unica migrazione crea `key_check`; con la prima migrazione applicativa andrà riordinato (migrazione di `key_check` → verifica → resto), vedi la decisione R16 e il TODO in `apps/server/src/main.ts`.
- Volumi: `kamino-data` (blob su fs, se scelto), `postgres-data`.
- Configurazione completa via `KAMINO_*` e Docker secret (`KAMINO_MASTER_KEY_FILE`, `KAMINO_DATABASE_URL_FILE`, `KAMINO_SMTP_PASSWORD_FILE`...; la password del Postgres incluso nei compose arriva da `KAMINO_DB_PASSWORD` in `docker/.env` ed è incorporata nell'URL del database). L'elenco completo delle variabili sarà generato dallo schema zod di `config` e pubblicato nella documentazione.
- Tag immagine numerici: `2.1.0`, `2.1`, `2`, `latest`.

## 9. Versionamento e compatibilità

- **Versione di prodotto unica** per server, web app e plugin, gestita con changesets in modalità `fixed` ([ADR-0011](adr/0011-versionamento.md)).
- **Protocollo** con numero intero (`PROTOCOL_VERSION` in `packages/protocol`), incrementato solo per cambiamenti incompatibili. Server e plugin dichiarano il range supportato (`min..max`); alla connessione si usa il massimo comune. Se non c'è intersezione, il plugin mostra un messaggio chiaro ("aggiorna il plugin" / "il server va aggiornato") e non tenta di sincronizzare.
- Il server supporta almeno il protocollo corrente e il precedente, per dare tempo allo store di Obsidian di distribuire il nuovo plugin.
- `/version` restituisce `{ version, codename, protocol: { min, max }, commit, buildDate }`.
- Plugin: `manifest.json` (`version`, `minAppVersion`) e `versions.json` aggiornati dallo script di release.
- **Nome pubblico e store** *(scelta del tech lead)*: l'`id` di un plugin pubblicato nello store di Obsidian non si può cambiare, e da esso dipendono la cartella dello stato locale e l'URI `obsidian://`. Quindi il plugin **non viene inviato allo store finché il nome pubblico non è definitivo**. Fino ad allora si distribuisce tramite release GitHub installabili con BRAT. La scelta del nome è un prerequisito della prima pubblicazione sullo store, da collocare nella roadmap prima della 1.0.

## 10. Rischi tecnici e spike

Da affrontare in **M0** con prototipi usa-e-getta, prima di fissare i dettagli del protocollo:

| ID | Rischio | Spike | Se fallisce |
|---|---|---|---|
| R-1 | Le API di Obsidian (`readBinary`/`writeBinary`) leggono/scrivono file interi in memoria: un file da 500 MB su mobile può esaurire la memoria. | Su iPhone e Android reali: lettura, hash incrementale, upload a chunk e scrittura di file da 50/200/500 MB; verificare se esistono API di append binario o lettura parziale utilizzabili. | Limite effettivo per mobile più basso (es. 100 MB), file sopra soglia sincronizzati solo dai desktop e segnalati come "solo desktop" sui dispositivi mobili. |
| R-2 | Rilevamento del tipo di rete su Android (Network Information API nella WebView) e su iOS. | Verificare `navigator.connection` sulle versioni attuali di Obsidian mobile. | Su Android si applica la stessa regola di iOS (sempre "a consumo"). |
| R-3 | `@codemirror/merge` nel plugin con la versione di CodeMirror fornita da Obsidian. | Bundle di prova con vista di merge in un modal, desktop e mobile. | Vista di diff semplificata nel plugin (due pannelli in sola lettura + scelta), merge manuale solo dalla web app. |
| R-4 | Comportamento del WebSocket su mobile in background/resume e con reti che cambiano. | Prototipo di connessione + catch-up. | Solo polling su mobile, WebSocket su desktop. |
| R-5 | Eventi del vault durante operazioni massicce (cartella con migliaia di file spostata, sync di Obsidian Git o altri plugin attivi). | Misure su vault sintetico da 10.000 file. | Batch più aggressivo e scansione di riconciliazione al posto degli eventi singoli. |

## 11. Evoluzioni previste e come il design le abilita

- **Merge automatico a 3 vie** (S-14/C-07): ogni versione registra la propria base; il server può decifrare e calcolare il merge. Nessuna modifica al protocollo, solo un nuovo esito di commit (`merged`).
- **CRDT (es. Yjs)** per l'editing collaborativo: richiederebbe un canale per-documento, lo stato CRDT persistito accanto al testo, l'integrazione profonda con l'editor di Obsidian e una strategia per i file modificati fuori da Obsidian. Costo alto, valore basso per il caso d'uso attuale (un utente, più dispositivi): fuori scope. Vedi [ADR-0005](adr/0005-conflitti-v1-rileva-e-scegli.md).
- **Scalabilità orizzontale**: stato condiviso solo in Postgres e blob storage, fan-out via LISTEN/NOTIFY, job su pg-boss (già multi-worker), sessioni nel DB, storage S3. Mancherebbero: sticky session non necessarie, rate limiting distribuito (oggi in memoria), lock per l'export.
- **Notifiche** (E-06): outbox di eventi già presente; i job `device-health` e quota producono gli eventi.
