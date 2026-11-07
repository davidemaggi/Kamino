# CLAUDE.md — Kamino

Sistema self-hosted per sincronizzare vault Obsidian: plugin (desktop + mobile), server containerizzato, web app. "Kamino" è un **nome in codice**: il nome pubblico può cambiare.

## Prima di toccare qualcosa

- **Leggi [`docs/HANDOVER.md`](docs/HANDOVER.md)**: stato corrente, prossimo passo, decisioni prese. Tienilo **sempre aggiornato, committato e pushato** dopo ogni task completato o decisione rilevante.
- Commit sempre come `Davide Maggi <davide.maggi@live.com>` (imposta `git config user.email` locale al repo).
- Leggi i documenti pertinenti in `docs/`: visione (`00`), requisiti (`01`), architettura (`02`), protocollo di sync (`03`), threat model (`04`), modello dati (`05`), roadmap (`06`), [ADR](docs/adr/).
- Le **ADR accettate non si modificano**: se una decisione va cambiata, proponi una nuova ADR che la sostituisce.
- Lavora a piani: ogni milestone ha un piano in `docs/superpowers/plans/`. Esegui un task alla volta, con TDD.
- La promessa del prodotto è **"non perdi mai niente, e sai sempre se sei al sicuro"**. Nel dubbio, conserva entrambe le versioni e rendi visibile lo stato.

## Struttura

```
apps/server     Fastify + Drizzle; moduli in src/<modulo>/ (oggi: cli, config, crypto, db, observability, routes); pg-boss dai milestone di sync
apps/web        React + Vite + Tailwind + react-i18next; shadcn/ui e TanStack Query arrivano con le prime schermate
apps/plugin     plugin Obsidian (esbuild)
packages/brand      nome prodotto, PLUGIN_ID, prefissi — UNICA fonte
packages/protocol   schemi zod, PROTOCOL_VERSION, catalogo errori
packages/tsconfig   preset tsconfig condivisi
packages/sync-core  (da M1) logica di sync pura, senza I/O (property-based testing)
packages/ui-diff    (milestone successive) diff/merge su @codemirror/merge (web + plugin)
packages/i18n       (milestone successive) stringhe condivise
docker/         Dockerfile e compose (lan, tunnel, caddy)
docs/           documentazione di progetto (in italiano); HANDOVER.md = stato corrente
release-names.json  registro dei nomi in codice delle release
```

## Comandi

> Verificati il 2026-11-07 (task 11 di M0). Richiede Node ≥ 22.12 e pnpm 10 (`packageManager`).

```bash
pnpm install
pnpm build          # turbo run build
pnpm typecheck
pnpm lint
pnpm test           # Vitest; i test di integrazione usano Postgres via testcontainers (serve Docker)
pnpm format         # prettier --write .; pnpm format:check = solo verifica (usato in CI)
pnpm release-names:check
pnpm --filter @kamino/server dev        # serve KAMINO_PUBLIC_URL, KAMINO_DATABASE_URL, KAMINO_MASTER_KEY (o *_FILE); Postgres raggiungibile
pnpm --filter @kamino/web dev           # Vite su http://localhost:5173
pnpm --filter @kamino/plugin build      # output in apps/plugin/dist (main.js, manifest.json, styles.css)
pnpm changeset                          # interattivo; una per ogni modifica rilasciabile
# prima: docker/.env e docker/secrets/kamino_master_key (vedi Quick start nel README e docs/self-hosting.md)
docker compose -f docker/compose.lan.yml up -d --build
```

## Convenzioni

- **TypeScript strict** ovunque (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- **Lingue:** codice, identificatori, commenti, commit in inglese; documentazione in `docs/` in italiano; UI in it/en tramite i18n, mai stringhe scritte a mano nei componenti.
- **Naming del prodotto:** usa sempre `@kamino/brand` (`PRODUCT_NAME`, `PLUGIN_ID`, `envName()`). I punti che non possono farlo sono in `docs/renaming.md`.
- **Lessico a tema** (clone = dispositivo, Jango = dispositivo originale, Ordine 66 = errore/conflitto grave, Kaminoani = admin, archivi Jedi = storico): ammesso in codice, log, commenti ed easter egg; **vietato nei testi UI**. Vedi `docs/glossary.md`.
- **Commit:** Conventional Commits, piccoli e frequenti. Ogni modifica rilasciabile ha un changeset.
- **Versioni:** versione di prodotto unica (changesets `fixed`). La compatibilità plugin↔server si decide **solo** con `PROTOCOL_VERSION`, mai con la versione di prodotto.
- **Config:** variabili `KAMINO_*`, ogni segreto anche come `*_FILE`. Precedenza: ambiente → valore da UI → default. Stringa vuota = non impostata.
- **Server:** le rotte sono adattatori sottili sui servizi dei moduli. Le rotte di contenuto controllano la proprietà; **nessun bypass per l'admin**. Il modulo `admin` non importa servizi che decifrano.
- **Sicurezza:** mai loggare path, nomi di file, contenuti, token, password, master key. Path e nomi nel DB sono sempre cifrati.
- **Plugin:** niente API Node/Electron (`isDesktopOnly: false`); solo API di Obsidian, `requestUrl`, WebSocket, WebCrypto, `@noble/hashes`. Stato locale nella cartella del plugin, scritture atomiche. Su mobile, HTTPS obbligatorio.
- **Sync:** ogni operazione è idempotente (`opId`), dichiara la sua base, e il client considera "al sicuro" solo ciò che il server ha confermato.
- **Test:** TDD. Vitest per unità e integrazione, fast-check per `sync-core`, Playwright per la web app, test multi-client per il protocollo. Un bug corretto porta con sé il test che lo riproduce.
