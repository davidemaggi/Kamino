# Self-hosting

> Stato: completo per la prima release (M7c). Gli esempi usano `docker/compose.lan.yml`: con un altro scenario sostituisci il file (`compose.tunnel.yml`, `compose.caddy.yml`) in tutti i comandi.

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

**Dati dei vault.** I contenuti dei file sono salvati cifrati (una chiave per vault, derivata dalla master key) e non compaiono mai in chiaro su disco. Dove vanno:

- `KAMINO_STORAGE=fs` (default): nella cartella `KAMINO_STORAGE_DIR` (default `/data/blobs`). I compose montano il volume `kamino-data` su `/data`: **fa parte del backup**, insieme al database e alla master key.
- `KAMINO_STORAGE=s3`: in un bucket S3 compatibile (MinIO, Garage, SeaweedFS, AWS, Backblaze…). Variabili: `KAMINO_S3_BUCKET` (obbligatoria), `KAMINO_S3_ENDPOINT` (vuota = AWS), `KAMINO_S3_REGION` (default `us-east-1`), `KAMINO_S3_ACCESS_KEY_ID`, `KAMINO_S3_SECRET_ACCESS_KEY` (o `KAMINO_S3_SECRET_ACCESS_KEY_FILE`), `KAMINO_S3_FORCE_PATH_STYLE` (`true` per MinIO e simili). I nomi degli oggetti sono `idVault/idBlob`, senza nomi di file.
- I pezzi degli upload in corso stanno sempre su disco locale in `KAMINO_STAGING_DIR` (default `/data/staging`), già cifrati; gli upload abbandonati da più di 24 ore vengono ripuliti da soli.
- `KAMINO_MAX_FILE_BYTES` limita la dimensione di un singolo file (default 500 MB); i file più grandi vengono rifiutati con `file_too_large` e il plugin li segnala.

**Tempo reale e job.**
- I dispositivi ricevono le modifiche su un WebSocket (`/api/v1/ws`). Un proxy davanti al server deve inoltrare l'upgrade WebSocket. Caddy, Cloudflare Tunnel e `tailscale serve` lo fanno da soli; con nginx servono `proxy_http_version 1.1` e le intestazioni `Upgrade`/`Connection`.
- La compattazione del journal (ogni notte), la pulizia degli upload e dei vault eliminati (ogni ora), l'invio delle email (ogni minuto), gli export e le cancellazioni definitive degli utenti sono job in background salvati in Postgres (schema `pgboss`, creato da solo): non serve nessun servizio in più.
- Più istanze del server sullo stesso database funzionano: le notifiche passano da Postgres (`LISTEN`/`NOTIFY`).

**Impostazioni di sistema.** Si cambiano dalla web app (Amministrazione → Sistema) oppure con le variabili qui sotto. Una variabile impostata **vince sempre** e nella web app il campo appare bloccato ("Impostato dall'ambiente"); una variabile vuota vale come non impostata.

