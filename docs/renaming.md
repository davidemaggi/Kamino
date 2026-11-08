# Rinomina del prodotto

Il nome del prodotto, lo slug, l'id del plugin, il prefisso delle variabili d'ambiente e lo scope dei pacchetti vengono da un'unica fonte: `packages/brand` (`src/index.ts`). Il codice applicativo importa da `@kamino/brand` e non scrive mai a mano queste stringhe.

## Punti che non leggono `brand`

Questi punti contengono il nome in chiaro e vanno aggiornati a mano:

- **Nomi dei pacchetti npm** `@kamino/*`: campo `name` di ogni `package.json`, dipendenze `workspace:*` e import nei sorgenti.
- **Immagine Docker** `kamino`: `docker/Dockerfile`, `docker/compose.lan.yml`, `docker/compose.tunnel.yml`, `docker/compose.caddy.yml`, riferimenti nella documentazione.
- **`manifest.json` del plugin**: è generato in fase di build; `id` e `name` provengono da `brand` tramite lo script di build, ma il file committato come modello (se presente) va controllato.
- **`turbo.json`**: l'elenco `env` (`KAMINO_BUILD_COMMIT`) non può importare `brand`; va aggiornato col prefisso delle variabili.
- **Altri file di `docker/` con il prefisso `KAMINO_`/il nome**: `docker/entrypoint.sh`, `docker/.env.example`, `docker/Caddyfile.example`, e l'`HEALTHCHECK` del `Dockerfile` (`KAMINO_PORT`); nei compose anche variabili (`KAMINO_DB_PASSWORD`, `KAMINO_DOMAIN`...), nomi di segreti e utente/database Postgres.
- **`turbo.json`**: anche `globalDependencies` non dipende dal nome, ma l'`env` sì (già elencato sopra).
- **Workflow CI** (`.github/workflows/*`): nome dell'immagine, nome degli artefatti, filtri `pnpm --filter @kamino/...`.
- **Comando CLI** `kamino`: campo `bin` di `apps/server/package.json`.
- **CSS del plugin** (`apps/plugin/src/styles.css`): il prefisso delle classi `.kamino-status*` è `PRODUCT_SLUG`; il test `apps/plugin/test/styles.test.ts` fallisce finché non è allineato.
- **Script `build:vault` del plugin** (`apps/plugin/scripts/install-vault.ts`): il percorso predefinito della vault di prova è `vault/kamino/`.
- **Documentazione** in `docs/` e `README.md`: testi descrittivi scritti a mano.

## Costanti crittografiche: non rinominare

Le stringhe `kamino-kek-id` e `kamino-key-check` (`apps/server/src/crypto/keyring.ts`) sono costanti fisse di separazione di dominio: determinano l'id della chiave e il valore di controllo salvato nel database. **Non vanno rinominate** né derivate da `brand`: cambiarle renderebbe irriconoscibile la master key dei database esistenti e il server non partirebbe.

## Procedura

1. Modificare le costanti in `packages/brand/src/index.ts` (`PRODUCT_NAME`, `PRODUCT_SLUG`, `PLUGIN_ID`, `ENV_PREFIX`, `PACKAGE_SCOPE`). `PLUGIN_ID` non deve contenere la parola "obsidian".
2. Rinominare i pacchetti npm: sostituire `@kamino/` con il nuovo scope in tutti i `package.json`, nei `tsconfig` (`extends`) e negli import; rieseguire `pnpm install`.
3. Aggiornare il nome dell'immagine Docker nei file Docker e compose.
4. Aggiornare i workflow CI.
5. Rigenerare il `manifest.json` del plugin con la build e verificare `id` e `name`.
6. Migrare le variabili d'ambiente esistenti nei file `.env` e nei compose al nuovo prefisso (le varianti `<NOME>_FILE` seguono lo stesso prefisso).
7. Cercare residui: `grep -ri kamino` (e `KAMINO_`) fuori da `docs/` e dai punti elencati sopra; eseguire `pnpm build && pnpm test && pnpm typecheck && pnpm lint`.
