# 01 — Requisiti

> Stato: **approvato** (2026-11-06)

Priorità: **v1** = necessario per la prima release (1.0.0); **dopo** = previsto, da non precludere nel design.
Le voci marcate *(scelta del tech lead)* sono decisioni prese in fase di design senza indicazione esplicita del committente: sono le prime da verificare.

## 1. Utenti, ruoli e account

| ID | Requisito | Priorità |
|---|---|---|
| U-01 | Sistema multi-utente. Ogni utente vede e gestisce **solo** i propri vault e dispositivi. | v1 |
| U-02 | Ruoli: `user` e `admin`. Un admin è anche un utente normale per i propri vault. | v1 |
| U-03 | L'admin **non può vedere contenuti né struttura** (nomi di vault, file, cartelle) dei vault altrui da nessuna parte dell'interfaccia o delle API admin. Vede solo metriche aggregate: spazio usato, numero di vault e dispositivi, stato di sync aggregato, salute del sistema. | v1 |
| U-04 | Registrazione: **chiusa per default**. Un'impostazione di sistema (admin) la apre. Con registrazione chiusa, gli utenti sono creati dall'admin o tramite **invito via email**. | v1 |
| U-05 | Il primo utente è creato al primo avvio tramite una procedura di setup (web, protetta da un token stampato nei log di avvio) o via CLI, e diventa admin. *(scelta del tech lead)* | v1 |
| U-06 | Autenticazione con password (hash Argon2id). | v1 |
| U-07 | TOTP **facoltativo** per tutti gli utenti, **obbligatorio** per gli admin (configurazione forzata al primo accesso). Codici di recupero monouso generati all'attivazione. | v1 |
| U-08 | Recupero admin senza TOTP: comando CLI eseguito nel container (`kamino admin reset-2fa <username>`). | v1 |
| U-09 | Reset password via email se SMTP configurato; altrimenti l'admin genera un link monouso da consegnare all'utente. Un reset avviato dall'admin **è sempre visibile all'utente**: avviso al login successivo, voce nel suo registro di sicurezza, email se SMTP è configurato. Le sessioni e i dispositivi dell'utente **non** vengono revocati, così l'utente si accorge del cambio. | v1 |
| U-10 | L'admin può: creare (o invitare), bloccare, sbloccare, cancellare utenti; impostare, aumentare, ridurre, rimuovere la quota di ogni utente; configurare il sistema. **L'admin non imposta mai la password di un altro utente**: un utente creato dall'admin riceve un link di attivazione (via email o consegnato a mano) e sceglie la password da solo. | v1 |
| U-16 | Registro di sicurezza per l'utente: login, nuovi dispositivi, cambi password, reset avviati dall'admin, attivazione/disattivazione TOTP. | v1 |
| U-11 | **Utente bloccato**: niente login né sync (i token dei dispositivi vengono rifiutati), dati intatti, continuano a contare nella quota. | v1 |
| U-12 | **Utente cancellato**: conferma digitando lo username. Opzionalmente (se SMTP configurato) viene inviato **solo all'email dell'utente** un link valido 7 giorni a uno ZIP dei suoi vault; il link non è mai visibile all'admin né nei log. Durante i 7 giorni l'account è "in cancellazione" (niente login né sync) e le chiavi dei vault esistono ancora, per poter generare lo ZIP. Alla scadenza, o subito se non si sceglie l'export, i dati vengono eliminati con crypto-shredding (distruzione delle chiavi dei vault e dello ZIP) e purge fisico. | v1 |
| U-13 | Ogni azione amministrativa è registrata in un **audit log** (chi, cosa, quando, su quale entità, mai contenuti). | v1 |
| U-14 | Impostazioni account: cambio password, email, lingua, tema, gestione TOTP, sessioni attive. | v1 |
| U-15 | Passkey/WebAuthn, login OIDC. | dopo |

## 2. Quote