- `KAMINO_REGISTRATION`: `closed` (default, gli utenti li crea l'amministratore) o `open`.
- `KAMINO_DEFAULT_QUOTA_BYTES`: spazio massimo per utente, in byte; `none` = illimitato (default). La quota di un singolo utente si cambia dalla sua scheda. Conta la dimensione dei contenuti nei vault attivi; un contenuto presente in due vault conta due volte. Abbassare una quota sotto lo spazio già usato non cancella niente: vengono rifiutati solo i nuovi contenuti (`quota_exceeded`).
- `KAMINO_MAX_RETENTION_DAYS`: storico massimo dei vault, in giorni (0–90).
- Email (inviti, link di reset, avvisi, export di un account eliminato): `KAMINO_SMTP_HOST`, `KAMINO_SMTP_PORT`, `KAMINO_SMTP_SECURITY` (`none`, `starttls`, `tls`), `KAMINO_SMTP_USERNAME`, `KAMINO_SMTP_PASSWORD` (o `KAMINO_SMTP_PASSWORD_FILE`), `KAMINO_SMTP_FROM`, `KAMINO_SMTP_ALLOW_INVALID_CERTS` (`true` solo per server di posta interni con certificato autofirmato). Senza SMTP tutto funziona lo stesso: i link di invito e di reset si copiano dalla web app o dalla CLI. Il pulsante "Invia email di prova" verifica la configurazione. Le email in uscita restano in coda nel database e vengono ritentate se il server di posta non risponde.

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
- L'entrypoint senza argomenti avvia il server; con argomenti esegue la CLI (`keys generate`, `keys verify`, `keys rotate`, `migrate`, `users …`, `backup create|verify|restore`).

## 4. Primo avvio e utenti

- Al primo avvio, senza utenti, il server scrive **una volta** nei log il link di configurazione: `docker compose -f docker/compose.lan.yml logs kamino` e cerca `finish the setup at …/setup?token=…`. Aprilo: il codice è già compilato. Il primo utente è amministratore e deve attivare la verifica in due passaggi.
- Gli utenti si creano dalla web app (Amministrazione → Utenti): con SMTP configurato l'invito parte per email, altrimenti la web app mostra il link da consegnare. Lì si bloccano, si sbloccano, si genera un link di reset e si eliminano. L'eliminazione chiede di riscrivere il nome utente: l'account smette subito di funzionare e, se si sceglie di inviare l'export, l'utente riceve per email un link a un archivio ZIP di tutti i suoi vault, valido 7 giorni; poi (o subito, senza export) le chiavi dei vault vengono distrutte e i dati non sono più recuperabili. L'amministratore non vede mai nomi di vault né di file degli utenti.
- In alternativa, o senza web app, i link si creano dalla CLI:
  - `docker compose -f docker/compose.lan.yml run --rm -T kamino users invite <username> <email>` crea l'utente e stampa il link di attivazione (7 giorni);
  - `… users reset-link <username>` stampa un link per reimpostare la password (1 ora; l'utente vede l'avviso);
  - `… users reset-2fa <username>` toglie la verifica in due passaggi a chi ha perso il telefono e i codici di recupero (resta nel registro).
- Le migrazioni del database partono solo dopo la verifica della master key: con una chiave sbagliata il server si ferma senza toccare lo schema.
- Dimensione dell'immagine: **210 MB** (`docker image ls`, base Alpine 3.24 + binario `node` ridotto con `strip`) (obiettivo < 250 MB).

## 5. Backup e ripristino

Un backup è un unico file ZIP con il database (tutte le tabelle, in un'unica transazione coerente) e i blob cifrati. **Non contiene la master key**: senza la chiave il backup non è leggibile, quindi conserva la chiave a parte (§2). Il file è creato con permessi `600`.

Creare un backup a server acceso, in una cartella dell'host montata nel container (deve essere scrivibile dall'uid 1000):

```sh
mkdir -p backups && sudo chown 1000:1000 backups   # su Docker Desktop basta mkdir
docker compose -f docker/compose.lan.yml run --rm -T -v "$PWD/backups:/backups" kamino backup create /backups/kamino-$(date +%F).zip
```

Verificarlo (consigliato dopo ogni backup, o almeno ogni settimana): il comando ripristina il backup in un database temporaneo sullo stesso Postgres, controlla che la master key apra ogni chiave dei vault e che un campione di 20 blob si decifri con il contenuto atteso, poi cancella il database temporaneo. Serve un utente Postgres che possa creare database (quello dei compose lo può).

```sh
docker compose -f docker/compose.lan.yml run --rm -T -v "$PWD/backups:/backups" kamino backup verify /backups/kamino-2026-11-13.zip
```

Conservazione consigliata: un backup al giorno, tenuti **30 giorni**, con almeno una copia fuori dal server. Un backup fatto prima di una rotazione della master key (§6) si apre solo con la **vecchia** chiave: tienila insieme a quei backup finché non scadono.

Ripristinare su un'installazione nuova (database e volume vuoti; il ripristino si rifiuta di scrivere sopra dati esistenti). Serve la stessa master key del backup in `docker/secrets/kamino_master_key`:

```sh
docker compose -f docker/compose.lan.yml up -d postgres           # solo il database, il server non deve essere partito
docker compose -f docker/compose.lan.yml run --rm -T -v "$PWD/backups:/backups" kamino backup restore /backups/kamino-2026-11-13.zip
docker compose -f docker/compose.lan.yml up -d                     # avvia il server sui dati ripristinati
```

Il ripristino applica le migrazioni, controlla che il backup venga dalla stessa versione dello schema, scrive i blob e poi tutte le tabelle in una transazione, e confronta il numero di righe. Le modifiche arrivate al server dopo il backup non sono nel backup; restano però nelle vault locali dei dispositivi. Il comportamento dei dispositivi già collegati dopo un ripristino è tra le prove da fare prima della 1.0: fino ad allora, in caso di dubbio, controlla la vault di un dispositivo prima di ricollegarlo.

## 6. Rotazione della master key

Da fare se la chiave potrebbe essere stata esposta, o periodicamente. Il server resta acceso; i contenuti non vengono ricifrati, solo le chiavi dei vault e i segreti di sistema (TOTP, password SMTP, email in coda).

1. Fai un backup (§5) e conservalo con la chiave attuale.
2. Sposta la chiave attuale in `docker/secrets/kamino_master_key_previous` e generane una nuova in `docker/secrets/kamino_master_key` (§2), con gli stessi permessi.
3. Riavvia con entrambe le chiavi; nei log compare un avviso di rotazione in corso. Da qui i dati nuovi usano già la nuova chiave:
   ```sh
   docker compose -f docker/compose.lan.yml -f docker/compose.rotate.yml up -d
   ```
4. Esegui la rotazione (si può ripetere e interrompere senza danni):
   ```sh
   docker compose -f docker/compose.lan.yml -f docker/compose.rotate.yml run --rm -T kamino keys rotate
   ```
   Il comando stampa quante chiavi e segreti ha spostato. Se segnala **export di account eliminati** ancora scaricabili, quelli restano cifrati con la vecchia chiave: lascia la configurazione con entrambe le chiavi fino alla data indicata.
5. Quando il comando dice `rotation complete`, riavvia senza la vecchia chiave (`docker compose -f docker/compose.lan.yml up -d`) e controlla con `keys verify`. Togli `kamino_master_key_previous` dal server, ma conserva la vecchia chiave fuori dal server finché esistono backup fatti prima della rotazione.

La rotazione è registrata nel registro di amministrazione (senza alcun valore delle chiavi).

## 7. Aggiornamenti

1. Fai un backup (§5) e verificalo.
2. Aggiorna il codice e ricostruisci l'immagine:
   ```sh
   git pull
   docker compose -f docker/compose.lan.yml up -d --build
   ```
3. All'avvio il server verifica la master key e poi applica da solo le migrazioni del database. Controlla `curl -fsS <KAMINO_PUBLIC_URL>/health/ready` e `/version`.

Le migrazioni aggiungono soltanto (nessuna colonna o tabella viene tolta in una release minore), ma il ritorno a una versione precedente non è supportato: per tornare indietro si ripristina il backup del punto 1 su un'installazione vuota.

Plugin e server possono avere versioni diverse: la compatibilità dipende solo dalla versione del protocollo. Se un dispositivo ha un plugin troppo vecchio (o troppo nuovo) per il server, smette di sincronizzare e lo dice chiaramente ("aggiorna il plugin o il server"); nessun dato viene perso, le modifiche locali restano in coda.

## 8. Installare il plugin (BRAT)

Finché il plugin non è nello store di Obsidian si installa con [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. In Obsidian: Impostazioni → Plugin della community → Sfoglia → installa e attiva **BRAT**.
2. Comando "BRAT: Add a beta plugin for testing", indirizzo del repository GitHub del progetto; BRAT scarica `main.js`, `manifest.json` e `styles.css` dall'ultima release e li aggiorna da solo.
3. Attiva il plugin, apri le sue impostazioni e collega il dispositivo (indirizzo del server, poi accesso o codice di abbinamento da un dispositivo già collegato).

Su telefono e tablet il server deve essere raggiungibile in HTTPS (scenari tunnel o Caddy).

Le release si pubblicano a mano dal workflow **Release plugin** (GitHub Actions, solo da `main`), dopo `pnpm release:version` (changesets aggiorna versioni e changelog, `versions.json` riceve la nuova voce). Le versioni 0.x sono marcate come pre-release.

## 9. Lista di controllo

- [ ] master key generata, copia fuori dal server (§2);
- [ ] `KAMINO_PUBLIC_URL` corretto per lo scenario, HTTPS se ci sono dispositivi mobili;
- [ ] primo utente creato con verifica in due passaggi (§4);
- [ ] SMTP configurato e email di prova inviata (facoltativo);
- [ ] backup giornaliero pianificato (cron o timer di sistema) e verificato almeno una volta (§5);
- [ ] copia dei backup fuori dal server, conservati 30 giorni;
- [ ] procedura di ripristino provata almeno una volta su un'installazione di prova.
