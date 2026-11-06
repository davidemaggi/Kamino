# 04 — Sicurezza e threat model

> Stato: **approvato** (2026-11-06). Diagramma: [gerarchia delle chiavi](diagrams/03-key-hierarchy.drawio).

## 1. Obiettivi di sicurezza

1. Ogni utente accede **solo** ai propri vault e dispositivi.
2. L'admin **non vede** contenuti né struttura dei vault altrui tramite UI o API.
3. Un **dump del database o dello storage, da solo, è inutile**: senza la master key non si leggono né contenuti né path né nomi dei vault.
4. Un dispositivo perso o compromesso si **revoca** in un clic, senza toccare gli altri.
5. Nessun fallimento silenzioso, nemmeno nei controlli di sicurezza (es. chiave sbagliata → il server non parte).

**Non è un obiettivo** (accettato esplicitamente): proteggere i dati da chi gestisce l'host **e** possiede la master key. Kamino non è end-to-end: il server decifra per servire i client, calcolare diff e generare ZIP.

## 2. Asset

| Asset | Dove | Sensibilità |
|---|---|---|
| Contenuti dei file | blob storage (cifrati) | massima |
| Path, nomi di file/cartelle, nomi dei vault, impostazioni di vault | Postgres (cifrati) | massima (rivelano la struttura) |
| Master key (KEK) | Docker secret / env, solo in memoria nel processo | critica |
| Chiavi dati dei vault (DEK) | Postgres, cifrate con la KEK | critica |
| Password, segreti TOTP, codici di recupero | Postgres (hash Argon2id / segreti cifrati con KEK / hash) | alta |
| Token dei dispositivi, sessioni web, token di pairing, inviti, reset | Postgres (solo hash SHA-256) | alta |
| Token del dispositivo sul client | `<configDir>/plugins/<id>/` del vault | alta |
| Password SMTP salvata da UI | Postgres (cifrata con KEK) | media |
| Metadati operativi (dimensioni, numero di file, orari di sync) | Postgres (in chiaro) | bassa — vedi §6 |

## 3. Attori e confini di fiducia

| Attore | Fiducia | Capacità assunte |
|---|---|---|
| Utente | sui propri dati | accesso alla web app e ai propri dispositivi |
| Admin applicativo (Kaminoano) | gestione, **non** contenuti | UI e API admin |
| Gestore dell'host (spesso coincide con l'admin) | totale, accettato | shell sul server, master key |
| Attaccante esterno | nessuna | rete, credential stuffing, link rubati |
| Ladro di backup / dump | nessuna | copia di DB e/o storage **senza** master key |
| Ladro di dispositivo | nessuna | accesso al filesystem di un dispositivo sbloccato |
| Altro plugin Obsidian nello stesso vault | nessuna, ma **non isolabile** | legge tutto ciò che legge Kamino, incluso il token |
| Collega con account sullo stesso server | sui propri dati | utente autenticato che prova ad accedere a dati altrui |

Confini: client ↔ server (TLS), server ↔ Postgres, server ↔ storage, server ↔ SMTP, admin ↔ funzioni utente (confine logico nel codice).

## 4. Minacce e contromisure