| ID | Requisito | Priorità |
|---|---|---|
| Q-01 | Quota di **spazio** per utente: impostabile, modificabile, rimovibile (illimitata). Default per nuovi utenti configurabile dall'admin. | v1 |
| Q-02 | Lo spazio conteggiato include versioni correnti, storico e cestino (dimensione dei contenuti come salvati). | v1 |
| Q-03 | Quota superata: gli upload che la farebbero superare vengono rifiutati con un errore chiaro; letture, cancellazioni, rinomine restano sempre possibili. **Esenti dal controllo** (per non intrappolare dati): upload per risolvere conflitti, upload della copia locale prima di applicare una risoluzione remota, ripristino dallo storico/cestino. Le modifiche normali restano nell'outbox e il plugin mostra uno stato persistente "spazio esaurito sul server: N modifiche non salvate" (regola "mai silenzioso"). Ridurre una quota sotto l'uso attuale non cancella nulla. *(esenzioni: scelta del tech lead)* | v1 |
| Q-04 | Il modello dati supporta altri tipi di quota in futuro (es. numero di dispositivi, numero di vault). | v1 (modello) |
| Q-05 | Avviso quota quasi esaurita (soglia, es. 90%) nella web app e nel plugin; email quando SMTP sarà usato per le notifiche. | v1 (UI) / dopo (email) |

## 3. Vault

| ID | Requisito | Priorità |
|---|---|---|
| V-01 | Ogni utente può registrare uno o più vault. | v1 |
| V-02 | L'onboarding di un vault (creazione sul server) avviene **dal plugin**; il primo dispositivo carica tutto il contenuto. | v1 |
| V-03 | Rinomina e cancellazione del vault dalla web app (cancellazione con conferma e crypto-shredding). | v1 |
| V-04 | **Download ZIP** del vault dalla web app, in chiaro, con la struttura originale. Anche **"com'era alla data X"** entro la finestra di storico. Solo il proprietario; mai l'admin per vault altrui. | v1 |
| V-05 | **Ricostruzione del server da un dispositivo**: dal plugin, un dispositivo con il vault in locale ricrea il vault su un server nuovo/vuoto (o su un vault nuovo dello stesso server). Gli altri dispositivi si ricollegano partendo dal contenuto locale (vedi D-07). Lo storico del vecchio server è perso e la UI lo dice chiaramente. | v1 |
| V-06 | Impostazioni di vault: storico, categorie `.obsidian` predefinite, pattern di esclusione predefiniti, modalità di sync predefinita. | v1 |

## 4. Dispositivi e collegamento

Un **dispositivo** è un'installazione del plugin in un vault su una macchina (un telefono con due vault sincronizzati = due dispositivi). *(scelta del tech lead: coincide con il modo in cui Obsidian isola i plugin per vault)*

| ID | Requisito | Priorità |
|---|---|---|
| D-01 | Tre modi per collegare un dispositivo a un vault esistente, tutti a partire dal plugin installato: **(a)** manuale (URL server, login, scelta del vault); **(b)** **QR code**; **(c)** **magic link**. | v1 |
| D-02 | QR e magic link sono **lo stesso link** `obsidian://kamino?...` gestito dal plugin. Il QR si legge con la fotocamera di sistema. Il QR/link si genera da un Obsidian già collegato o dalla web app; il link può essere copiato o (se SMTP configurato) inviato via email all'utente stesso. | v1 |
| D-03 | Il link contiene un **token di abbinamento monouso** con scadenza breve (default 10 minuti) e l'URL del server; mai password né token di altri dispositivi. | v1 |
| D-04 | **Conferma obbligatoria**: quando il nuovo dispositivo usa il link, il dispositivo o la sessione web che l'ha generato mostra una richiesta di approvazione con un **codice di verifica** di 4 caratteri visualizzato anche sul nuovo dispositivo. Finché non è approvato, il nuovo dispositivo non riceve nulla. Annullabile dall'origine; alla scadenza il token muore. | v1 |
| D-05 | L'utente vede, rinomina e revoca i propri dispositivi (web app e plugin). Un dispositivo revocato smette immediatamente di sincronizzare; i file già presenti sul dispositivo **non** vengono cancellati da remoto e la UI lo dice. | v1 |
| D-06 | Per ogni dispositivo sono visibili: piattaforma, versione del plugin, ultimo contatto, ultimo sync riuscito, ritardo rispetto alla testa del vault, modifiche in attesa, ultimo errore. | v1 |
| D-07 | **Collegamento con contenuto locale**: se il vault locale non è vuoto, il plugin non sovrascrive mai: i file identici vengono considerati allineati, quelli diversi diventano conflitti. Il plugin avvisa e guida l'utente prima di procedere. | v1 |
| D-08 | Login dal plugin: password (+ codice TOTP se attivo) servono solo a ottenere il token del dispositivo; la password non viene salvata. | v1 |

