# Handover — stato del lavoro

> **Da leggere per primo** quando si riprende il lavoro (anche da un altro PC).
> Questo file è mantenuto **sempre aggiornato, committato e pushato** dopo ogni task completato o decisione rilevante.

**Ultimo aggiornamento:** 2026-11-14 — **1.0.0-rc.8 pubblicata** (PR #41; plugin e immagine `1.0.0-rc.8`/`rc`). Contenuto: (1) **S-12, avviso di ricarica:** quando un altro dispositivo cambia la cartella di configurazione e il cambiamento arriva qui, il plugin mostra una volta un avviso persistente con il pulsante «Ricarica ora» (`ui/config-reload.ts`; il motore chiama `onConfigApplied` dopo un effetto riuscito su un percorso `{config}/…`). Obsidian legge quella cartella solo all'avvio. (2) **Impostazioni di sincronizzazione del vault nella web app:** nel plugin «Usa le impostazioni del vault» seguiva valori che solo un dispositivo poteva cambiare (via API). Adesso la scheda Impostazioni del vault ha la sezione «Cosa sincronizzare» (5 categorie della cartella di configurazione + esclusioni), servita da `GET/PUT /vaults/:id/sync-settings` (solo il proprietario, 404 per chiunque altro admin compresi, voce di journal `vault_settings_changed` con autore `WEB_AUTHOR`). Il valore predefinito resta «solo note e allegati». Per avere i plugin su un altro dispositivo servono sia «Elenco dei plugin attivi» sia «Plugin installati». Nota per la diagnosi: Obsidian non manda eventi per `.obsidian`, quindi una modifica lì si vede solo alla scansione completa (ogni 5 minuti o con «Sincronizza ora»). **1.0.0-rc.7 pubblicata** (PR #39; plugin e immagine `1.0.0-rc.7`/`rc`). `main` ora è protetto: solo PR, CI obbligatoria (`verify` ubuntu/windows, `docker build`), niente force push; gli admin possono scavalcare. Contenuto della rc.7: da Android ogni chunk riceveva 500 (`ENOENT`). Le sessioni di upload aperte con la rc.5 (quelle dei 415) sono sopravvissute nel database, ma la loro cartella di staging no: il container è stato ricreato con `/data` su un'altra cartella (bind mount). Ora `putChunk` ricrea la cartella prima di scrivere (lo staging è spazio di lavoro; `complete` controlla già i chunk mancanti). Test in `transfer.test.ts`. **1.0.0-rc.6 pubblicata** (PR #36 + bump #37; plugin su GitHub e immagine `ghcr.io/davidemaggi/kamino:1.0.0-rc.6`/`rc`). Nota di processo: il bump (`pnpm release:version`) va fatto dentro il branch della correzione, altrimenti serve una PR in più. **415 da Android in sincronizzazione** (branch `fix/android-upload-content-type`, per rc.6): su Android `requestUrl` di Obsidian non manda sempre il content-type chiesto dal plugin, e il server rifiutava ogni chunk degli upload con 415 (accettava solo `application/octet-stream`). Ora la rotta dei chunk, in un suo scope, prende il corpo come byte qualunque sia il tipo dichiarato (l'hash verificato a `complete` resta la garanzia), e a livello globale una richiesta senza corpo è accettata qualunque tipo dichiari (un corpo vero di tipo sconosciuto resta 415). Test in `transfer.test.ts`. Lato server: basta aggiornare l'immagine. Nello stesso branch: nel menu della ribbon su mobile la voce dello stato era un orologio senza testo, perché Obsidian mobile usa solo icona e titolo passati ad `addRibbonIcon` (creata con `"clock"` e titolo vuoto; `setIcon`/`aria-label` successivi non arrivano al menu). Ora è creata con il logo e il titolo «<prodotto>: Stato della sincronizzazione» (i18n `ribbon.status`). **Immagine Docker su GHCR** (branch `feat/release-image`): workflow manuale `release-image.yml` (dopo Release plugin; build dal tag, amd64+arm64, tag `<versione>` + `rc`/`latest`), `docker/compose.image.yml` + `docker/image.env.example` per installare senza repository (segreti in `.env`, tunnel sull'host o profilo `cloudflare` con `CLOUDFLARED_TOKEN`); `docs/self-hosting.md` §1. **1.0.0-rc.5 pubblicata** (PR #34). **1.0.0-rc.5** sul branch `fix/rc5-own-folder-rename`: dopo "accetta quello in arrivo" su `Benvenuto.md` (file aperto) il file è finito nel cestino del dispositivo, server e altro dispositivo intatti, stato "al sicuro". Causa: per sostituire un file `ObsidianFs.write` sposta il vecchio in `.obsidian/plugins/kamino-sync/tmp/…old`, Obsidian lo segnala come rinomina, il motore la prendeva per uno spostamento dell'utente in un'area esclusa (smetteva di seguire il file, `ignored`) e la versione nuova comparsa al percorso, non tracciata e uguale al server, andava nel cestino. Correzione in sync-core: `onLocalRename` ignora le rinomine da/verso la cartella del plugin (`inOwnArea`), e `applyScan` ripara uno stato già rotto (voce con percorso nella cartella del plugin → torna al percorso del server; se il file manca lo riscarica, mai una cancellazione). Test in `client.test.ts` e `engine.conflicts.test.ts`. **1.0.0-rc.4 pubblicata** (PR #33). **1.0.0-rc.4** sul branch `feat/rc4-obsidian-identity`: nuova identità "Ossidiana" chiesta dal committente (sfondi color ossidiana, viola come Obsidian, logo = elmo da clone fornito da lui): nuova icona `assets/icon.svg`/`.png`, palette web rifatta (token e contrasti testati), **scuro predefinito** (`theme-init.js`, `ThemeProvider`, default DB `users.theme = 'dark'` con migrazione 0009), "Decisione" diventa magenta (web e plugin `--color-pink`), glifo dell'elmo nel plugin (`addIcon`, icona del pannello e del benvenuto), pagine di accesso con logo grande e alone viola. Dettagli in `docs/ui/design-system.md` §1–2. Nota marchio: l'elmo è un design Lucasfilm/Disney, va bene solo come nome in codice (`docs/renaming.md`). Nella stessa rc.4: "Verifica" del plugin diceva sempre "non raggiungibile" perché il client del plugin prefissa ogni percorso con `/api/v1` e il server esponeva `/version` solo alla radice (404). Ora `/version` c'è anche sotto `/api/v1` (funziona anche con i plugin rc.1–rc.3); test in `app.test.ts`. Nota: `requestUrl` di Obsidian non compare nel pannello Network degli strumenti di sviluppo. **1.0.0-rc.3 pubblicata** (PR #32). **1.0.0-rc.2 pubblicata** (PR #31). **1.0.0-rc.3** sul branch `fix/rc3-plugin-link-button`: "Collega…" nelle impostazioni e nel pannello apriva la scheda di benvenuto dietro la finestra delle impostazioni (e dietro il drawer su mobile), sembrava non fare niente; ora apre `WelcomeModal` (stesso contenuto, `ui/welcome-content.ts`), la scheda resta all'avvio. Inoltre `ConnectModal` mostra un errore se creazione o collegamento falliscono (prima: eccezione non gestita, pulsante muto). **1.0.0-rc.1 pubblicata** (PR #30 mergiata, workflow Release plugin, pre-release su GitHub). **1.0.0-rc.2** sul branch `fix/rc2-totp-setup-status`: subito dopo il primo setup l'admin (senza TOTP) vedeva `totp_mandatory` perché la web app chiama `GET /setup/status` prima di ogni pagina autenticata e la rotta non era tra quelle ammesse durante la configurazione del TOTP; ora lo è (test I4 in `auth-security.test.ts`). I mock MSW non applicano il filtro globale `totp_mandatory`: per questo i test web non l'avevano visto. Storico: **M3a mergiata** (PR #17). **M3b mergiata** (PR #18). **M7** iniziata (spec leggera `docs/superpowers/specs/2026-11-13-m7-hardening-design.md`, tre PR): **M7a fatta** (intestazioni di sicurezza e CSP, rate limit, matrice di autorizzazione su ogni rotta, `pnpm audit` e Dependabot in CI, revisione del threat model) sul branch `m7-hardening`, PR #19 aperta. **M7b fatta** sul branch `m7b-keys-backup` (impilato su `m7-hardening`): rotazione della master key a doppia chiave (`keys rotate`, `KAMINO_MASTER_KEY_PREVIOUS[_FILE]`, `docker/compose.rotate.yml`) e `backup create|verify|restore` (ZIP con COPY binario di ogni tabella + blob cifrati, senza chiave; verify ripristina in un database temporaneo e decifra 20 blob; restore solo su installazione vuota). Procedure in `docs/self-hosting.md` §5–6; T-06 e T-14 chiusi nel threat model. **M7c fatta** sul branch `m7c-perf-release` (impilato su `m7b-keys-backup`): test da 10.000 file (`KAMINO_PERF=1`, workflow settimanale `perf.yml`; sul Mac: primo collegamento 5,8 min, secondo dispositivo 6,1 min, ciclo a vuoto 0,2 s, snapshot 3,2 s, una modifica A→B 1 s), clone veloce dello stato in `step` (era quadratico in pratica: JSON a ogni evento), bundle del plugin minificato senza le lingue di zod (1,08 MB → 415 KB), workflow manuale `release-plugin.yml` per BRAT con `pnpm release:version` e `versions.json` (R19), `docs/self-hosting.md` completo, minori (redazione annidata, `statement_timeout` sul ping, base64 canonico, CLI `release-names`). **Release candidate 1.0.0-rc.1 "Ash"** preparata sul branch `release-1.0.0-rc.1` (impilato su `m7c-perf-release`), su richiesta del committente che ha confermato versione 1.0 e nome: changesets in modalità pre `rc` (`.changeset/pre.json`; changesets 3 sposta le changeset consumate in `.changeset/pre/`), versione portata a mano da rc.0 a rc.1, `versions.json` aggiornato; log per le analisi (server: riga `server starting` con versione/commit/protocollo, `server ready`, `job failed` con nome del job e classe d'errore; rotazione dei log nei compose; plugin: registro di soli codici `diagnostics.log` nella sua cartella, comando e pulsante "Copia la diagnostica"; `docs/self-hosting.md` §9). Per pubblicarla: merge #19 → #20 → #21 → PR rc su `main` (solo il committente), poi workflow **Release plugin** da `main` (crea il tag `1.0.0-rc.1` e la pre-release con i file per BRAT); il server si installa con `git checkout 1.0.0-rc.1` e `docker compose … up -d --build`. Per l'rc successiva basta una nuova changeset e `pnpm release:version` (da rc.1 a rc.2); per la 1.0 finale `pnpm exec changeset pre exit` e `pnpm release:version`. Le prove con persone e dispositivi veri si fanno su questa rc. **Correzioni trovate preparando l'rc (CI di `main`):** (1) un upload rifiutato dal server (429 oltre 1800 upload al minuto per dispositivo, o 5xx) faceva rispondere `blob_missing` al commit; il file restava `blocked` e `pendingOps` lo saltava, quindi lo stato diceva "al sicuro" (`queued: 0`) fino al ciclo successivo, e senza nuove modifiche locali nessuno lo riprovava. Ora `nextOps(..., { includeBlocked: true })` lo conta nello stato e un 429/5xx sull'upload fa ripartire il ciclo con backoff (test di regressione in sync-core e sync-engine). (2) Il test dell'architettura admin su Windows non vedeva mai i moduli proibiti (separatori `\\`): percorsi normalizzati. (3) `engine-flow` usa `drain()` condiviso con il test da 10.000 file. Nota: #20 e #21 erano state mergiate nei loro branch base dopo il merge di #19, quindi non sono mai arrivate su `main`; la PR #30 (base `main`) porta M7b, M7c e l'rc. Processo snello deciso dal committente: niente cerimonia superpowers, spec leggera, solo le scelte vere.

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
| Fase UI — sotto-fase 4c: area admin della web app (spec `docs/superpowers/specs/2026-11-08-ui-web-admin-design.md`, piano `docs/superpowers/plans/2026-11-08-ui-web-admin.md`) | ✅ implementata, rivista (5 importanti + 8 minori corretti); mergiata su `main` (PR #7) |
| M1 — divisa in M1a (sync-core), M1b (crypto + auth), M1c (vault/file/blob/commit sul server), M1d (motore del plugin, dopo gli spike) | ✅ M1a (spec `docs/superpowers/specs/2026-11-09-m1a-sync-core-design.md`): mergiata (PR #8) · ✅ M1b (crypto + auth web; spec `docs/superpowers/specs/2026-11-09-m1b-crypto-auth-design.md`): mergiata (PR #9) · 🔧 M1c (server di sync; spec `docs/superpowers/specs/2026-11-09-m1c-sync-server-design.md`, piano `docs/superpowers/plans/2026-11-09-m1c-sync-server.md`): mergiata (PR #10) · ✅ M1d (spec `docs/superpowers/specs/2026-11-10-m1d-plugin-engine-design.md`, piano `docs/superpowers/plans/2026-11-10-m1d-plugin-engine.md`): mergiata (PR #12) |
| M2 — divisa in M2a (server: WebSocket, fan-out, compattazione, dispositivi, impostazioni) e M2b (parte plugin, dopo M1d) | 🔧 M2a (spec `docs/superpowers/specs/2026-11-10-m2a-realtime-design.md`, piano `docs/superpowers/plans/2026-11-10-m2a-realtime.md`): mergiata (PR #11) · ✅ M2b: mergiata (PR #13); ⏳ test sui dispositivi D-1…D-7 e settimana d'uso |
| M4+M5+M6 — pacchetto unico (spec `docs/superpowers/specs/2026-11-11-m456-server-routes-design.md`, piano `docs/superpowers/plans/2026-11-11-m456-server-routes.md`; tre PR) | ✅ P1 area utente (Task 1–7): mergiata (PR #14) · ✅ P2 admin/quote/email (Task 8–13): mergiata (PR #15) · ✅ P3 pairing (Task 14–15): mergiata (PR #16); ⏳ prova con una persona vera (a fine sviluppo) |
| M3 — conflitti e storico (spec leggera `docs/superpowers/specs/2026-11-13-m3-conflicts-history-design.md`; due PR) | ✅ M3a server + web: mergiata (PR #17) · ✅ M3b client: mergiata (PR #18) |
| M7 — hardening e prima release (spec leggera `docs/superpowers/specs/2026-11-13-m7-hardening-design.md`; tre PR) | 🔧 M7a sicurezza: fatta, PR #19 aperta · 🔧 M7b chiavi e backup: fatta, PR aperta (base `m7-hardening`) · 🔧 M7c prestazioni, docs, BRAT: fatta, PR #21 aperta (base `m7b-keys-backup`) · ✅ M7a/M7b/M7c e 1.0.0-rc.1 su `main` e pubblicata · ✅ 1.0.0-rc.2 pubblicata · ✅ 1.0.0-rc.3 pubblicata · ✅ 1.0.0-rc.4 pubblicata · ✅ 1.0.0-rc.5 pubblicata (anche immagine Docker su GHCR) · ✅ 1.0.0-rc.6 pubblicata (415 da Android, titolo ribbon mobile) · ✅ 1.0.0-rc.7 pubblicata (500 sugli upload con staging sparito) · ✅ 1.0.0-rc.8 pubblicata (avviso di ricarica S-12, impostazioni di sync del vault nella web app) · ⏳ 1.0 finale dopo i test sull'rc |

**Branch di lavoro:** nessuno aperto (rc.8 pubblicata). Vecchi, da cancellare: `m7-hardening` (M7a, PR #19); `m7b-keys-backup` (M7b, impilato su M7a: dopo il merge di #19 la base della PR M7b passa a `main`). `m7c-perf-release` (M7c, impilato su M7b, PR #21). `release-1.0.0-rc.1` (rc, impilato su M7c). Ordine di merge: #19 → #20 → #21 → rc, spostando ogni volta la base su `main`.
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

### Task di M1d (Blocco A — `sync-engine`)

Piano: `docs/superpowers/plans/2026-11-10-m1d-plugin-engine.md`, spec: `docs/superpowers/specs/2026-11-10-m1d-plugin-engine-design.md` (E1–E10).

| # | Task | Stato |
|---|---|---|
| 1 | Pacchetto, porte, `MemoryFs`, hash | ✅ committato `8c131cb` (`ports.ts`, `hash.ts`, `memory-fs.ts`, `memory-fs.test.ts`, `index.ts`; `docker/Dockerfile` e `.changeset/config.json` aggiornati) |
| 2 | Scanner con cache degli stat | ✅ `d18c7b0` |
| 3 | API e trasferimenti | ✅ `0fe2ab0` (`api.ts`, `transfers.ts`: upload a chunk in streaming con ripresa, download a pezzi `Range`) |
| 4 | Motore (`engine.ts`, `status.ts`) | ✅ `b527445` (35 test, compreso il test di proprietà con crash del client; `src/testing/fake-server.ts` = server finto su `MemoryStore`) |

Decisioni prese eseguendo il Blocco A (registro completo in `.superpowers/sdd/…/progress.md`, non versionato):
- `Transfers` passa tutto da `Api` (errori mappati in un punto solo) e riceve le sessioni salvate; l'upload legge a pezzi già ora (anticipa una parte del Task 6).
- Il download ricava la dimensione da `Content-Range`: l'effetto `write` di `sync-core` non la porta.
- Il cestino ricalcola l'hash prima di spostare (la porta `trash` non ha `expect`).
- `cursor_too_old`: per ora solo log e nuovo tentativo; la riconciliazione vera (snapshot su un indice esistente) richiede una modifica a `sync-core` e si fa con il Task 7.
- Il commit si fa con `git commit` normale: `/tmp/kamino-tools/commit.sh` c'è solo sul Mac.

Blocco B — Task 5 (cartelle sul client, Z9) ✅ `8169f40`:
- le cartelle vivono in `Durable.folders`, separate dall'indice dei file (la logica dei file, già provata dal simulatore, non cambia); effetti `mkdir`/`rmdir`, evento `folderDone`; l'evento `sync` porta `folders?` (assente = il guscio non riporta cartelle);
- spostamento remoto di una cartella = `mkdir` del nuovo percorso + il vecchio rimosso quando è vuoto (i file seguono uno a uno); `d`/`D` su disco case-sensitive = "alias" che non invia nulla;
- il simulatore ora crea, rimuove e sposta cartelle (anche non viste dal watcher) e controlla che convergano; durante lo sviluppo ha trovato 9 difetti, tutti corretti; `test:deep` (3000 scenari) verde. `SIM_NO_SHRINK=1` riporta un errore senza ridurlo (la riduzione di un caso che non si stabilizza è lentissima).

Blocco C — Task 6 ✅ `03e3cd2`: streaming verificato (20 MB con meno di 3 chunk in memoria, in entrambe le direzioni); senza streaming i file oltre `limits.maxInMemoryBytes` (100 MB) restano in `deferred()`, mai persi.

Blocco E — Task 8 ✅ `2dddddd`: `ObsidianFs` (file temporaneo in `<pluginDir>/tmp`, `appendBinary` se c'è, hash verificato prima del `rename`, cestino di sistema con ripiego su `.trash`, stato atomico con recupero del `.tmp`) e `ObsidianHttp` su `requestUrl`; mock `MockAdapter` e `requestUrlMock` in `src/__mocks__/obsidian.ts`.

Blocco E — Task 9 ✅ `1e101fd` (`RealConnection` sulle rotte di M1c, token del dispositivo in `data.json` accanto al collegamento, `EngineHost` = un motore per collegamento con stato in `<pluginDir>/state/<deviceId>`, `RealTransfer` dall'arretrato del motore; abbinamento QR → notice "in arrivo"; nelle build di sviluppo `FakeServer` salvo `localStorage["kamino-sync-dev-real-server"] = "1"`) e Task 10 ✅ `451d4e6` (`EngineState` dal motore, risoluzione dei conflitti → "in arrivo"; `Watcher` con debounce 5 s / 1,5 s, rinomine subito, ciclo al ritorno in primo piano). Trovato e corretto un difetto del motore: `kick()` poteva tenere una promessa già conclusa e far girare `syncNow` all'infinito (test di regressione nel Task 9).

Blocco F — Task 11 ✅ `66d63f2` (mappa delle categorie, override del dispositivo impostato dal plugin a ogni lettura, impostazioni lette prima del primo ciclo con ripiego offline, rilettura alla voce `vault_settings_changed`, notice "ricarica Obsidian" se cambiano le categorie) e Task 12 ✅ `e030132` (trovato e corretto: il bundle di produzione conteneva ancora il `FakeServer` e le credenziali `demo`; ora il ramo dipende direttamente da `__DEV__`). Su questa macchina i test del plugin vanno lanciati con `--maxWorkers=2` (sotto carico vitest non riesce ad avviare i worker).

**Ordine cambiato:** il Task 7 si fa dopo il 12 (sul PC Windows Docker gira in WSL su `tcp://127.0.0.1:2375`, contesto `wsl`: lanciare i test del server con `DOCKER_HOST=tcp://127.0.0.1:2375`).

**Blocchi rimanenti:** D (integrazione motore↔server vero), E (adattatori Obsidian, collegamento, watcher), F (impostazioni, build produzione), G (docs, verifica, revisione, PR).

## Prossimi passi

1. **Sviluppo M7 completo.** Restano le decisioni del committente: test sui dispositivi (sotto), poi prima release BRAT (`pnpm release:version`, merge, workflow "Release plugin"), 1.0 "Ash" e nome pubblico. Idea post-1.0: il primo collegamento è dominato dalle andate e ritorni con Postgres (3–4 richieste per file): caricare i file piccoli a pacchetti richiede una modifica di protocollo. Da provare a mano prima della 1.0: comportamento dei dispositivi già collegati dopo un `backup restore` (il cursore del server torna indietro). La 1.0 e il nome pubblico sono scelte del committente, dopo i test sui dispositivi.
2. **Prima di rilasciare M6:** prova del pairing con una persona vera (QR inquadrato col telefono che apre Obsidian, stesso codice sui due lati, approvazione dal desktop e dalla web app, link via email), insieme ai test sui dispositivi del punto 2.
3. **Test sui dispositivi** D-1…D-7 (`docs/spikes/README.md`) e la **settimana d'uso** con due desktop e un telefono, che chiude M2. Nessuna release pubblica prima.
4. **M7** (hardening, release) resta una milestone a sé.
5. Minori rinviati dalle revisioni di M1d e M2b: elencati nelle rispettive sezioni qui sotto.

**Accelerazioni decise dal committente (2026-11-11):** (1) M4, M5 e M6 in un unico pacchetto; (2) spec leggere per le parti a basso rischio (rotte, schermate), rigore pieno solo dove si possono perdere dati (M2b, M3); (3) la simulazione profonda (`test:deep`) gira in CI, non a ogni modifica in locale (in locale bastano i 150 scenari di `pnpm test`); (4) quando possibile lavorare dal Mac.

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
| R16 | **Chiuso in M1b** (B7). Era: quando arriva la prima migrazione applicativa, applicare prima la migrazione `key_check`, verificare la chiave, poi il resto (TODO in `apps/server/src/main.ts`) | migrazioni eseguite con chiave sbagliata |
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

### Decisioni di M3a (conflitti e storico, server + web)

| # | Decisione | Costo se sbagliata |
|---|---|---|
| M3-1 | La risoluzione è un'op `resolve` nel normale `/commits`, decisa dall'arbitro puro (`decideResolve`), non una rotta dispositivo a parte: stesso lock, stessa idempotenza, testabile nel simulatore | Basso: una rotta dedicata si aggiungerebbe sopra |
| M3-2 | Scritture della web app senza dispositivo: versioni con `device_id` nullo, journal con l'UUID nullo `WEB_AUTHOR`; nessuna migrazione | Basso: una colonna `author` si può aggiungere in seguito |
| M3-3 | Ripristini = `put` costruiti dal server con base = testa letta; se la testa cambia nel frattempo il ripristino diventa candidata di conflitto (niente si perde) | Basso |
| M3-4 | GC dei blob: prima la riga (lock del vault + advisory lock sulla chiave), poi l'oggetto; un crash lascia solo spazio sprecato | Basso: spazio orfano, recuperabile con una scansione dello storage |
| M3-5 | La copia di "tieni entrambe" dalla web app ha l'orario in UTC (il server non conosce il fuso dell'utente) | Minimo: solo il nome del file |
| M3-6 | Un file nel cestino con un conflitto aperto non viene svuotato; le versioni fissate da conflitti aperti (base, testa, candidate) non scadono | Nessuno: occupa solo spazio |
| M3-7 | M3a non si rilascia senza M3b: il plugin di oggi ignora `conflict_resolved` e resterebbe bloccato sui file risolti dalla web app | Nessuno finché non c'è una release tra le due. **Risolto da M3b** (stessa release) |
| M3-9 | M3b: con una copia locale cambiata dopo un conflitto risolto altrove, la copia sale con un `put` normale e apre un nuovo conflitto invece del file affiancato (`keep_both` implicito di 03 §9.3): niente file in più, il contenuto resta nella vista conflitto | Basso |
| M3-10 | M3b: risolve solo il dispositivo con una candidata (o la web app); gli altri vedono il conflitto con l'invito a risolverlo altrove. Gli autori delle versioni (nome del dispositivo, ora) stanno solo in memoria: dopo un riavvio la vista mostra "un altro dispositivo"/"ora sconosciuta". Offline una scelta resta in coda e la UI la conta come fatta | Basso: aggiungere una rotta di dettaglio del conflitto per i dispositivi |
| M3-11 | M3b: un dispositivo molto indietro che incontra un `file_put` il cui blob è già stato raccolto fallisce la scrittura e riprova; la testa corrente non scade mai, quindi il pull successivo la porta (verificato per ragionamento, chiude il punto aperto di M3-8) | Basso |
| M3-8 | Minori rinviati dalla revisione di M3a: un ripristino dalla web app che diventa candidata di conflitto risponde comunque 204 (finestra di millisecondi; il contenuto è nel centro conflitti); i retry della web app usano un `opId` nuovo (409 o una versione in più, mai perdite); sessioni di upload scadute ma non ancora spazzate trattengono il blob fino allo sweep; un dispositivo molto indietro che rigioca `file_put` di blob già raccolti va verificato in M3b | Basso |

### Decisioni di P3 (M6: pairing con QR e magic link)

| # | Decisione | Costo se sbagliata |
|---|---|---|
| Q1 | Link `obsidian://kamino?server=…&token=…` con token da 256 bit, nel DB solo il suo SHA-256; 10 minuti per tutto il flusso; monouso: un secondo claim riceve 409 `pairing_already_claimed` e l'origine viene avvisata (`pairing_reused`, `reused: true` nello stato) | — |
| Q2 | Il token del nuovo dispositivo è derivato dal segreto del claim con HMAC sotto una chiave del server (`deviceTokenOf`, chiave `hkdf(master key, "kamino/v1/pairing")`): al claim si salva solo l'hash del token, all'approvazione il dispositivo nasce con quell'hash, al poll successivo lo stato passa a `consumed` e il token si ricalcola. Si riconsegna a ogni poll **entro i 10 minuti** del flusso, così una risposta persa si recupera; dopo, solo `consumed`. Nessun segreto in chiaro a riposo né nei log | Basso |
| Q3 | Chi può offrire e rispondere: il proprietario con sessione web o un dispositivo **dello stesso vault** (Bearer); tutto il resto è 404, nessun bypass per l'admin. Codice di verifica di 4 caratteri senza 0/O/1/I | — |
| Q4 | Tempo reale: `pairing_request`, `pairing_closed`, `pairing_reused` a tutti i dispositivi connessi del vault; messaggi aggiuntivi, `PROTOCOL_VERSION` resta 1. Il plugin d'origine interroga comunque l'offerta aperta ogni 3 s, perché il canale può essere giù | Nessuno |
| Q5 | Limiti per IP: claim 20 ogni 15 minuti, poll e ritiro 900 ogni 15 minuti (il plugin interroga ogni 2 s); offerte 30 ogni 15 minuti **per utente** (un'offerta può mandare un'email). Esenzione CSRF per `POST /pairings/claim` e per le richieste con `Authorization: Bearer|Claim` | Basso |
| Q6 | `?email=1` manda il link all'utente tramite la coda email, accodato nella stessa transazione dell'offerta: senza SMTP 409 e nessun pairing lasciato indietro. L'eliminazione di un utente cancella i suoi pairing | — |
| Q7 | Plugin: il segreto del claim resta solo in memoria (chiudere Obsidian durante l'attesa = rifare la scansione); un link `http://` su telefono è rifiutato prima di contattare il server; due poll contemporanei condividono la stessa richiesta, così il secondo non può vedere `consumed` | Basso |
| Q8 | Web: in modalità ibrida tutta l'API va al server vero (pairing compreso), quindi MSW e il pannello "Dati finti" non partono. Migrazione unica di P3: `0008_common_lilandra` | Nessuno |
| Q9 | Revisione finale di P3, nessun problema critico; corretti: token con chiave del server e riconsegna entro i 10 minuti (Q2); claim con `protocolVersion` fuori da `[PROTOCOL_MIN_SUPPORTED, PROTOCOL_VERSION]` → 426 `protocol_unsupported`; avviso di riuso solo mentre la richiesta attende risposta, e la web app lo mostra prima di approvare; limite sulle offerte (Q5); pulizia oraria dei pairing scaduti da più di un giorno (`sweepPairings`, con lo sweep degli upload); plugin: `dispose()` allo scaricamento e allo scollegamento, un poll rifiutato (401/403/404) chiude il claim, solo rete/5xx/429 si riprovano. Nuovi test: vault eliminato, dispositivo revocato e utente bloccato all'approvazione, due approvazioni insieme, ritiro durante l'approvazione | — |

### Decisioni di P2 (M5: admin, quote, email)

| # | Decisione | Costo se sbagliata |
|---|---|---|
| A1 | Impostazioni di sistema in `system_config` con la fonte di ogni valore (ambiente → UI → default); i campi impostati dall'ambiente sono bloccati nella web app. La password SMTP è cifrata con la chiave di sistema e non torna mai al client (`passwordSet`) | Basso |
| A2 | Email da una coda durevole in Postgres (`email_outbox`), drenata da un job pg-boss ogni minuto con ritentativi; testi it/en nella lingua del destinatario (l'invito in quella di chi invita). Nei log e nei job mai indirizzi né link | Basso |
| A3 | Quote: contano `blobs.size` dei vault attivi; si rifiutano solo i byte nuovi (`quota_exceeded`), abbassare una quota non cancella niente. Le prenotazioni di upload in corso contano una volta per contenuto (due dispositivi che caricano lo stesso file non lo pagano due volte). **Limiti noti:** un contenuto presente in due vault conta due volte (i blob sono cifrati per vault); nella scheda admin `null` = "usa la predefinita", quindi con una quota predefinita non si può dare a un singolo utente "illimitato" | Basso: da rivedere se servono quote per utente illimitate |
| A4 | Rotte admin solo con ruolo admin **e** TOTP attivo (`requireAdmin`); il modulo `src/admin/` non importa (neanche indirettamente) nulla che decifri: lo verifica `test/admin-architecture.test.ts`. L'admin vede solo aggregati (spazio, numero di vault/dispositivi, livello di sync peggiore) | — |
| A5 | Ultimo admin: declassare, bloccare o eliminare l'unico admin attivo → 409 `last_admin`, sotto un advisory lock (due admin che si declassano, bloccano o eliminano a vicenda non passano entrambi) | — |
| A6 | Blocco: sessioni revocate e socket chiusi (`user_blocked`), i token dei dispositivi rifiutati finché lo stato non torna attivo; i dispositivi **non** vengono revocati, quindi dopo lo sblocco riprendono da soli | Basso |
| A7 | Registro admin: mostra solo le azioni di `AuditAction` (setup e reset TOTP restano nel registro di sicurezza dell'utente) | Nessuno |
| A8 | Eliminazione utente (F6/U-12): conferma col nome utente; account fermato subito; con export, ZIP di tutti i vault (una cartella per vault, nomi resi sicuri e senza doppioni) cifrato con STREAM sotto una chiave derivata dal token, link solo all'email dell'utente, valido 7 giorni **dall'invio dell'email** (`/api/v1/exports/:token`, oscurato nei log): l'email `export_ready` è accodata nella stessa transazione dell'export e non viene mai abbandonata, quindi con SMTP giù l'eliminazione aspetta. All'avvio dell'eliminazione i link di reset già emessi vengono invalidati. Se l'export di un utente fallisce, gli altri proseguono e il suo si ritenta al giro dopo. Alla scadenza (o subito senza export): DEK distrutte (crypto-shredding, i blob li toglie `vault-purge`), export distrutto, dati personali rimossi, riga anonimizzata (`deleted-<id>`) e nome utente di nuovo libero. Il nome utente di un account eliminato resta nel registro admin (chi ha fatto cosa, su chi): è voluto, il registro è storia. Migrazione unica di P2: `0007_loud_clea` | Medio: un export perso dopo 7 giorni non si recupera (voluto) |
| A9 | Oggetti fuori dai vault (export, sonda di salute) sotto il prefisso `SYSTEM_PREFIX` (UUID nullo), perché `FsBlobStore` accetta solo chiavi `idVault/idBlob` | Nessuno |
| A10 | Playwright: il seed crea anche l'admin `root` con TOTP (segreto in un file temporaneo letto dal test) e l'utente `luigi`, che il test admin blocca senza disturbare `mario` usato dal test dell'area utente in parallelo | Basso |
| A11 | Coda email: dopo l'invio destinatario e parametri (link compresi) vengono azzerati e le righe inviate si cancellano dopo 30 giorni; le righe di un utente eliminato spariscono con lui (`email_outbox.user_id`). Ritenzione: il massimo di sistema (`maxRetentionDays`) limita anche i vault con ritenzione più lunga, nel cestino, nella cronologia e nella compattazione | Basso |
 (M4: area utente sul server)

| # | Decisione | Costo se sbagliata |
|---|---|---|
| U1 | Data fuori dalla finestra dello storico (ZIP "com'era il…") = codice esistente `history_window` (400), non un nuovo `out_of_retention` | Basso: un codice in più nel catalogo |
| U2 | Nuova colonna `journal.from_path_enc` (migrazione `0004`): il percorso prima di uno spostamento, per ricostruire l'albero a una data. Le voci scritte prima non ce l'hanno: uno spostamento vecchio si "disfa" solo a partire dalla migrazione | Basso: storico pre-migrazione solo su vault di prova |
| U3 | Timestamp di `files`, `file_versions`, `conflicts`, `conflict_candidates` dall'orologio del server (`now()` iniettato), non dal default del DB | Nessuno |
| U4 | Eliminazione vault: in una transazione stato `deleted`, DEK e impostazioni azzerate (`dek_wrapped` ora nullable, migrazione `0005`), dispositivi revocati; socket chiusi subito. I blob li cancella un job orario `vault-purge` (minuto 37), idempotente | Basso: blob illeggibili restano su disco fino a un'ora |
| U5 | ZIP in streaming con yazl, cartella di configurazione esportata come `.obsidian/`; nome del file `vault-AAAA-MM-GG.zip` (mai il nome del vault negli header) | Nessuno |
| U6 | Ripristino e risoluzione: il server risponde 501 `not_implemented`; nella web app i pulsanti sono disattivati con "In arrivo" (`common.comingSoon`) tranne con le API finte (flag `features.historyWrites` in `src/lib/features.ts`). Si attivano con M3 | Nessuno |
| U7 | Playwright (`pnpm --filter @kamino/web e2e`): server vero su Postgres usa-e-getta (`apps/server/test/e2e-server.ts`, porta 8181) + Vite in modalità ibrida (porta 5181). Non gira in CI per ora (serve Docker e il browser) | Basso |

| U8 | Revisione finale (8 rilievi), corretti: errore di lettura a metà ZIP → stream distrutto, mai il processo; download annullato → non si leggono altri blob; `vaults.journal_floor_at` (migrazione `0006`) impedisce di ricostruire date già compattate anche se si alza la retention; `files.deleted_at` data il cestino dopo la compattazione; `deleteVault` prende il lock della riga del vault e commit/upload ricontrollano lo stato sotto lock (404, niente scritture in un vault eliminato); mock ZIP fuori finestra 400 come il server | — |
| U9 | Rinviato: id di file/versione scelti dal client, univoci solo per vault. Se lo stesso id esiste in due vault dello stesso utente, `/files/:id/versions` e `/versions/:id` rispondono 404 (nessuna fuga verso altri utenti; il plugin usa UUID). Da risolvere con M3, mettendo il vault nella rotta | Basso |

Nota: `multi-client.test.ts` è fallito una volta (contatore `snapshots` a 0) sotto il carico di `pnpm test` completo; ripetuto da solo, con la suite del server e con tutta la suite è passato. Da tenere d'occhio: se si ripresenta, il seme fisso dipende dai tempi.

### Decisioni di M2b (tempo reale nel plugin)

Spec `docs/superpowers/specs/2026-11-11-m2b-plugin-realtime-design.md` (F1–F10, §6), piano `docs/superpowers/plans/2026-11-11-m2b-plugin-realtime.md`; note in `docs/03-sync-protocol.md` §8.2. Registro completo delle decisioni in `.superpowers/sdd/2026-11-11-m2b-plugin-realtime/progress.md` (non versionato).

- WebSocket come campanello: le notifiche avviano cicli, i dati arrivano sempre via REST; ogni notifica fa un ciclo completo (scansione con cache), da ottimizzare solo se misurato.
- Chiusure `4401`/`4403`/`4404`: prima una verifica REST su una rotta del vault, poi eventuale stop (`vault_gone` mostrato come "revocato"); l'attesa tra i tentativi si azzera solo dopo 60 s di connessione stabile.
- Modalità nel motore (`setMode`), pull ogni 5 min in Live col socket giù; eco riconosciuta per path+dimensione+mtime (10 s); nota aperta con modifiche non salvate mai sovrascritta.
- Rete a consumo: domanda su iOS mai bloccante, la risposta vale 30 minuti; "non chiedere più" è del plugin fino al riavvio; i file in attesa non contano come "al sicuro" ma non fanno scattare l'avviso orario; l'avviso per coda vecchia solo in Live.
- `ObsidianFs`: sostituzione con copia messa da parte (nome corto + manifest) e recupero all'apertura (se differisce, resta "(recovered)"); rinomine di sole maiuscole senza mai sovrascrivere un altro file; streaming con ripiego per file e controllo dei byte.
- Minori rinviati dalla revisione di M2b (15): ciclo in più dopo il proprio push, tempi dell'eco su FS con mtime grossolano, mtime nel futuro sempre "recenti", modifiche concorrenti contate come guasti di streaming, rimandati in download che lampeggiano "al sicuro" e manca la dicitura "in attesa del Wi-Fi", conteggio non memorizzato mentre ci sono file in attesa, socket lento a riprendersi al ritorno in primo piano, factory del socket che lancia, file temporaneo della rinomina di maiuscole non recuperato, timer disattivati ma non cancellati, Manuale che sincronizza al cambio impostazioni, riga duplicata nell'host, nessun ciclo quando la rete torna libera, copertura della protezione dell'editor (CRLF/BOM, canvas), nota per un attimo assente durante la sostituzione.

### Decisioni di M1d (motore del plugin)

Spec `docs/superpowers/specs/2026-11-10-m1d-plugin-engine-design.md` (E1–E10, senza spike per scelta del committente); note di implementazione in `docs/03-sync-protocol.md` §8.2.

| # | Decisione |
|---|---|
| E1 | Guscio di `step()`, collegamento vero, stato vero, cartelle, impostazioni; QR (M6) e risoluzione conflitti (M3) visibili come "in arrivo"; `FakeServer` solo nelle build di sviluppo |
| E2 | Pacchetto `packages/sync-engine` indipendente dalla piattaforma (porte `VaultFs`, `Http`); stesso motore nel plugin e nei test del server |
| E3 | Streaming dove possibile (lettura dall'URL della risorsa, `appendBinary` su file temporaneo, hash verificato); senza streaming oltre 100 MB → rimandati |
| E4 | Cache degli stat; watcher con debounce 5 s / 1,5 s; scansione completa a ogni ciclo |
| E5 | Stato durevole atomico nella cartella del plugin, `persist` sempre per primo |
| E6 | REST con `requestUrl`, retry 1 s → 5 min, pull periodico 60 s fino a M2b; revoca/blocco/protocollo fermano il motore |
| E7 | Collegamento sulle rotte di M1c (TOTP nella stessa richiesta, `totp_mandatory` con messaggio); trasferimento iniziale con file, byte, pausa |
| E8 | Stato dal motore, mai inventato; conflitti elencati, risoluzione in M3 |
| E9 | Cartelle sul client in `sync-core`, simulazione profonda verde |
| E10 | Impostazioni effettive dal server con mappa delle categorie; cambio di configurazione → "ricarica Obsidian" |

Decisioni prese durante l'esecuzione (registro completo con il costo di ciascuna nel ledger `.superpowers/sdd/2026-11-10-m1d-plugin-engine/progress.md`, non versionato; le principali):
- cartelle in `Durable.folders`, separate dai file; spostamento remoto = `mkdir` + vecchia cartella rimossa da vuota; alias `d`/`D` su disco case-sensitive; cartella spostata in area esclusa o su una cartella esistente = "cancellata qui" (le cartelle non hanno contenuto);
- `cursor_too_old` → evento `resync` → snapshot riconciliato con l'indice esistente sintetizzando le voci di journal perse (il simulatore ora compatta il journal);
- token del dispositivo in `data.json` accanto al collegamento (cartella del plugin, mai sincronizzata; revocabile dal web);
- le impostazioni del plugin decidono l'override del dispositivo (un override cambiato dal web viene riportato alla scelta del dispositivo);
- nelle build di sviluppo il server vero si attiva con `localStorage["kamino-sync-dev-real-server"] = "1"`.

Trovati e corretti durante M1d (ognuno con il suo test): una decina di difetti delle cartelle e della riconciliazione trovati dal simulatore; `kick()` del motore che poteva far girare `syncNow` all'infinito; il bundle di produzione che conteneva ancora `FakeServer` e le credenziali `demo`.

#### Revisione finale di M1d (2026-11-11) — corretta

- **C1 (critico):** un file illeggibile durante la scansione (lock su Windows, file iCloud non scaricato, stream interrotto) risulta cancellato e la cancellazione va al server e agli altri dispositivi; `unreadableFiles()` non è mostrato da nessuna parte.
- **I1:** un elenco vuoto o parziale (disco non montato, permesso revocato su Android, `list("")` diverso dal mock) cancellerebbe tutto: serve un freno (troppe sparizioni in un ciclo → stop e conferma).
- **I2:** una rinomina durante la scansione diventa cancellazione + nuovo file.
- **I3:** se il salvataggio dello stato fallisce, il motore resta bloccato fino al riavvio senza dirlo.
- **I4:** sui dispositivi senza streaming la scansione (e i controlli di hash) leggono interi anche file enormi o esclusi → crash all'avvio.
- **I5:** se fallisce solo una parte delle chiamate delle impostazioni, il motore parte con i default perdendo le esclusioni del vault.
- **I6:** la pausa non ferma i download già in coda; scollegare durante il trasferimento iniziale aspetta tutti i download.
- **I7:** il primo sync di un vault grande costa O(N²) (stato clonato e riscritto a ogni evento).
- Minori rinviati (11): finestra rimuovi→rinomina, rinomine solo di maiuscole su Windows/macOS, cache degli stat con mtime grossolano, streaming disattivato dopo un fallimento, HTTPS su mobile controllato solo all'inizio, `Engine.open` fallito mai ritentato, messaggi d'errore del login, `onunload` che non attende lo stop, trasferimento mai "completato" con un file rimandato, finestra di applicazione delle impostazioni, test sul dispositivo per la scrittura remota sul file aperto nell'editor.
- **Tutti i critici e gli importanti sono corretti**, ognuno con il test che falliva prima (commit da `db7ef08` a `2000c27`): file illeggibile = presente; freno sulle cancellazioni di massa (stato "Decisione", pulsante "Conferma le cancellazioni…", soglia: tutti i file con almeno 5, oppure più di 50 e più del 25%); rinomina durante la scansione; salvataggio dello stato fallito; motore in pausa finché non ha le impostazioni del vault; pausa che ferma i trasferimenti in coda; niente letture intere senza streaming; salvataggi raggruppati (200 download: da 203 a meno di 40 salvataggi).
- Verifica completa verde (2026-11-11, PC Windows): build, typecheck, lint, format; test per pacchetto (brand 12, protocol 37, status 38, sync-core 74 + deep 3000, sync-engine 52, ui-diff 10, web 186, plugin 257, server 175). Sul PC lento: un pacchetto alla volta con `pnpm --filter <pkg> test -- --maxWorkers=2` e `DOCKER_HOST=tcp://127.0.0.1:2375`. Un fallimento di `test:deep` visto una volta non si è più riprodotto in ~30.000 scenari successivi.

### Decisioni di M2a (tempo reale sul server)

| # | Decisione |
|---|---|
| D1 | Solo server; la parte plugin di M2 (applicazione delle voci, eco, modalità, D-07, Wi-Fi) è M2b, dopo M1d |
| D2 | WebSocket `/api/v1/ws` (03 §7): `hello` entro 5 s col token, catch-up a pagine di 500, `ack`/`status`, heartbeat 30 s con ricontrollo di revoca e blocco |
| D3 | Fan-out: `pg_notify` nella transazione del commit, `LISTEN` dedicato (postgres-js si riconnette da solo), hub per vault, lettura coalescente una pagina alla volta |
| D4 | Compattazione dietro i cursori attivi (90 giorni) e la retention; `journal_floor` → `cursor_too_old` (`410` / chiusura `4410`) |
| D5 | pg-boss (ADR 0008): compattazione notturna e pulizia degli upload orarie, avviati dopo la verifica della chiave |
| D6 | Dispositivi dal web (elenco/dettaglio/rinomina/revoca) e dal plugin (`/device`, `/vault/devices`); livelli da un'unica funzione |
| D7 | Impostazioni di vault e override cifrati; voce `vault_settings_changed` (`_vault`, `ignorable`); default S-10 senza categorie anche in `sync-core` |
| D8 | `PROTOCOL_VERSION` resta 1 |

Trovati durante M2a:
- un ciclo infinito nel limite di 5 socket per dispositivo, trovato dai test dell'hub;
- `buildApp` che aspettava il `LISTEN`, rompendo l'avvio con il database irraggiungibile: ora il listener parte in background;
- `revoke` del web che doveva restituire il `Device`;
- il test multi-client che con pochi giri non arrivava mai alla compattazione: ora controlla di aver attraversato ogni percorso.

Revisione finale (0 critici, 3 importanti, 8 minori). Corretti, con test:
- più `hello` sullo stesso socket non autenticato avviavano più ricerche del token; ora c'è uno stato "in autenticazione";
- `changes` poteva arrivare prima di `welcome`;
- un dispositivo sempre connesso sembrava inattivo: ora `ack` e heartbeat aggiornano "ultimo contatto", al massimo una volta al minuto;
- il timer del `hello` resta attivo fino a `welcome`;
- `ack` e `status` ravvicinati vengono raggruppati;
- un cursore oltre la testa riceve `cursor_too_old`;
- impostazioni identiche non producono una voce di journal;
- heartbeat dei test meno aggressivo; il client di test risponde ai ping, verifica che `welcome` arrivi per primo, e il test multi-client cambia anche le impostazioni.

Rinviati:
- `Hub.closeUser` va collegato al blocco degli utenti dall'admin (M5); oggi il blocco arriva al battito successivo;
- la compattazione per retention si basa su `journal.at`, preso dentro la transazione dopo il lock del vault, quindi in ordine con il `seq`.

### Decisioni di M1c (server di sync)

| # | Decisione |
|---|---|
| C1 | Perimetro: collegamento con credenziali (QR in M6), token dei dispositivi, vault con DEK, upload a chunk, download con `Range`, commit tramite l'arbitro, journal, snapshot, `ack`/`status` via REST (WebSocket in M2); più `GET /vaults` e `/vaults/summary` per la web app |
| C2 | `BlobStore` con due adattatori, file system e S3, e un unico test di contratto; il test S3 usa SeaweedFS in testcontainers (MinIO non pubblica più immagini) |
| C3 | Arbitro sincrono e puro: il server prepara i dati in anticipo e, se `decide` ne chiede altri (`NeedData`), li carica e ripete; una transazione per op con `SELECT … FOR UPDATE` sul vault |
| C4 | `MemoryStore` è l'oracolo: fast-check con `size: "max"` (variabile `ORACLE_RUNS` per più giri) |
| C5 | Collegamento in tre passi: `POST /devices/login` → token di iscrizione (10 min) → `/enroll/vaults…` → token del dispositivo (solo l'hash nel DB, revocabile) |
| C6 | Chunk cifrati all'arrivo come segmenti STREAM (4 MiB) nello staging; `complete` verifica lo SHA-256 e promuove senza ricifrare |
| C7 | `Range`: si leggono e decifrano solo i segmenti necessari |
| C8 | Path, nomi di vault e hash solo cifrati; unicità con `path_mac`; il controllo "cartella con discendenti vivi" decifra i path in memoria |
| C9 | `KAMINO_MAX_FILE_BYTES` (500 MB) → `file_too_large`; quote in M5 |
| C10 | Sessioni di upload scadute (24 h) ripulite da un timer orario; GC dei blob orfani con lo storico (M3) |

Trovati e corretti durante M1c: l'oracolo con le dimensioni piccole di fast-check passava senza provare nulla; con `size: "max"` ha trovato un **bug dell'arbitro** (resurrezione e ripristino di cartella: il file tornava vivo prima di cambiare path, violando l'unicità; ora la mutazione `path` precede `head`/`undelete`, con test di regressione). `file_versions` non salvava la base dichiarata (vincolo [V] di 05 §5): ora `base_version_id` c'è, anche per i candidati di conflitto. Il test "cifrato a riposo" confrontava JSON (che nasconde i byte): ora legge i byte come testo.

Revisione finale (0 critici, 5 importanti, 7 minori). Corretti, con test che falliscono sul codice precedente:
- `complete` rileggeva i chunk dopo la verifica e un chunk poteva cambiare nel mezzo. Ora la sessione passa da `open` a `completing` a `done` con una presa atomica, e un solo passaggio verifica l'hash e scrive gli stessi byte.
- `complete` riscriveva un blob esistente. Ora c'è un lock per blob, e un blob già presente non si tocca.
- Due `complete` concorrenti si rompevano a vicenda. Ora le ripetizioni restituiscono il risultato.
- Il livello del vault era "al sicuro" anche con modifiche in coda, senza dispositivi o con dispositivi mai sincronizzati.
- Un admin senza TOTP poteva collegare dispositivi.
- Minori: token di iscrizione validi per un utente bloccato; `uploadId` malformato → 500; un chunk rinviato con byte diversi (stesso nonce); staging orfano mai ripulito; limiti di `status`.

Rinviati:
- spazio di staging senza limite (con le quote, M5);
- esenzione CSRF per qualunque `Bearer` (sicura per via del preflight CORS);
- una query per file in `snapshot` e per vault in `/vaults` (prestazioni).

Nota per M1d: `POST /devices/login` può rispondere `403 totp_mandatory`.

### Decisioni di M1b (crittografia + autenticazione web)

| # | Decisione |
|---|---|
| B1 | Crittografia completa + auth web; device-login e token dei dispositivi in M1c con i vault |
| B2 | Argon2id con `@node-rs/argon2` (binari precompilati), minimo OWASP 19 MiB / 2 / 1 |
| B3 | AEAD a segmenti (STREAM su AES-256-GCM) su `node:crypto`, vettori verificati con implementazioni indipendenti (Python, WebCrypto) |
| B4 | Costanti crittografiche fisse, mai dal nome del prodotto |
| B5 | Email in M5: intanto link da CLI (`users invite`, `users reset-link`, `users reset-2fa`); `forgot` risponde `smtp: false` |
| B6 | Web: modalità finta (predefinita) e ibrida (`VITE_KAMINO_API=hybrid`) |
| B7 | R16: migrazione `key_check`, verifica della chiave, poi il resto; errore originale mai mascherato dall'unlock |
| B8 | Cookie `HttpOnly`/`SameSite=Lax`/`Secure` con HTTPS; anti-CSRF `X-Requested-With` |
| B9 | `KAMINO_TRUST_PROXY` (numero di salti o IP/CIDR) decide di quali proxy fidarsi per l'IP del client; assente = nessuno (revisione C1) |

R16 è **chiuso** (test d'ordine al posto del tripwire). Trovato e corretto durante M1b: il token degli inviti finiva nei log tramite l'URL della richiesta (ora sostituito). La revisione finale (2 critici, 8 importanti) ha trovato e fatto correggere, con test in `apps/server/test/auth-security.test.ts`: rate limit eludibile con `X-Forwarded-For` falsificato (ora `KAMINO_TRUST_PROXY`, assente per default, `1` nei compose Caddy e tunnel) e sfida TOTP senza limite di tentativi (ora 5, più un limite per account); token di reset/invito nei log tramite gli URL web e il 404 di Fastify; usi concorrenti di codici TOTP, codici di recupero, setup e token di reset (ora aggiornamenti condizionali e transazioni); admin senza TOTP bloccato anche lato server; `email_taken`/`username_taken` invece di 500; orari presi dall'orologio dell'applicazione; memoria limitata per limiter e sfide; `invalid_request` per i corpi malformati.

### Decisioni di M1a (sync-core)

| # | Decisione |
|---|---|
| Z1 | M1 divisa in M1a (sync-core), M1b (crypto + auth), M1c (server: vault/file/blob/commit), M1d (motore del plugin, dopo gli spike) |
| Z2 | M1a comprende arbitro puro e simulatore multi-client |
| Z3 | Core funzionale, guscio imperativo: niente orologio, casualità o I/O in `sync-core` |
| Z4 | Schemi di sync in `@kamino/protocol` (`sync.ts`) |
| Z5 | `collisionKey` conservativa (folding largo, "ß" = "ss") |
| Z6 | Glob scritti in casa (niente `path` di Node nel plugin) |
| Z7 | Fuori: risoluzione conflitti (M3), WebSocket e compattazione (M2), cifratura (M1b) |
| Z8 | Outbox ricavata dall'indice; op con esito ignoto ripetute identiche |
| Z9 | Client M1a solo file (cartelle in M1d); riconciliazione con indice esistente in M2 |
| Z11 | Contratto del guscio: effetti sui file in ordine con il loro evento (`written` porta l'hash); una scansione solo a effetti completati |
| Z12 | Esclusioni insensibili alle maiuscole sui file system che lo sono |
| Z13 | Un file escluso su un dispositivo non genera mai una cancellazione; togliendo l'esclusione si riprende (revisione C1) |
| Z10 | File spostato altrove verso un nome non rappresentabile qui: la copia locale va nel cestino solo quando il server ne ha il contenuto, il nome si libera (trovato dal simulatore; precisa 03 §6.4) |

La revisione finale (2 critici, 3 importanti) ha trovato due cancellazioni spurie (esclusioni, `moved_elsewhere` verso aree escluse), una corsa del cestino e op senza esito scartate, più i limiti del simulatore (effetti istantanei, 5 contenuti, esclusioni mai usate, nessuna verifica delle cancellazioni non volute): tutto corretto. Il simulatore ora ha contenuti unici, effetti asincroni, esclusioni per dispositivo e cambi di impostazioni, timeout con consegna tardiva, risposte troncate, quota piena, e verifica che nessun contenuto esca dai file vivi senza un'azione dell'utente e che non nascano duplicati. Prima ancora il simulatore aveva trovato una decina di difetti del client (nessuna perdita di contenuti, ma mancata convergenza o azioni altrui annullate), tutti corretti con regressione esatta in `packages/sync-core/src/sim/regressions.ts`. Strumenti di indagine usati: rigiocare il JSON del controesempio con `World` e tracciare eventi/effetti di un client.

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
- **M2:** potare le lapidi dell'indice del client (file cancellati che restano come voci inerti per ricordare i `seq`) insieme alla compattazione del journal. (La riconciliazione con indice esistente dopo `cursor_too_old` è fatta in M1d.)
- **M1a, minori rinviati dalla revisione:** `mkdir` su cartella esistente restituisce `accepted` con l'altro `fileId` (03 dice `duplicate`: allineare il documento in M1c); cancellazione di cartella con discendenti vivi → `modified_since` (da documentare); nessun controllo su `put`/`move` sotto un path che è un file; `stopped` è volatile; MAX_PATH di Windows non modellato; su Linux un disco con forme NFC e NFD dello stesso nome (stesso path canonico): da definire nel contratto del guscio in M1d.
- **M2b:** (la mappa delle categorie delle impostazioni è fatta in M1d, `apps/plugin/src/engine/settings-map.ts`). Il client WebSocket del plugin deve gestire i codici di chiusura di 03 §7 (nota M2a) e `403 totp_mandatory` su `/devices/login`.
- **Multi-istanza:** la revoca chiude subito i socket dell'istanza che la riceve; le altre istanze se ne accorgono al battito successivo (entro 30 s).
- **Sempre:** `pnpm --filter @kamino/sync-core test:deep` (3000 scenari) da rieseguire dopo ogni modifica del client (cartelle sul client: fatte in M1d).

- **Vincolo di rilascio:** dal M1d la build di produzione non contiene più il `FakeServer` (verificato da `apps/plugin/test/manifest.test.ts`). Resta: **nessuna release pubblica prima dei test sui dispositivi** elencati in `docs/spikes/README.md` ("Test sui dispositivi dopo M1d").
- **Notice cliccabile:** `Notice.noticeEl` è deprecato nei tipi di Obsidian 1.14 ma è quello giusto per `minAppVersion` 1.5.0; da rivedere quando si alza la versione minima (con gli esiti di R-1).

Esito della revisione finale di M0: questi restano aperti di proposito.

- **M1:** R16 (ordine migrazioni/verifica chiave) insieme a: errore di unlock del lock migrazioni che può mascherare l'errore originale; snapshot completo di `ErrorCode` quando le rotte iniziano a emetterli; verificare se typescript-eslint supporta TS 7. Decidere `minAppVersion` del plugin con gli esiti di R-1 (`appendBinary` richiede Obsidian ≥ 1.12.3).
- **M2:** negoziazione protocollo (euristica intervalli invertiti, schema zod `ProtocolRange`); shutdown con exit code corretto e scadenza (oggi esce sempre con 0; `docker stop` durante le migrazioni attende 10 s).
- **M3:** collegare `ConflictView`/`StatusPanelView` alle implementazioni vere di `SyncStateSource`/`ConflictActions` (oggi `FakeSyncState`). Gli esterni espliciti di esbuild sono già fatti (sotto-fase UI 2).
- **M1/M2:** implementazioni vere di `ConnectionService`/`InitialTransfer` (HTTP, token del dispositivo al posto del `FakeServer`); applicazione delle impostazioni di comportamento e `engineAvailable = true`; ricostruzione del server da un dispositivo (V-05) con i suoi avvisi.
- ~~**M7:** minificare il bundle di produzione del plugin~~ fatto in M7c (415 KB).
- **Fase UI:** i punti aperti di M0 (flash del tema, modalità "sistema", chiavi `theme.*`, `<title>`/`lang`) sono **chiusi** nella sotto-fase 1. Restano: ripetizione insistente delle notice (S-05) e pannello di stato completo → sotto-fase 2 / M1; su mobile, senza una nota aperta (grafo, canvas, scheda vuota) l'azione nell'intestazione non può comparire e restano solo ribbon (nel menu laterale) e notice → da riconsiderare nella sotto-fase 2; verifica delle icone sul `minAppVersion` scelto (oggi `1.5.0`) → revisione della galleria del plugin.
- **M7 (hardening/release):** fatti in M7b/M7c: CLI `release-names`, `statement_timeout`, redazione annidata, base64 canonico, regole della rotazione, `versions.json` (R19). Ancora aperti: password DB via `*_FILE`; `cloudflared` da pinnare e `--token-file` da provare; `compose run … keys generate` da provare; commitlint sul primo push di un branch; cache della build Docker in CI.
- **Cosmetici:** estensioni di import miste e output nascosto nel test di build del plugin; riga lunga e data fissa in `CLAUDE.md`; file segreto UTF-16BE di lunghezza dispari segnalato come "illeggibile"; il suggerimento `docker compose run` nel messaggio d'errore della chiave non riporta `-T`/`-f`.

## In sospeso lato committente

- Descrizione e topic del repo GitHub (ancora vuoti; `gh` ora è autenticato sul Mac, si possono impostare con `gh repo edit`).
- **Prova del plugin su telefono** (rinviata dal committente il 2026-11-08, da fare insieme agli spike): copiare `vault/kamino/.obsidian/plugins/kamino-sync/` sul dispositivo e verificare: icone (avvisi "status icon … not available"), colori col tema, azione nell'intestazione della nota solo dagli stati Attenzione/Decisione/Bloccato; pannello nel cassetto laterale; vista conflitto a schede con diff unificato e "Modifica e unisci" (completa anche R-3 su mobile); scheda di benvenuto; **QR inquadrato con la fotocamera che apre davvero Obsidian e avvia il pairing**; blocco di `http://`; impostazioni (nota iOS). Su desktop tutto è provato.
- Spike su iPhone/Android reali (task 12): seguire `docs/spikes/README.md`, poi `R-1.md`…`R-5.md`, compilando le tabelle.

## Note sull'ambiente

- Macchina di sviluppo lenta: eslint impiega 10–20 s ad avviarsi, le build Docker diversi minuti.
- Docker: Rancher Desktop (WSL). Va avviato prima dei test.
- Storia del branch riscritta il 2026-11-06 (email dell'autore) e di nuovo il 2026-11-07 (R30, messaggio di un commit): eventuali checkout precedenti di `m0-fondamenta` vanno riallineati con `git fetch && git reset --hard origin/m0-fondamenta`.
