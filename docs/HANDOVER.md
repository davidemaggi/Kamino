# Handover — stato del lavoro

> **Da leggere per primo** quando si riprende il lavoro (anche da un altro PC).
> Questo file è mantenuto **sempre aggiornato, committato e pushato** dopo ogni task completato o decisione rilevante.

**Ultimo aggiornamento:** 2026-11-09 — Fase UI, sotto-fase 4c (area admin) implementata sul branch `ui-web-admin`: con la sua PR la **fase UI è completa**. Prossimo: piano di M1.

## Dove siamo

| Fase | Stato |
|---|---|
| Brainstorming e design (`docs/00`–`05`, ADR) | ✅ approvato 2026-11-06 |
| Roadmap (`docs/06-roadmap.md`) | ✅ proposta |
| **M0 — Fondamenta** (`docs/superpowers/plans/2026-11-06-m0-fondamenta.md`) | ✅ completata sul branch (spike da eseguire su dispositivi reali) |
| Fase UI — sotto-fase 1: fondamenta del design system (spec `docs/superpowers/specs/2026-11-07-ui-fondamenta-design.md`, piano `docs/superpowers/plans/2026-11-07-ui-fondamenta.md`) | ✅ mergiata su `main` (PR #2, 2026-11-08) |
| Fase UI — sotto-fase 2: pannello di stato e risoluzione conflitti (plugin) (spec `docs/superpowers/specs/2026-11-08-ui-stato-conflitti-design.md`, piano `docs/superpowers/plans/2026-11-08-ui-stato-conflitti.md`) | ✅ mergiata su `main` (PR #3, 2026-11-08) |
| Fase UI — sotto-fase 3: onboarding, collegamento e impostazioni (plugin) (spec `docs/superpowers/specs/2026-11-08-ui-onboarding-design.md`, piano `docs/superpowers/plans/2026-11-08-ui-onboarding.md`) | ✅ mergiata su `main` (PR #4, 2026-11-08) |
| Fase UI — sotto-fase 4a: web app, struttura e account (spec `docs/superpowers/specs/2026-11-08-ui-web-shell-account-design.md`, piano `docs/superpowers/plans/2026-11-08-ui-web-shell-account.md`) | ✅ implementata, rivista (5 importanti + 8 minori corretti), provata dal committente; logo aggiunto; mergiata su `main` (PR #5) |
| Fase UI — sotto-fase 4b: area utente della web app (spec `docs/superpowers/specs/2026-11-08-ui-web-user-area-design.md`, piano `docs/superpowers/plans/2026-11-08-ui-web-user-area.md`) | ✅ implementata, rivista (7 importanti + 9 minori corretti); mergiata su `main` (PR #6) |
| Fase UI — sotto-fase 4c: area admin della web app (spec `docs/superpowers/specs/2026-11-08-ui-web-admin-design.md`, piano `docs/superpowers/plans/2026-11-08-ui-web-admin.md`) | ✅ implementata, rivista (5 importanti + 8 minori corretti); PR #7 aperta, in attesa di prova e merge |
| M1 — divisa in M1a (sync-core), M1b (crypto + auth), M1c (vault/file/blob/commit sul server), M1d (motore del plugin, dopo gli spike) | 🔧 M1a: spec `docs/superpowers/specs/2026-11-09-m1a-sync-core-design.md` in revisione, branch `m1a-sync-core` |
| M2…M7 | ⏳ |

**Branch di lavoro:** `m0-fondamenta` (pushato su `origin`, CI verde). `main` contiene solo il commit iniziale.
**Metodo:** M0 è stata eseguita con *subagent-driven-development*. **Dalla fase UI in poi lo standard è *executing-plans* nella sessione corrente**, a blocchi con checkpoint e una sola revisione finale del branch con un subagente (meno token; vedi `CLAUDE.md`).

### Task di M0

| # | Task | Stato |
|---|---|---|
| 1 | Monorepo e tooling | ✅ |
| 2 | `packages/brand` | ✅ |
| 3 | `packages/protocol` | ✅ |
| 4 | Release tooling + registro nomi in codice | ✅ |
| 5 | Server: config, health, version, DB, migrazioni | ✅ |
| 6 | Server: master key, verifica all'avvio, CLI | ✅ |
| 7 | Web app: scheletro | ✅ |
| 8 | Plugin: scheletro | ✅ |
| 9 | Docker + compose (LAN, tunnel, Caddy) + `docs/self-hosting.md` | ✅ |
| 10 | CI GitHub Actions | ✅ |
| 11 | Verifica comandi di `CLAUDE.md` | ✅ (+ `pnpm format:check` in CI) |
| 12 | Spike R-1…R-5 | ✅ prototipi e istruzioni (`spikes/`, `docs/spikes/`); ⏳ esecuzione su dispositivi e chiusura |
| — | Revisione finale dell'intero branch | ✅ 0 critici, 1 importante + 9 minori corretti in un giro, ricontrollati |

## Prossimi passi

1. **Chiudere la sotto-fase 4c (PR #7):** prova del committente nel browser (pannello "Dati finti", accesso come `admin`), merge della PR. Con questo la fase UI è completa.
2. **Piano di M1** (brainstorming → spec → piano): server vero per `auth`/`account` (vedi "Punti aperti"), con **R16** all'inizio (ordine migrazioni ↔ verifica chiave; `apps/server/test/migrations-guard.test.ts` fallisce apposta alla seconda migrazione). Le rotte `admin` del contratto vanno implementate quando il server ha utenti, quote e SMTP.
3. **Spike sui dispositivi e prova del plugin su telefono** (committente, rinviati di proposito): `docs/spikes/README.md`, poi `R-1.md`…`R-5.md`. Con i risultati: aggiornare `docs/02-architecture.md` §10, eventuali nuove ADR, decidere `minAppVersion` del plugin, cancellare `spikes/`.

## Come riprendere su un altro PC

1. Prerequisiti: Git, **Node 24 LTS** (minimo 22.12), **Docker** (Rancher Desktop o Docker Desktop) avviato, Claude Code con il plugin **superpowers** e le skill **UI/UX Pro Max** e **impeccable**.
2. Clona e posizionati sul branch:
   ```bash
   git clone https://github.com/davidemaggi/Kamino.git
   cd Kamino
   git checkout m0-fondamenta   # oppure main, se il merge è già stato fatto
   ```
3. **Identità git del repo** (va impostata su ogni PC; mai l'email di lavoro):
   ```bash
   git config user.name "Davide Maggi"
   git config user.email "davide.maggi@live.com"
   ```
4. Toolchain e verifica:
   ```bash
   corepack enable          # attiva pnpm 10 da packageManager
   pnpm install
   pnpm build
   pnpm test                # i test DB avviano Postgres con Testcontainers (serve Docker)
   ```
5. In Claude Code, dalla cartella del repo: *"leggi `docs/HANDOVER.md` e riprendi dal primo dei prossimi passi"*.
   Il registro dettagliato del controller (`.superpowers/sdd/…`) non è versionato: tutto ciò che serve per riprendere è in questo file.
6. Opzionale, per provare l'immagine: quick start del `README.md` (su Windows PowerShell 5.1 genera la chiave con `| Out-File -Encoding ascii …`, vedi `docs/self-hosting.md`).

## Decisioni prese durante l'esecuzione (ruling)

Decisioni del tech lead non presenti nel piano originale. Se una si rivela sbagliata, il costo è indicato.

| # | Decisione | Costo se sbagliata |
|---|---|---|
| R0 | Lavoro su branch `m0-fondamenta` nella checkout principale, senza git worktree | nessuno |
| R1 | Target Node 24 LTS (Docker/CI), `engines.node >=22.12` per lo sviluppo locale | bump minore |
| R2 | pnpm 10 via corepack | — |
| R3/R11 | Changesets: gruppo `fixed` con `@kamino/server`, `@kamino/web`, `@kamino/plugin`; `privatePackages.version: true` | nessuno |
| R4 | `release-names:check` legge la versione da `apps/server/package.json` | nessuno |
| R6 | Spike (task 12): il subagente prepara prototipi e istruzioni; le misure si fanno su telefono reale; la "chiusura" degli spike resta aperta finché non sono eseguiti | criterio di uscita di M0 aperto |
| R7 | Vitest 5 non ha più il file workspace: `vitest.config.ts` root con `test.projects` | nessuno |
| R8 | TypeScript ~6.0 (non 7) finché typescript-eslint non supporta la 7 | aggiornamento futuro |
| R9 | `docs/**`, `kickstart.md`, `.claude/` esclusi da Prettier | — |
| R10 | Logica dei nomi in codice in `@kamino/brand`; il server riceve il codename da un file generato in build (nessuna lettura di file della root a runtime) | piccolo refactor |
| R12 | Lock delle migrazioni su una connessione riservata, migrator sul pool | — |
| R14 | Le etichette crittografiche `kamino-kek-id` / `kamino-key-check` **non** cambiano con il nome pubblico (renderebbero illeggibili i DB esistenti) | — |
| R16 | **Da fare in M1:** quando arriva la prima migrazione applicativa, applicare prima la migrazione `key_check`, verificare la chiave, poi il resto (TODO in `apps/server/src/main.ts`) | migrazioni eseguite con chiave sbagliata |
| R18 | Fallback SPA solo per percorsi senza estensione: gli URL della web app usano **ID**, mai nomi di file | un percorso con punto dà 404 al reload |
| R23 | In CI su Windows i test che richiedono Docker vengono saltati (`dockerUnavailable` in `apps/server/test/helpers/postgres.ts`); in locale su Windows con Docker girano | test DB non coperti su Windows in CI |
| R25 | `pnpm format:check` (prettier) aggiunto alla CI dopo aver trovato 13 file non formattati | — |
| R26 | `spikes/` è un progetto separato fuori dal workspace pnpm (installazione con `pnpm install --ignore-workspace` dentro `spikes/`), escluso da lint/prettier/test/CI; resta finché gli spike non sono chiusi | una cartella in più fino alla chiusura |
| R19 | Pubblicazione di manifest/`versions.json` per BRAT e store rinviata alla fase di release (M7) | lavoro di release |
| R28 | Revisione finale: un solo giro di correzioni per l'importante (file segreti UTF-16 da PowerShell 5.1) e tutti i minori economici | — |
| R29 | CI su push di **tutti** i branch + PR; `cancel-in-progress` tranne che su `main` | run doppie sui branch con PR |
| R30 | Prima della PR, riscritto il messaggio di un commit (`docs: PowerShell key generation…` → `docs: key generation on PowerShell…`) che non passava `subject-case` di commitlint; force push il 2026-11-07, contenuto invariato | checkout precedenti da riallineare |
| R21 | Quick start del README allineato alla sequenza verificata nel task 9 (`docker run … keys generate` dopo la build dell'immagine) | — |

### Decisioni della fase UI (sotto-fase 1)

Prese nel brainstorming del 2026-11-07, dettagli nella spec `docs/superpowers/specs/2026-11-07-ui-fondamenta-design.md`.

| # | Decisione |
|---|---|
| U1 | Deliverable = componenti veri nel codice (niente mockup statici) |
| U2 | Plugin con API DOM di Obsidian + variabili CSS di Obsidian; nessun framework |
| U3 | Revisione con gallerie interne (web `/dev/gallery`, comando di sviluppo nel plugin); niente Storybook |
| U4 | Direzione visiva C "Ibrida" (`docs/ui/design-system.md`) |
| U5 | Cinque livelli di stato: Al sicuro, In corso, Attenzione, Decisione (viola), Bloccato |
| U6 | Font inclusi nell'app (Inter + Source Serif 4), nessun CDN |
| U7 | Lessico e logica degli stati in `packages/status`; token separati per app |
| U8 | Su mobile: ribbon + notice + azione nell'intestazione della nota solo da Attenzione in su |
| U9 | Esecuzione dei piani nella sessione, a blocchi con checkpoint (meno token); subagenti solo su richiesta (`CLAUDE.md`) |
| U10 | Componenti shadcn: `cn` da `@/lib/utils`, mai dal pacchetto npm `cn` che il CLI ha provato ad aggiungere |
| U11 | Vault di prova del plugin in `vault/kamino/`, ignorata da git ed ESLint; `pnpm --filter @kamino/plugin build:vault` la aggiorna |

### Decisioni della fase UI (sotto-fase 2)

Brainstorming del 2026-11-08, dettagli in `docs/superpowers/specs/2026-11-08-ui-stato-conflitti-design.md`.

| # | Decisione |
|---|---|
| V1 | Diff vero subito: `packages/ui-diff` su `@codemirror/merge` 6.12, CodeMirror di Obsidian esterno (R-3 desktop superato) |
| V2 | Risoluzione su telefono: schede "La tua / Differenze / In arrivo" + diff unificato; desktop affiancato |
| V3 | Pannello di stato: pagina unica a sezioni, solo quelle non vuote |
| V4 | Le scelte si applicano subito con notice; conferma esplicita solo per "Risolvi tutti…" |
| V5 | Viste su interfacce `SyncStateSource`/`ConflictActions`; `FakeSyncState` in memoria fino a M1/M3 |
| V6 | Nel diff unificato il documento è la tua versione (base comune del merge su desktop e mobile); colori riallineati via CSS |
| V7 | Bundle di produzione del plugin: 14,9 KB → 99,4 KB con `@codemirror/merge`; minificazione rinviata (vedi punti aperti) |

### Decisioni della fase UI (sotto-fase 4c)

| # | Decisione |
|---|---|
| Y1 | Due voci: Utenti (`/admin/users`, `/admin/users/$userId`) e Sistema (`/admin/system?tab=…`: configurazione, salute, registro) |
| Y2 | Solo metriche aggregate degli altri utenti, mai nomi di vault/file (U-03); il contratto non ha campi che potrebbero contenerli |
| Y3 | L'admin non imposta mai password altrui: invito email o link di attivazione; reset con link monouso; link mostrati una volta |
| Y4 | Configurazione con la fonte di ogni valore; "impostato dall'ambiente" → campo bloccato in UI e `config_locked` dal server |
| Y5 | Contratto zod (`admin.ts`) + MSW come in 4a/4b |

### Decisioni della fase UI (sotto-fase 4b)

| # | Decisione |
|---|---|
| X1 | Area utente in un'unica sotto-fase |
| X2 | Dettaglio vault: intestazione + schede nell'URL |
| X3 | Centro conflitti: elenco + dettaglio affiancati su desktop, due pagine su telefono |
| X4 | Contratto zod + MSW come in 4a; diff tramite l'adattatore React `DiffView` caricato a richiesta |

### Decisioni della fase UI (sotto-fase 4a)

| # | Decisione |
|---|---|
| W1 | Sotto-fase 4 divisa in 4a (struttura e account), 4b (area utente), 4c (area admin) |
| W2 | Barra laterale su desktop, barra in alto + menu a scomparsa su telefono |
| W3 | Client HTTP vero (TanStack Query) su un contratto zod in `@kamino/protocol`; API simulate con **MSW** (3.x: opzione `onUnhandledFrame`) in sviluppo e test, assente in produzione |
| W4 | Router: TanStack Router, route e redirect tipizzati |
| W5 | Durante il brainstorming niente conferme sezione per sezione: solo le scelte vere (preferenza del committente) |

### Decisioni della fase UI (sotto-fase 3)

Brainstorming del 2026-11-08, dettagli in `docs/superpowers/specs/2026-11-08-ui-onboarding-design.md`.

| # | Decisione |
|---|---|
| O1 | Solo plugin, con le impostazioni; la schermata web "aggiungi dispositivo" passa alla sotto-fase 4 |
| O2 | Primo avvio non collegato: scheda di benvenuto con tre strade |
| O3 | Pairing in quattro passi (protocollo §10); la finestra "Aggiungi un dispositivo" diventa la richiesta di approvazione |
| O4 | A finestra chiusa: notice cliccabile + sezione "Richieste di collegamento" nel pannello |
| O5 | Impostazioni complete; i valori di comportamento si salvano ora e si applicano con M1/M2 (riga esplicita nella UI, flag `engineAvailable`) |
| O6 | `ConnectionService`/`InitialTransfer` con `FakeServer` in memoria (credenziali e comandi di prova in `docs/ui/design-system.md` §8) |
| O7 | QR generati con `uqr` (MIT, nessuna dipendenza); azione del link `PROTOCOL_ACTION` in `@kamino/brand` |

## Punti aperti (rinviati, con milestone)

- **Accessibilità delle schede (web e plugin):** navigazione con le frecce e `tabindex` mobile per le schede del vault, del Sistema admin e della vista conflitto su telefono; `aria-controls` sulle schede del conflitto su telefono nella web app.
- **Web:** valutare il titolo della pagina nella barra in alto su telefono (oggi logo + nome); i testi `dev.*` del pannello "Dati finti" finiscono nel bundle di produzione (innocui).
- **Web admin:** nella scheda Salute i controlli hanno solo il testo (la spec prevedeva icona + testo).
- **M1+ (server):** implementare anche le rotte `admin` (utenti, configurazione con fonte dei valori, email di prova, salute, audit) e quelle di vault, dispositivi, pairing dal web, conflitti, storico e cestino del contratto `@kamino/protocol`.
- **M1 (server):** implementare le rotte del contratto `auth`/`account` di `@kamino/protocol` (Argon2id, sessioni con cookie `HttpOnly`, TOTP vero, verifica dell'intestazione anti-CSRF `X-Requested-With`), poi spegnere MSW per quelle rotte.

- **Vincolo di rilascio:** **nessuna release pubblica del plugin prima di M1.** Fino ad allora il plugin contiene il `FakeServer` (credenziali `demo`/`demo`) e il trasferimento finto segna come "sync confermato" dati mai caricati: in una build pubblica romperebbe la promessa "sai sempre se sei al sicuro".
- **Notice cliccabile:** `Notice.noticeEl` è deprecato nei tipi di Obsidian 1.14 ma è quello giusto per `minAppVersion` 1.5.0; da rivedere quando si alza la versione minima (con gli esiti di R-1).

Esito della revisione finale di M0: questi restano aperti di proposito.

- **M1:** R16 (ordine migrazioni/verifica chiave) insieme a: errore di unlock del lock migrazioni che può mascherare l'errore originale; snapshot completo di `ErrorCode` quando le rotte iniziano a emetterli; verificare se typescript-eslint supporta TS 7. Decidere `minAppVersion` del plugin con gli esiti di R-1 (`appendBinary` richiede Obsidian ≥ 1.12.3).
- **M2:** negoziazione protocollo (euristica intervalli invertiti, schema zod `ProtocolRange`); shutdown con exit code corretto e scadenza (oggi esce sempre con 0; `docker stop` durante le migrazioni attende 10 s).
- **M3:** collegare `ConflictView`/`StatusPanelView` alle implementazioni vere di `SyncStateSource`/`ConflictActions` (oggi `FakeSyncState`). Gli esterni espliciti di esbuild sono già fatti (sotto-fase UI 2).
- **M1/M2:** implementazioni vere di `ConnectionService`/`InitialTransfer` (HTTP, token del dispositivo al posto del `FakeServer`); applicazione delle impostazioni di comportamento e `engineAvailable = true`; ricostruzione del server da un dispositivo (V-05) con i suoi avvisi.
- **M7:** minificare il bundle di produzione del plugin (`minify` in `esbuild.config.mjs`; oggi 99,4 KB solo con `minifySyntax`).
- **Fase UI:** i punti aperti di M0 (flash del tema, modalità "sistema", chiavi `theme.*`, `<title>`/`lang`) sono **chiusi** nella sotto-fase 1. Restano: ripetizione insistente delle notice (S-05) e pannello di stato completo → sotto-fase 2 / M1; su mobile, senza una nota aperta (grafo, canvas, scheda vuota) l'azione nell'intestazione non può comparire e restano solo ribbon (nel menu laterale) e notice → da riconsiderare nella sotto-fase 2; verifica delle icone sul `minAppVersion` scelto (oggi `1.5.0`) → revisione della galleria del plugin.
- **M7 (hardening/release):** CLI `release-names` con errori non gestiti e test deboli; `statement_timeout` sul ping di readiness; redazione di `databaseUrl` annidato; rigore del base64 della chiave; rotazione chiave (regola "riga attiva di altra chiave → rifiuto", tabella con sole righe ritirate); `versions.json` del plugin generato in release (R19); password DB via `*_FILE`; `cloudflared` da pinnare e `--token-file` da provare; `compose run … keys generate` da provare; commitlint sul primo push di un branch; cache della build Docker in CI.
- **Cosmetici:** estensioni di import miste e output nascosto nel test di build del plugin; riga lunga e data fissa in `CLAUDE.md`; file segreto UTF-16BE di lunghezza dispari segnalato come "illeggibile"; il suggerimento `docker compose run` nel messaggio d'errore della chiave non riporta `-T`/`-f`.

## In sospeso lato committente

- Descrizione e topic del repo GitHub (ancora vuoti; `gh` ora è autenticato sul Mac, si possono impostare con `gh repo edit`).
- **Prova del plugin su telefono** (rinviata dal committente il 2026-11-08, da fare insieme agli spike): copiare `vault/kamino/.obsidian/plugins/kamino-sync/` sul dispositivo e verificare: icone (avvisi "status icon … not available"), colori col tema, azione nell'intestazione della nota solo dagli stati Attenzione/Decisione/Bloccato; pannello nel cassetto laterale; vista conflitto a schede con diff unificato e "Modifica e unisci" (completa anche R-3 su mobile); scheda di benvenuto; **QR inquadrato con la fotocamera che apre davvero Obsidian e avvia il pairing**; blocco di `http://`; impostazioni (nota iOS). Su desktop tutto è provato.
- Spike su iPhone/Android reali (task 12): seguire `docs/spikes/README.md`, poi `R-1.md`…`R-5.md`, compilando le tabelle.

## Note sull'ambiente

- Macchina di sviluppo lenta: eslint impiega 10–20 s ad avviarsi, le build Docker diversi minuti.
- Docker: Rancher Desktop (WSL). Va avviato prima dei test.
- Storia del branch riscritta il 2026-11-06 (email dell'autore) e di nuovo il 2026-11-07 (R30, messaggio di un commit): eventuali checkout precedenti di `m0-fondamenta` vanno riallineati con `git fetch && git reset --hard origin/m0-fondamenta`.