## 5. Sync

| ID | Requisito | Priorità |
|---|---|---|
| S-01 | Operazioni supportate: creazione, modifica, cancellazione, rinomina/spostamento di file e cartelle (anche vuote), allegati binari. | v1 |
| S-02 | **Modalità per dispositivo**, con default di vault: **Live** (default: invio dopo una pausa nella scrittura configurabile 2–30 s, default 5 s per i file aperti nell'editor, ~1–2 s per gli altri; ricezione immediata via WebSocket); **Periodica** (ogni X minuti, senza connessione permanente); **Manuale** ("Sincronizza ora", sempre sull'intero vault). | v1 |
| S-03 | Il sync parte sempre all'apertura di Obsidian, al ritorno in primo piano (mobile) e con il comando "Sincronizza ora" (intero vault, in entrambe le direzioni). | v1 |
| S-04 | Le modalità cambiano solo la tempistica, mai le garanzie: le modifiche locali non inviate sono in una coda durevole sul dispositivo. | v1 |
| S-05 | **Mai silenzioso**: indicatore di stato sempre visibile; avviso insistente (notice ripetuta + badge) se ci sono modifiche non sincronizzate da più di una soglia (default 1 ora in Live, configurabile) o se il server non è raggiungibile da più di una soglia (default 24 ore). Stato "tutto al sicuro" esplicito quando coda vuota e ultimo sync confermato. | v1 |
| S-06 | Il backend conosce sempre lo stato di sync di ogni dispositivo (ultimo contatto, cursore rispetto alla testa, errori). | v1 |
| S-07 | **Allegati**: limite per singolo file configurabile dall'admin, **obiettivo default 500 MB** (fattibilità su mobile da verificare con uno spike, vedi rischio R-1 in [02](02-architecture.md)). Upload e download a chunk e riprendibili. | v1 |
| S-08 | **Allegati grossi solo in Wi-Fi**, opzione per dispositivo, soglia per dispositivo (default 10 MB). Note e file sotto soglia passano sempre. Su **iOS**, dove il tipo di rete non è rilevabile, la rete è sempre considerata "a consumo": il plugin chiede conferma (con "non chiedere più per questa sessione"). File rimandati visibili nel pannello di stato con "scarica/carica ora". | v1 |
| S-09 | **Pattern di esclusione** (glob) con default di vault e override per dispositivo. | v1 |
| S-10 | **Cartella di configurazione** (`vault.configDir`, normalmente `.obsidian`): sync scelto **per categoria** — impostazioni di base, aspetto e temi, scorciatoie, elenco plugin attivi, plugin installati e loro impostazioni. Default del vault: nessuna categoria (solo note e allegati). Ogni dispositivo eredita il default e può sovrascriverlo; i dispositivi non personalizzati seguono le modifiche del default. Spiegazione in linguaggio semplice di ogni categoria nel plugin e nella documentazione. | v1 |
| S-11 | **Sempre esclusi** (non configurabile): dati del plugin Kamino (`<configDir>/plugins/<id-plugin>/`), stato di layout (`workspace.json`, `workspace-mobile.json`), cache. | v1 |
| S-12 | Una configurazione in arrivo per la cartella di configurazione non viene applicata a caldo: il plugin propone di ricaricare Obsidian. | v1 |
| S-13 | Un dispositivo che esclude una categoria non invia né applica modifiche di quella categoria; il server mantiene la versione degli altri. | v1 |
| S-14 | Merge automatico di modifiche concorrenti su parti diverse di un file markdown. | dopo |

## 6. Conflitti

