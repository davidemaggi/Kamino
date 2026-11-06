# Self-hosting (bozza)

> Stato: bozza (M0). L'elenco completo delle variabili `KAMINO_*` sarà generato dallo schema di configurazione.

Kamino è un'unica immagine (`kamino`) più PostgreSQL. Ci sono tre scenari di riferimento, ciascuno con il suo compose in `docker/` (vedi [architettura §1 e §8](02-architecture.md)).

| Scenario | File | TLS | Note |
|---|---|---|---|
| Casa / LAN | `docker/compose.lan.yml` | nessuno (HTTP) | il più semplice; **solo desktop** (il mobile richiede HTTPS) |
| Tailscale / Cloudflare Tunnel | `docker/compose.tunnel.yml` | fornito dal servizio | nessuna porta aperta; Cloudflare vede il traffico in chiaro (profilo `cloudflare`) |
| Dominio pubblico | `docker/compose.caddy.yml` + `docker/Caddyfile.example` | Caddy + Let's Encrypt | certificato automatico; porte 80/443 aperte |

## 1. Preparazione

Tutti i comandi si eseguono dalla radice del repository.

1. Costruire l'immagine (serve anche a generare la master key):

   ```sh
   docker build -f docker/Dockerfile -t kamino:local .
   ```

2. Creare `docker/.env` partendo dall'esempio e impostare almeno `KAMINO_DB_PASSWORD` (solo caratteri URL-safe: lettere, cifre, `- _ . ~`):

   ```sh
   cp docker/.env.example docker/.env
   ```

3. Generare la master key (vedi sotto) in `docker/secrets/kamino_master_key`.

4. Avviare lo scenario scelto, ad esempio:

   ```sh
   docker compose -f docker/compose.lan.yml up -d --build
   curl -fsS http://localhost:8080/health/ready
   ```

Nello scenario Caddy impostare anche `KAMINO_DOMAIN` in `docker/.env`. Nello scenario tunnel impostare `KAMINO_PUBLIC_URL` con l'URL HTTPS pubblico; per Cloudflare salvare il token del tunnel in `docker/secrets/cloudflared_token` e aggiungere `--profile cloudflare`. I dettagli per Tailscale (`tailscale serve --bg 8080`) e Cloudflare sono nei commenti di `compose.tunnel.yml`.

## 2. La master key

La master key è una chiave di 32 byte codificata in base64. Protegge le chiavi di cifratura dei dati: **se la perdi, i dati nel database non sono più leggibili**; se la cambi, il server rifiuta di partire con l'errore `master key does not match this database`.

Generarla (il valore va solo su stdout, nel file; non viene registrato nei log):

```sh
mkdir -p docker/secrets
docker run --rm kamino:local keys generate > docker/secrets/kamino_master_key
```

Alternativa con compose, a immagine già costruita e con il file `kamino_master_key` già presente (anche vuoto, compose lo richiede per montare il secret):

```sh
docker compose -f docker/compose.lan.yml run --rm -T --no-deps kamino keys generate > docker/secrets/kamino_master_key
```

Custodia:

- conservare una copia **fuori dal server** (password manager, cassaforte), separata dai backup del database;
- `docker/secrets/` è ignorata da git; non committare mai la chiave né `docker/.env`;
- un newline finale nel file è accettato;
- per verificare che la chiave corrisponda a un database esistente: `docker compose -f docker/compose.lan.yml run --rm --no-deps kamino keys verify` (con le variabili del compose).

## 3. Immagine

- Multi-stage (build su `node:24-alpine`, runtime su `alpine:3.24` con il binario `node` ufficiale ridotto con `strip`); utente non root (`node`), nessun segreto nei layer (la master key è un Docker secret; la password del database arriva da `docker/.env` a runtime).
- `HEALTHCHECK` su `/health/live` (con `node`, senza curl).
- Il commit mostrato da `/version` si imposta con `--build-arg KAMINO_BUILD_COMMIT=<sha>` (nei compose: variabile `KAMINO_BUILD_COMMIT`); senza, vale `unknown`.
- L'entrypoint senza argomenti avvia il server; con argomenti esegue la CLI (`keys generate`, `keys verify`, `migrate`).
- Dimensione dell'immagine: **210 MB** (`docker image ls`, base Alpine 3.24 + binario `node` ridotto con `strip`) (obiettivo < 250 MB).
