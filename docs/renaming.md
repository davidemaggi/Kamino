# Rinomina del prodotto

Il nome del prodotto, lo slug, l'id del plugin, il prefisso delle variabili d'ambiente e lo scope dei pacchetti vengono da un'unica fonte: `packages/brand` (`src/index.ts`). Il codice applicativo importa da `@kamino/brand` e non scrive mai a mano queste stringhe.

## Punti che non leggono `brand`

Questi punti contengono il nome in chiaro e vanno aggiornati a mano:

- **Nomi dei pacchetti npm** `@kamino/*`: campo `name` di ogni `package.json`, dipendenze `workspace:*` e import nei sorgenti.
- **Immagine Docker** `kamino`: `Dockerfile`, `docker-compose*.yml`, riferimenti nella documentazione.
- **`manifest.json` del plugin**: è generato in fase di build; `id` e `name` provengono da `brand` tramite lo script di build, ma il file committato come modello (se presente) va controllato.
- **Workflow CI** (`.github/workflows/*`): nome dell'immagine, nome degli artefatti, filtri `pnpm --filter @kamino/...`.
- **Documentazione** in `docs/` e `README.md`: testi descrittivi scritti a mano.

## Procedura

1. Modificare le costanti in `packages/brand/src/index.ts` (`PRODUCT_NAME`, `PRODUCT_SLUG`, `PLUGIN_ID`, `ENV_PREFIX`, `PACKAGE_SCOPE`). `PLUGIN_ID` non deve contenere la parola "obsidian".
2. Rinominare i pacchetti npm: sostituire `@kamino/` con il nuovo scope in tutti i `package.json`, nei `tsconfig` (`extends`) e negli import; rieseguire `pnpm install`.
3. Aggiornare il nome dell'immagine Docker nei file Docker e compose.
4. Aggiornare i workflow CI.
5. Rigenerare il `manifest.json` del plugin con la build e verificare `id` e `name`.
6. Migrare le variabili d'ambiente esistenti nei file `.env` e nei compose al nuovo prefisso (le varianti `<NOME>_FILE` seguono lo stesso prefisso).
7. Cercare residui: `grep -ri kamino` (e `KAMINO_`) fuori da `docs/` e dai punti elencati sopra; eseguire `pnpm build && pnpm test && pnpm typecheck && pnpm lint`.