| ID | Requisito | Priorità |
|---|---|---|
| C-01 | Rilevamento affidabile: c'è conflitto quando una modifica parte da una versione base che non è più quella corrente sul server. | v1 |
| C-02 | **Nessuna versione viene mai scartata**: entrambe sono salvate sul server. | v1 |
| C-03 | Risoluzione **nel plugin** e **nella web app** con diff side-by-side: tieni la mia, tieni quella in arrivo, tieni entrambe (la mia viene salvata come file affiancato con suffisso di conflitto), modifica manuale nella vista di merge. | v1 |
| C-04 | La web app ha un **centro conflitti** con tutti i conflitti aperti dei vault dell'utente; il plugin mostra i conflitti del proprio vault. | v1 |
| C-05 | Conflitti su file binari: confronto di metadati (dimensione, data, dispositivo) e anteprima per immagini; scelta tra le versioni o tieni entrambe. | v1 |
| C-06 | Regole automatiche che non perdono dati, senza chiedere all'utente: modifica vs cancellazione → vince la modifica; rinomina concorrente → vince la prima arrivata, il contenuto non cambia. Dettagli in [03](03-sync-protocol.md). | v1 |
| C-07 | Merge automatico a 3 vie lato server per file markdown quando le modifiche non si sovrappongono. | dopo |

## 7. Storico e recupero

| ID | Requisito | Priorità |
|---|---|---|
| H-01 | **Cestino di sicurezza obbligatorio**: file cancellati o versioni sovrascritte restano recuperabili per **7 giorni** anche con storico disattivato. | v1 |
| H-02 | **Storico versioni** per vault configurabile da 0 a 90 giorni (default 30). L'admin fissa il massimo consentito sul server (≤ 90); l'utente sceglie per vault entro il massimo. | v1 |
| H-03 | Storico e cestino contano nella quota; la web app mostra quanto spazio occupano. | v1 |
| H-04 | Le versioni base e le versioni coinvolte nei conflitti aperti sono conservate finché il conflitto non è risolto, indipendentemente dalla retention. | v1 |
| H-05 | Dalla web app: sfogliare lo storico di un file, vedere una versione, ripristinarla; ripristinare file dal cestino. | v1 |
| H-06 | Ripristino dal plugin (storico del file corrente). | dopo |

## 8. Web app

| ID | Requisito | Priorità |
|---|---|---|
| W-01 | Utente: elenco vault, dettaglio vault, dispositivi e loro stato, conflitti, uso quota, generazione QR/link, storico/cestino, download ZIP, impostazioni account. | v1 |
| W-02 | Admin: gestione utenti (crea, invita, blocca, cancella), quote, configurazione di sistema (inclusi SMTP, registrazione, limiti, retention massima), salute del sistema, audit log. Solo metriche aggregate. | v1 |
| W-03 | Pagina "Informazioni" con versione e nome in codice della release. | v1 |
| W-04 | Tema chiaro / scuro / sistema. | v1 |
| W-05 | Multilingua: italiano e inglese all'avvio, architettura i18n estendibile (react-i18next). | v1 |

## 9. Email

| ID | Requisito | Priorità |
|---|---|---|
| E-01 | Email in v1, con **SMTP facoltativo**. Le funzioni che richiedono email (inviti, reset password, ZIP alla cancellazione, invio magic link) sono disabilitate con spiegazione se SMTP non è configurato. | v1 |
| E-02 | Qualsiasi SMTP: nessuna cifratura, STARTTLS, TLS implicito; autenticazione facoltativa; opzione "accetta certificati non validi" con avviso. | v1 |
| E-03 | Configurazione via variabili d'ambiente **e** via interfaccia admin. Se un valore è impostato da ambiente, **vince l'ambiente** e il campo appare bloccato in UI ("impostato dall'ambiente"). Regola valida per tutta la configurazione di sistema. | v1 |
| E-04 | Pulsante "Invia email di prova" all'indirizzo dell'admin, con errore dettagliato in caso di fallimento. | v1 |
| E-05 | Template email localizzati (it/en, in base alla lingua del destinatario). | v1 |
| E-06 | Notifiche: dispositivo fermo da X giorni, conflitti aperti da X giorni, quota quasi esaurita. Il sistema è predisposto (outbox di eventi); l'avviso dispositivo fermo via email è il primo candidato. | dopo |

