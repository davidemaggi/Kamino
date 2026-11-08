# Handover — stato del lavoro

> **Da leggere per primo** quando si riprende il lavoro (anche da un altro PC).
> Questo file è mantenuto **sempre aggiornato, committato e pushato** dopo ogni task completato o decisione rilevante.

**Ultimo aggiornamento:** 2026-11-08 — M0 mergiata su `main` (PR #1). Fase UI, sotto-fase 1 **implementata** sul branch `ui-fondamenta` (8 task su 8): in attesa dell'approvazione delle gallerie (web e plugin) da parte del committente, poi PR verso `main`.

## Dove siamo

| Fase | Stato |
|---|---|
| Brainstorming e design (`docs/00`–`05`, ADR) | ✅ approvato 2026-11-06 |
| Roadmap (`docs/06-roadmap.md`) | ✅ proposta |
| **M0 — Fondamenta** (`docs/superpowers/plans/2026-11-06-m0-fondamenta.md`) | ✅ completata sul branch (spike da eseguire su dispositivi reali) |
| Fase UI — sotto-fase 1: fondamenta del design system (spec `docs/superpowers/specs/2026-11-07-ui-fondamenta-design.md`, piano `docs/superpowers/plans/2026-11-07-ui-fondamenta.md`) | ✅ implementata sul branch `ui-fondamenta` (task 1–8); ⏳ approvazione delle gallerie |
| M1…M7 | ⏳ |

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

1. **Fase UI, sotto-fase 1 — chiusura:** gallerie provate dal committente su desktop (2026-11-08; telefono rinviato, vedi "In sospeso lato committente"). Restano: revisione finale del branch (un subagente), PR `ui-fondamenta` → `main`, merge.
2. **Spike sui dispositivi** (committente, rinviati di proposito a più avanti): `docs/spikes/README.md`, poi `R-1.md`…`R-5.md`. Con i risultati: aggiornare `docs/02-architecture.md` §10, eventuali nuove ADR, decidere `minAppVersion` del plugin, cancellare `spikes/`.
3. **Fase UI, sotto-fasi 2–4** (pannello di stato e conflitti nel plugin, onboarding/QR, schermate web), ognuna con brainstorming → spec → piano; poi piano M1.
4. All'inizio di M1: applicare **R16** (ordine migrazioni ↔ verifica chiave). Un test (`apps/server/test/migrations-guard.test.ts`) fallisce apposta quando compare la seconda migrazione.

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

## Punti aperti (rinviati, con milestone)

Esito della revisione finale di M0: questi restano aperti di proposito.

- **M1:** R16 (ordine migrazioni/verifica chiave) insieme a: errore di unlock del lock migrazioni che può mascherare l'errore originale; snapshot completo di `ErrorCode` quando le rotte iniziano a emetterli; verificare se typescript-eslint supporta TS 7. Decidere `minAppVersion` del plugin con gli esiti di R-1 (`appendBinary` richiede Obsidian ≥ 1.12.3).
- **M2:** negoziazione protocollo (euristica intervalli invertiti, schema zod `ProtocolRange`); shutdown con exit code corretto e scadenza (oggi esce sempre con 0; `docker stop` durante le migrazioni attende 10 s).
- **M3 (`ui-diff`):** sostituire la wildcard `@codemirror/*` negli external di `apps/plugin/esbuild.config.mjs` con una lista esplicita (Obsidian non fornisce `@codemirror/merge`).
- **Fase UI:** i punti aperti di M0 (flash del tema, modalità "sistema", chiavi `theme.*`, `<title>`/`lang`) sono **chiusi** nella sotto-fase 1. Restano: ripetizione insistente delle notice (S-05) e pannello di stato completo → sotto-fase 2 / M1; verifica delle icone sul `minAppVersion` scelto (oggi `1.5.0`) → revisione della galleria del plugin.
- **M7 (hardening/release):** CLI `release-names` con errori non gestiti e test deboli; `statement_timeout` sul ping di readiness; redazione di `databaseUrl` annidato; rigore del base64 della chiave; rotazione chiave (regola "riga attiva di altra chiave → rifiuto", tabella con sole righe ritirate); `versions.json` del plugin generato in release (R19); password DB via `*_FILE`; `cloudflared` da pinnare e `--token-file` da provare; `compose run … keys generate` da provare; commitlint sul primo push di un branch; cache della build Docker in CI.
- **Cosmetici:** estensioni di import miste e output nascosto nel test di build del plugin; riga lunga e data fissa in `CLAUDE.md`; file segreto UTF-16BE di lunghezza dispari segnalato come "illeggibile"; il suggerimento `docker compose run` nel messaggio d'errore della chiave non riporta `-T`/`-f`.

## In sospeso lato committente

- Descrizione e topic del repo GitHub (ancora vuoti; `gh` ora è autenticato sul Mac, si possono impostare con `gh repo edit`).
- **Prova del plugin su telefono** (rinviata dal committente il 2026-11-08, da fare insieme agli spike): copiare `vault/kamino/.obsidian/plugins/kamino-sync/` sul dispositivo, verificare icone (avvisi "status icon … not available"), colori col tema e azione nell'intestazione della nota solo dagli stati Attenzione/Decisione/Bloccato. La prova su desktop è fatta.
- Spike su iPhone/Android reali (task 12): seguire `docs/spikes/README.md`, poi `R-1.md`…`R-5.md`, compilando le tabelle.

## Note sull'ambiente

- Macchina di sviluppo lenta: eslint impiega 10–20 s ad avviarsi, le build Docker diversi minuti.
- Docker: Rancher Desktop (WSL). Va avviato prima dei test.
- Storia del branch riscritta il 2026-11-06 (email dell'autore) e di nuovo il 2026-11-07 (R30, messaggio di un commit): eventuali checkout precedenti di `m0-fondamenta` vanno riallineati con `git fetch && git reset --hard origin/m0-fondamenta`.
