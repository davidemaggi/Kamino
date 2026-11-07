# Handover — stato del lavoro

> **Da leggere per primo** quando si riprende il lavoro (anche da un altro PC).
> Questo file è mantenuto **sempre aggiornato, committato e pushato** dopo ogni task completato o decisione rilevante.

**Ultimo aggiornamento:** 2026-11-07 — durante M0, task 9 completato, task 10 (CI) in corso.

## Dove siamo

| Fase | Stato |
|---|---|
| Brainstorming e design (`docs/00`–`05`, ADR) | ✅ approvato 2026-11-06 |
| Roadmap (`docs/06-roadmap.md`) | ✅ proposta |
| **M0 — Fondamenta** (`docs/superpowers/plans/2026-11-06-m0-fondamenta.md`) | 🚧 in corso |
| Fase UI, M1…M7 | ⏳ |

**Branch di lavoro:** `m0-fondamenta` (pushato su `origin`). `main` contiene solo il commit iniziale.
**Metodo:** superpowers *subagent-driven-development* — un subagente implementa ogni task, un revisore lo controlla (spec + qualità), eventuali giri di correzione, poi il task successivo. Alla fine una revisione complessiva del branch.

### Task di M0

| # | Task | Stato |
|---|---|---|
| 1 | Monorepo e tooling | ✅ |
| 2 | `packages/brand` | ✅ |
| 3 | `packages/protocol` | ✅ |
| 4 | Release tooling + registro nomi in codice | ✅ |
| 5 | Server: config, health, version, DB, migrazioni | ✅ (1 giro di correzioni) |
| 6 | Server: master key, verifica all'avvio, CLI | ✅ (1 giro di correzioni) |
| 7 | Web app: scheletro | ✅ (1 giro di correzioni) |
| 8 | Plugin: scheletro | ✅ (1 giro di correzioni) |
| 9 | Docker + compose (LAN, tunnel, Caddy) + `docs/self-hosting.md` | ✅ (1 giro di correzioni) |
| 10 | CI GitHub Actions | 🚧 |
| 11 | Verifica comandi di `CLAUDE.md` | ⏳ |
| 12 | Spike R-1…R-5 (prototipi + istruzioni; misure su dispositivi reali a cura del committente) | ⏳ |
| — | Revisione finale dell'intero branch | ⏳ |

## Come riprendere su un altro PC

1. `git clone https://github.com/davidemaggi/Kamino.git && cd Kamino && git checkout m0-fondamenta`
2. **Identità git del repo** (la config globale del PC di lavoro usa un'altra email):
   `git config user.name "Davide Maggi" && git config user.email "davide.maggi@live.com"`
3. Node ≥ 22.12 (24 LTS consigliato), `corepack enable` (pnpm 10), Docker avviato (i test di integrazione usano Testcontainers).
4. `pnpm install && pnpm build && pnpm test`
5. In Claude Code: "leggi `docs/HANDOVER.md` e riprendi M0 dal primo task non completato con subagent-driven-development".
   Il registro dettagliato del controller (`.superpowers/sdd/…/progress.md`) **non è versionato**: le informazioni necessarie per riprendere sono riportate qui sotto.

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
| R19 | Pubblicazione di manifest/`versions.json` per BRAT e store rinviata alla fase di release (M7) | lavoro di release |
| R21 | Quick start del README allineato alla sequenza verificata nel task 9 (`docker run … keys generate` dopo la build dell'immagine) | — |

## Punti aperti per la revisione finale (minori rinviati)

- Server: errore di unlock del lock migrazioni può mascherare l'errore originale; shutdown esce sempre con 0; nessun `statement_timeout` sul ping di readiness; `databaseUrl` annidato a più livelli non redatto.
- Master key: rotazione (M7) dovrà cambiare di proposito la regola "qualsiasi riga attiva di un'altra chiave → rifiuto"; tabella con sole righe ritirate trattata come vuota; gap minori di rigore del base64 (nessun impatto di sicurezza).
- Release: CLI `release-names:check` con errori non gestiti (stack trace); test del registro poco stringenti.
- Web: flash del tema chiaro al caricamento; modalità "sistema" non testata; chiavi `theme.*` non usate.
- Plugin: `versions.json` statico (serve uno script in release); estensioni di import miste; test di build con output nascosto.
- Docker: password DB in env (in futuro `*_FILE`); file dell'app scrivibili dall'utente runtime; `cloudflared` non pinnato e `--token-file` non provato; `self-hosting.md` §3 cita `node:24-alpine` (ora `node:24-alpine3.24`).
- pnpm segnala "ignored build scripts" (esbuild): valutare `onlyBuiltDependencies`.

## In sospeso lato committente

- Descrizione e topic del repo GitHub (testo proposto in chat; `gh` non autenticato su questo PC).
- Spike su iPhone/Android reali (task 12).
- Installare le skill **UI/UX Pro Max** e **impeccable** prima della Fase UI.

## Note sull'ambiente

- Macchina di sviluppo lenta: eslint impiega 10–20 s ad avviarsi, le build Docker diversi minuti.
- Docker: Rancher Desktop (WSL). Va avviato prima dei test.
- Storia del branch riscritta il 2026-11-06 per correggere l'email dell'autore (force push): eventuali checkout precedenti di `m0-fondamenta` vanno riallineati con `git fetch && git reset --hard origin/m0-fondamenta`.
