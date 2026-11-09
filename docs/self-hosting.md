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

3. Generare la master key (vedi sotto; **su Windows PowerShell 5.1 usare la forma con `Out-File -Encoding ascii`**) in `docker/secrets/kamino_master_key`.

4. Avviare lo scenario scelto, ad esempio:

   ```sh
   docker compose -f docker/compose.lan.yml up -d --build
   curl -fsS http://localhost:8080/health/ready
   ```

**Password del database.** `KAMINO_DB_PASSWORD` non ha un valore di default: lasciarla vuota fa fallire `docker compose` con un errore esplicito. Postgres la imposta solo alla prima inizializzazione del volume `postgres-data`: **cambiarla in `docker/.env` dopo il primo avvio non cambia la password del database** e il server non riesce più ad autenticarsi. Per cambiarla correttamente, prima aggiornare la password in Postgres (`docker compose -f docker/compose.lan.yml exec postgres psql -U kamino -c "ALTER USER kamino PASSWORD 'nuova'"`) e poi il valore in `docker/.env`, quindi riavviare; solo per un'installazione senza dati da conservare si può invece eliminare il volume (`docker compose ... down -v`).

Nello scenario LAN `KAMINO_PUBLIC_URL` deve essere l'indirizzo IP o il nome host del server visibile agli altri computer della rete (ad esempio `http://192.168.1.10:8080`); il default `http://localhost:8080` va bene solo per provare il server sulla stessa macchina. Nello scenario Caddy impostare anche `KAMINO_DOMAIN` in `docker/.env`. Nello scenario tunnel impostare `KAMINO_PUBLIC_URL` con l'URL HTTPS pubblico; per Cloudflare salvare il token del tunnel in `docker/secrets/cloudflared_token` e aggiungere `--profile cloudflare`. I dettagli per Tailscale (`tailscale serve --bg 8080`) e Cloudflare sono nei commenti di `compose.tunnel.yml`.

`KAMINO_TRUST_PROXY` dice al server di quali proxy fidarsi per l'indirizzo del client (`X-Forwarded-For`): un numero di salti (es. `1`) o un elenco di IP/CIDR. Nei compose Caddy e tunnel vale `1`, perché il server è raggiungibile solo dal proxy; nello scenario LAN non va impostato. Se il server è esposto direttamente e la variabile è impostata, un client potrebbe falsificare il proprio indirizzo ed eludere i limiti sui tentativi di accesso.

## 2. La master key

La master key è una chiave di 32 byte codificata in base64. Protegge le chiavi di cifratura dei dati: **se la perdi, i dati nel database non sono più leggibili**; se la cambi, il server rifiuta di partire con l'errore `master key does not match this database`.

Generarla (il valore va solo su stdout, nel file; non viene registrato nei log):

```sh
mkdir -p docker/secrets
docker run --rm kamino:local keys generate > docker/secrets/kamino_master_key
```

Windows PowerShell 5.1 (il default di Windows 10/11): l'operatore `>` scrive in UTF-16 con BOM. Il server lo decodifica, ma per sicurezza (e per altri strumenti) è preferibile forzare ASCII:

```powershell
New-Item -ItemType Directory -Force docker/secrets | Out-Null
docker run --rm kamino:local keys generate | Out-File -Encoding ascii docker/secrets/kamino_master_key
```

PowerShell 7 e Git Bash scrivono UTF-8 e non hanno questo problema.

Alternativa con compose, a immagine già costruita; serve solo che la cartella `docker/secrets/` esista (`mkdir -p docker/secrets`), il file viene creato dal redirect:

```sh
docker compose -f docker/compose.lan.yml run --rm -T --no-deps kamino keys generate > docker/secrets/kamino_master_key
```

Custodia:

- conservare una copia **fuori dal server** (password manager, cassaforte), separata dai backup del database;
- `docker/secrets/` è ignorata da git; non committare mai la chiave né `docker/.env`;
- se la chiave non corrisponde al database, il container esce con codice 1 e, per via di `restart: unless-stopped`, `docker compose ps` lo mostra come `Restarting (1)`. Diagnosi: `docker compose -f docker/compose.lan.yml logs kamino` e cercare `master key does not match this database`; ripristinare la chiave originale in `docker/secrets/kamino_master_key`;
- un newline finale nel file è accettato, così come un BOM UTF-8 o UTF-16 (file creati da PowerShell);
- **permessi del file**: il container gira come utente `node` (uid 1000) e il file è montato con i permessi dell'host, quindi deve essere leggibile da quell'uid. Su Linux, ad esempio: `sudo chown 1000:1000 docker/secrets/kamino_master_key && chmod 600 docker/secrets/kamino_master_key`; su un host fidato basta anche `chmod 644`. Un file `600` di proprietà di root produce l'errore `KAMINO_MASTER_KEY_FILE points to a file that cannot be read`. Su Docker Desktop (Windows/macOS) non serve nulla;
- per verificare che la chiave corrisponda a un database esistente: `docker compose -f docker/compose.lan.yml run --rm --no-deps kamino keys verify` (con le variabili del compose).

## 3. Immagine

- Multi-stage (build su `node:24-alpine`, runtime su `alpine:3.24` con il binario `node` ufficiale ridotto con `strip`); utente non root (`node`), nessun segreto nei layer (la master key è un Docker secret; la password del database arriva da `docker/.env` a runtime).
- `HEALTHCHECK` su `/health/live` (con `node`, senza curl).
- Il commit mostrato da `/version` si imposta con `--build-arg KAMINO_BUILD_COMMIT=<sha>` (nei compose: variabile `KAMINO_BUILD_COMMIT`); senza, vale `unknown`.
- L'entrypoint senza argomenti avvia il server; con argomenti esegue la CLI (`keys generate`, `keys verify`, `migrate`, `users …`).

## 4. Primo avvio e utenti

- Al primo avvio, senza utenti, il server scrive **una volta** nei log il link di configurazione: `docker compose -f docker/compose.lan.yml logs kamino` e cerca `finish the setup at …/setup?token=…`. Aprilo: il codice è già compilato. Il primo utente è amministratore e deve attivare la verifica in due passaggi.
- Finché non c'è l'invio di email (arriva più avanti), i link si creano dalla CLI:
  - `docker compose -f docker/compose.lan.yml run --rm -T kamino users invite <username> <email>` crea l'utente e stampa il link di attivazione (7 giorni);
  - `… users reset-link <username>` stampa un link per reimpostare la password (1 ora; l'utente vede l'avviso);
  - `… users reset-2fa <username>` toglie la verifica in due passaggi a chi ha perso il telefono e i codici di recupero (resta nel registro).
- Le migrazioni del database partono solo dopo la verifica della master key: con una chiave sbagliata il server si ferma senza toccare lo schema.
- Dimensione dell'immagine: **210 MB** (`docker image ls`, base Alpine 3.24 + binario `node` ridotto con `strip`) (obiettivo < 250 MB).