## 10. Plugin Obsidian

| ID | Requisito | Priorità |
|---|---|---|
| P-01 | `isDesktopOnly: false`; nessuna API Node/Electron; solo API Vault/adapter di Obsidian, `requestUrl`, WebSocket, WebCrypto. | v1 |
| P-02 | Schermate: onboarding vault, collegamento a vault esistente (manuale, QR/link), pannello di stato sync, impostazioni, risoluzione conflitti, approvazione di un nuovo dispositivo. | v1 |
| P-03 | Prestazioni su vault con migliaia di file: scansione incrementale, debounce degli eventi, upload a chunk, nessun blocco dell'interfaccia. | v1 |
| P-04 | Uso responsabile di batteria e rete su mobile. | v1 |
| P-05 | Rispetto delle linee guida della community (dichiarazione dell'uso di rete nel README, nessuna telemetria, naming, `manifest.json` e `versions.json`). | v1 |
| P-06 | Impostazioni mostrano versione e nome in codice. | v1 |
| P-07 | i18n it/en, lingua seguendo quella di Obsidian. | v1 |
| P-08 | **HTTP e HTTPS entrambi supportati.** HTTP è uno scenario di prima classe **solo per desktop** (server in casa, in LAN): plugin desktop e web app mostrano un avviso chiaro, non bloccante (password e token in chiaro sulla rete locale). **Su mobile è richiesto HTTPS**: se l'URL è `http://`, il plugin mobile non tenta la connessione e spiega le alternative (Tailscale, Cloudflare Tunnel, Let's Encrypt) con un link alla guida. | v1 |

## 11. Requisiti non funzionali

| ID | Requisito |
|---|---|
| N-01 | Self-hostabile con `docker compose up`; configurazione via variabili d'ambiente (`KAMINO_*`) e Docker secret; immagine piccola; healthcheck; migrazioni automatiche all'avvio. |
| N-02 | Deploy minimo: 2 container (`kamino` = server + web app statica; `postgres`). Storage dei contenuti su filesystem (volume) o S3-compatibile. |
| N-02b | **Tre scenari di riferimento documentati e testati**, ciascuno con un esempio di compose: **(1) casa/LAN in HTTP, solo desktop**; **(2) Tailscale o Cloudflare Tunnel** (TLS fornito dal servizio, nessuna porta aperta); **(3) dominio pubblico con Caddy + Let's Encrypt**. L'URL pubblico (`KAMINO_PUBLIC_URL`) è quello inserito nei QR e nei link. |
| N-03 | **Affidabilità**: nessuna perdita di dati per crash, rete instabile, dispositivi offline a lungo, reinstallazioni. Operazioni idempotenti. Conferma al client solo dopo salvataggio durevole. |
| N-04 | **Il server non parte** senza master key o con master key errata (verifica all'avvio). |
| N-05 | Sicurezza: threat model esplicito ([04](04-security-threat-model.md)); token per dispositivo revocabili; rate limiting; cifratura a riposo con envelope encryption. |
| N-06 | Osservabilità: log strutturati JSON (mai path o contenuti), metriche Prometheus aggregate, endpoint `/health/live` e `/health/ready`, endpoint `/version`. |
| N-07 | TypeScript strict ovunque. |
| N-08 | Istanza singola. Nessuna scelta deve precludere la scalabilità orizzontale futura (es. stato condiviso solo in Postgres/storage, fan-out tramite Postgres LISTEN/NOTIFY). |
| N-09 | Backup: procedura documentata e comandi CLI per creare e **verificare** un backup (DB + storage); ripristino testato automaticamente in CI. |
| N-10 | Nome del prodotto sostituibile da un'unica costante/config; lessico a tema solo in codice, log, commenti ed easter egg, mai nei testi UI. |
| N-11 | Versionamento SemVer 2.0.0, Conventional Commits, CHANGELOG automatico, nome in codice per MAJOR/MINOR ([release-names](release-names.md)). |
| N-12 | Lingue: documentazione di progetto in italiano; codice, identificatori e messaggi di commit in inglese. *(scelta del tech lead)* |
