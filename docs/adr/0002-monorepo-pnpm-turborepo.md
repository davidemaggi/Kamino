# ADR-0002 — Monorepo pnpm + Turborepo

**Stato:** Accettata (2026-11-06)

## Contesto
Server, web app e plugin condividono tipi, schemi del protocollo e logica di sync. Devono evolvere insieme e avere un'unica versione di prodotto (ADR-0011).

## Decisione
Monorepo con pnpm workspaces e Turborepo. Pacchetti: `apps/server`, `apps/web`, `apps/plugin`, `packages/protocol`, `packages/sync-core`, `packages/ui-diff`, `packages/i18n`, `packages/brand`, più configurazioni condivise (tsconfig, eslint).

## Alternative
- **Repo separati**: sincronizzare i tipi tra repo è fragile e le modifiche al protocollo richiederebbero più PR coordinate.
- **Nx**: più potente ma più invasivo; Turborepo basta per caching e orchestrazione dei task.

## Conseguenze
- Una modifica al protocollo è una sola PR con server, plugin e test.
- Il plugin va comunque pubblicato in un formato che lo store di Obsidian accetta (release GitHub con `main.js`, `manifest.json`, `styles.css`): servirà un repo/release dedicata o la configurazione corretta delle release del monorepo — da verificare in M0.