| # | Minaccia | Contromisure | Rischio residuo |
|---|---|---|---|
| T-01 | Un utente accede a vault/dispositivi di un altro (IDOR) | Controllo di proprietà centralizzato su ogni rotta di contenuto; ID non sequenziali; 404 per risorse altrui; test di autorizzazione per ogni rotta. | basso |
| T-02 | L'admin legge contenuti tramite UI/API | Nessun bypass per ruolo admin sulle rotte di contenuto; modulo `admin` senza dipendenze da servizi che decifrano (test di architettura); API admin restituiscono solo aggregati; link di export alla cancellazione inviati solo all'email dell'utente e mai mostrati né loggati. | basso |
| T-03 | L'admin prende possesso di un account (reset password, cambio email prima della cancellazione) per leggerne i vault | L'admin non imposta mai password altrui (link di attivazione); ogni reset o cambio email avviato dall'admin è visibile all'utente (avviso al login, registro di sicurezza, email al vecchio indirizzo) e registrato nell'audit log; sessioni e dispositivi non revocati, così l'utente se ne accorge; l'export alla cancellazione usa l'email confermata. | **medio, accettato dal committente**: l'admin può comunque usare un link di reset; chi gestisce l'host ha già la master key |
| T-04 | Furto di dump DB o storage | Envelope encryption: contenuti, path, nomi, impostazioni cifrati; DEK cifrate con la KEK, che non è mai nel DB né nei backup; ID dei blob come HMAC keyed per vault. | basso (vedi §6) |
| T-05 | Perdita della master key | Il server non parte senza chiave; documentazione con procedura di custodia offline e verifica (`kamino keys verify`); ricostruzione del server dai dispositivi (V-05). | **alto e accettato**: senza KEK i dati sul server sono irrecuperabili |
| T-06 | Master key esposta (`docker inspect`, log, crash dump) | Preferire `KAMINO_MASTER_KEY_FILE` (Docker secret) all'env; la chiave non viene mai loggata (redazione); rotazione con `kamino keys rotate`. | medio |
| T-07 | Credential stuffing / brute force | Argon2id; rate limiting per IP e per account; lockout progressivo; TOTP facoltativo (obbligatorio admin); messaggi d'errore non enumerativi. | medio per utenti senza TOTP |
| T-08 | Furto del token di un dispositivo | Token opachi da 256 bit, salvati come hash; revoca immediata; ogni token vale per un solo vault; ultimo IP/contatto visibile all'utente. | medio (un plugin malevolo nello stesso vault può leggerlo — non mitigabile) |
| T-09 | Intercettazione di un QR/magic link | Token monouso, 10 minuti, approvazione obbligatoria dall'origine con codice di verifica; secondo claim → avviso all'origine. | basso |
| T-10 | MITM / sniffing | HTTPS raccomandato (scenari Tailscale, Cloudflare Tunnel, Let's Encrypt); HSTS lato reverse proxy (documentato). In **HTTP (LAN di casa, solo desktop; il plugin mobile rifiuta `http://`)** password, token e contenuti viaggiano in chiaro sulla rete locale: avviso chiaro in plugin e web app, documentazione del rischio. Con **Cloudflare Tunnel** il TLS termina presso Cloudflare, che vede il traffico in chiaro (contenuti inclusi): documentato, e Tailscale indicato come alternativa senza terze parti nel percorso. | basso in HTTPS; **medio, accettato** in HTTP LAN e con Cloudflare |
| T-11 | CSRF / XSS sulla web app | Cookie `HttpOnly`, `Secure`, `SameSite=Lax` + token CSRF sulle mutazioni; CSP restrittiva; React senza `dangerouslySetInnerHTML`; il contenuto delle note è mostrato come testo (CodeMirror), **mai** renderizzato come HTML in v1. | basso |
| T-12 | Path traversal / nomi malevoli | Normalizzazione e validazione dei path in `sync-core` lato server e client; rifiuto di `..`, path assoluti, caratteri di controllo; il client non scrive fuori dal vault né nella cartella del plugin. | basso |
| T-13 | Esaurimento risorse (upload enormi, flood) | Limite per file, quota con riserva preventiva, rate limiting, limiti di dimensione delle richieste, timeout, limite di connessioni WS per utente. | medio |
| T-14 | Corruzione o manomissione dei blob nello storage | AEAD (AES-256-GCM a segmenti) con AAD legata a vault e blob: ogni alterazione viene rilevata in lettura; `backup verify` controlla l'integrità. | basso |
| T-15 | Escalation a admin | Ruolo modificabile solo da un admin, con audit; TOTP obbligatorio per gli admin; il setup iniziale richiede un token stampato nei log di avvio. | basso |
| T-16 | Fuga di dati nei log o nelle metriche | Logger con allowlist dei campi; path, nomi e contenuti mai loggati (solo `fileId`, `vaultId`); metriche solo aggregate; test che verifica l'assenza di path nei log durante i test di integrazione. | basso |
| T-17 | Dati di un utente cancellato ancora leggibili | Crypto-shredding (distruzione della DEK) + purge fisico dei blob. Vedi §7 sui backup. | medio (backup) |
| T-18 | Dispositivo revocato conserva i file | Non mitigabile da remoto; dichiarato in UI. | accettato |
| T-19 | Supply chain (dipendenze npm) | Lockfile, `pnpm audit` in CI, Renovate/Dependabot, dipendenze minime nel plugin. | medio |

## 5. Crittografia a riposo

### 5.1 Gerarchia delle chiavi

```
KEK (master key, 256 bit, fuori dal DB)
 └── wrap (AES-256-GCM, AAD = vaultId ‖ kekId) ──▶ DEK del vault (256 bit, casuale)
                                                    └── HKDF-SHA-256 ──▶ k_content   cifratura blob
                                                                     ├─▶ k_meta      cifratura campi (path, nomi, impostazioni)
                                                                     ├─▶ k_pathmac   HMAC della collisionKey (unicità/lookup)
                                                                     └─▶ k_blobid    HMAC del contentHash (ID del blob)
KEK └── HKDF ──▶ k_system: cifratura dei segreti di sistema (TOTP, password SMTP)
```

- **Cifratura dei blob**: AEAD a segmenti (schema STREAM, come Tink/age): chiave per blob derivata da `k_content` con un salt casuale salvato nell'intestazione; segmenti della dimensione dei chunk di upload; nonce = contatore di segmento + flag di ultimo segmento; AAD = `vaultId ‖ blobId`. Consente cifratura all'arrivo dei chunk, lettura con `Range` e rilevamento di troncamenti e riordini. Il builder può adottare una libreria che implementi lo schema invece di scriverlo, a condizione che sia mantenuta e verificata con vettori di test.
- **Campi cifrati**: AES-256-GCM con nonce casuale a 96 bit; AAD = tabella ‖ colonna ‖ id della riga (impedisce di spostare un valore cifrato su un'altra riga).
- **HMAC deterministici**: `pathMac = HMAC(k_pathmac, collisionKey)` per l'indice unico; `blobId = HMAC(k_blobid, contentHash)` per la deduplicazione dentro il vault. Chiavi diverse per vault → nessuna correlazione tra vault diversi.
- **Verifica della KEK**: il DB contiene `kekId` (fingerprint) e un valore di controllo cifrato; all'avvio il server lo decifra e rifiuta di partire se fallisce.

### 5.2 Rotazione della master key

`kamino keys rotate --new-key-file <path>` (o con `KAMINO_MASTER_KEY_PREVIOUS` + nuova chiave all'avvio):
1. il server carica vecchia e nuova KEK;
2. ricifra (re-wrap) tutte le DEK e i segreti di sistema con la nuova KEK, in transazioni a lotti;
3. aggiorna `kekId`; finché restano DEK con il vecchio `kekId`, entrambe le chiavi sono accettate;
4. al termine stampa la conferma e l'istruzione di rimuovere la vecchia chiave.
I contenuti non vengono ricifrati. Operazione ripetibile e riprendibile.

### 5.3 Rotazione della DEK di un vault

Non prevista in v1 (richiederebbe la ricifratura di tutti i blob). Il formato memorizza la versione della DEK per permetterla in futuro.

## 6. Cosa resta visibile a chi ha un dump senza master key

Esplicitamente accettato: numero di utenti, email e username; numero di vault, file e versioni per vault; dimensioni dei blob; orari delle modifiche; quali file nello **stesso** vault hanno contenuto identico (deduplicazione); stato dei dispositivi. Non visibile: contenuti, path, nomi di file, cartelle e vault, pattern di esclusione.

## 7. Cancellazione e backup

- La cancellazione di un **vault** distrugge subito la DEK (crypto-shredding) e poi elimina fisicamente i blob (job). Sul sistema attivo i dati sono subito illeggibili.
- La cancellazione di un **utente** segue quest'ordine: (1) account in `pending_deletion`, sessioni e token rifiutati; (2) se richiesto, il job `export-zip` genera lo ZIP, cifrato con una chiave effimera derivata da `k_system` e legata al token del link; (3) alla scadenza dei 7 giorni (o subito, se non c'è export) il job `user-deletion-finalize` distrugge ZIP e DEK di tutti i vault dell'utente, poi elimina i blob. Durante i 7 giorni le DEK esistono ancora: è il prezzo dell'export.
- **Correzione rispetto al brainstorming**: i backup fatti *prima* della cancellazione contengono ancora la DEK cifrata e restano decifrabili con la KEK. I dati diventano davvero irrecuperabili quando quei backup scadono secondo la loro retention, oppure dopo una rotazione della KEK con distruzione della vecchia chiave (che rende però inutilizzabili *tutti* i backup precedenti). La documentazione per chi fa self-hosting lo spiegherà e consiglierà una retention dei backup limitata (es. 30 giorni).
- `kamino backup create` produce un archivio con dump del DB e copia dello storage (i blob sono già cifrati; il dump contiene solo DEK cifrate). La KEK **non** è mai inclusa: va custodita separatamente.
- `kamino backup verify` ripristina il backup in un database temporaneo e verifica che la KEK fornita apra le DEK e che un campione di blob si decifri e corrisponda al proprio hash.

## 8. Autenticazione e sessioni

- Password: Argon2id (parametri OWASP correnti), lunghezza minima 12, controllo contro una lista di password comuni (offline).
- TOTP: RFC 6238, segreto cifrato con `k_system`, finestra ±1 passo, anti-replay del codice usato; 10 codici di recupero monouso (hash).
- Sessioni web: token casuale in cookie (`Secure` quando `KAMINO_PUBLIC_URL` è HTTPS; senza `Secure` nello scenario HTTP LAN), hash in DB, scadenza per inattività (default 14 giorni) e assoluta (default 90); elenco e revoca dalle impostazioni account; tutte le sessioni revocate al cambio password.
- Token dei dispositivi: senza scadenza, revocabili. Se l'utente è **bloccato** i token vengono rifiutati (`user_blocked`) ma non distrutti: allo sblocco i dispositivi riprendono senza ricollegarsi. Alla **cancellazione** vengono revocati definitivamente.
- Rate limiting: login, device-login, reset, claim di pairing, creazione upload; in memoria (istanza singola).

## 9. Audit log

Registra: creazione/blocco/sblocco/cancellazione utenti, modifiche di quota e di ruolo, modifiche alla configurazione di sistema (valore vecchio/nuovo solo per campi non segreti), reset 2FA da CLI, rotazione chiavi, test SMTP, avvio export alla cancellazione (senza il link). Append-only a livello applicativo; consultabile dagli admin. Mai contenuti o path.

## 10. Plugin: considerazioni specifiche

- Il token è salvato nei dati del plugin nel vault: chiunque legga i file del vault sul dispositivo lo ottiene. È dichiarato nella documentazione; la revoca è la contromisura.
- Nessuna telemetria. Le uniche connessioni di rete sono verso il server configurato dall'utente (dichiarato nel README per lo store).
- Il plugin non esegue mai contenuto ricevuto (es. JavaScript di altri plugin sincronizzati: vengono scritti come file, ed è Obsidian a decidere se caricarli — la categoria "Plugin installati" lo spiega all'utente).
