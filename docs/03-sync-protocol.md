# 03 — Protocollo di sync

> Stato: **approvato** (2026-11-06). Diagramma: [flusso di sync](diagrams/02-sync-flow.drawio).
> Gli schemi esatti dei messaggi vivono in `packages/protocol` (zod) e sono la fonte di verità; questo documento ne definisce la semantica.

## 1. Principi

1. **Il server è l'arbitro.** Ordina tutte le modifiche accettate di un vault in una sequenza monotona (`seq`). Nessuna decisione dipende dagli orologi dei dispositivi.
2. **Unità = file intero.** Ogni versione è un contenuto completo identificato dal suo hash. Niente delta in v1.
3. **Identità stabile.** Ogni file/cartella ha un `fileId` che non cambia con rinomine e spostamenti.
4. **Ogni modifica dichiara la propria base** (`baseVersionId`). È ciò che rende affidabile il rilevamento dei conflitti oggi e possibile il merge a 3 vie domani.
5. **Contenuto prima, metadati poi.** Il contenuto viene caricato (e reso durevole) prima che la modifica che lo referenzia sia registrata.
6. **Conferma = durevole.** Il server risponde `accepted` solo dopo il commit della transazione Postgres (con `synchronous_commit` attivo) e dopo che il blob è persistito (fsync su filesystem / risposta positiva da S3).
7. **Idempotenza ovunque.** ID generati dal client (`opId`, `fileId`, `versionId`, UUIDv7) rendono sicuro ripetere qualunque richiesta.
8. **Mai perdere dati.** In ogni regola automatica, in caso di dubbio si conservano entrambe le versioni.

## 2. Concetti

| Concetto | Descrizione |
|---|---|
| `vaultId` | UUID del vault. |
| `seq` | Intero a 64 bit, monotono per vault, assegnato dal server a ogni voce del journal. `head` = ultimo `seq` assegnato. |
| `fileId` | UUIDv7 generato dal client alla creazione. Stabile per tutta la vita del file. |
| `versionId` | UUIDv7 generato dal client per ogni nuova versione di contenuto. |
| `contentHash` | SHA-256 (hex) del contenuto in chiaro, calcolato dal client. Il server lo usa per verificare l'integrità e ne ricava l'ID keyed del blob; lo memorizza **solo cifrato** (`file_versions.content_hash`, chiave `k_meta`) per restituirlo nel journal e negli snapshot (vedi [04](04-security-threat-model.md)). |
| `path` | Path relativo alla radice del vault, separatore `/`, normalizzato in **NFC**. I file nella cartella di configurazione usano il prefisso canonico `{config}/` al posto del nome locale (`.obsidian` o altro). |
| `collisionKey` | `path` NFC + case folding Unicode. Due file vivi nello stesso vault non possono avere la stessa `collisionKey` (garantisce che ogni path sia rappresentabile su filesystem case-insensitive). |
| `cursor` | Per dispositivo: ultimo `seq` applicato **in modo durevole** in locale e confermato con `ack`. |
| Tombstone | Versione speciale che marca un file cancellato (finisce nel cestino). |

## 3. Trasporto

- **REST** (HTTPS, JSON, prefisso `/api/v1`) per tutto ciò che scrive: commit, upload, risoluzione conflitti, pairing. Autenticazione: `Authorization: Bearer <deviceToken>` (plugin) o cookie di sessione (web).
- **WebSocket** (`/api/v1/ws`) per push e stream delle modifiche, heartbeat, eventi (richieste di pairing, revoca). Il token **non** va nell'URL (finirebbe nei log): il primo messaggio è `hello`.
- Header `Kamino-Protocol: <n>` su ogni richiesta REST; il server risponde `426` con codice `protocol_unsupported` se `n` non è supportato.
- Ogni risposta d'errore ha forma `{ error: { code, message, retryable, details? } }` con `code` dal catalogo in `packages/protocol`.

## 4. Upload dei contenuti

```
POST   /api/v1/vaults/:vaultId/blobs/check        { hashes: [...] }           → { missing: [...] }
POST   /api/v1/vaults/:vaultId/uploads            { contentHash, size }       → { uploadId, chunkSize, expiresAt }
PUT    /api/v1/vaults/:vaultId/uploads/:id/chunks/:index    (body binario)   → { received: [...] }
GET    /api/v1/vaults/:vaultId/uploads/:id                                    → { received: [...], expiresAt }
POST   /api/v1/vaults/:vaultId/uploads/:id/complete                           → { contentHash, size }
```

- `blobs/check` evita di ricaricare contenuti già presenti nel vault (rinomine, file duplicati, ripristini). La deduplicazione è **solo all'interno dello stesso vault**.
- La creazione della sessione verifica **limite di dimensione** (`file_too_large`) e **quota** (`quota_exceeded`) e riserva lo spazio fino a completamento o scadenza (default 24 h).
- `chunkSize` è deciso dal server (default 4 MiB). I chunk possono arrivare in qualsiasi ordine e in parallelo; ripetere un chunk è idempotente.
- Ogni chunk viene **cifrato all'arrivo** e scritto nello storage di staging: il contenuto in chiaro non tocca mai il disco.
- `complete` ricalcola lo SHA-256 decifrando in streaming e lo confronta con `contentHash` (`hash_mismatch` in caso di differenza: la sessione viene scartata). Il formato di cifratura a segmenti permette di promuovere i chunk a blob definitivo senza ricifrare (dettaglio al builder, vedi [04](04-security-threat-model.md) §5).
- Ripresa dopo interruzione: `GET` della sessione → si inviano solo i chunk mancanti.

Download: `GET /api/v1/vaults/:vaultId/blobs/:contentHash` con supporto `Range`, decifrato in streaming.

## 5. Commit delle operazioni

```
POST /api/v1/vaults/:vaultId/commits   { ops: Op[] }   → { results: Result[], head }
```

Le operazioni di un batch sono elaborate **in ordine** e ciascuna è **atomica singolarmente** (un batch può avere esiti misti). Batch consigliato: fino a 500 operazioni.

### 5.1 Operazioni

| Op | Campi | Significato |
|---|---|---|
| `put` | `opId, fileId, versionId, path, baseVersionId \| null, contentHash, size, mtime` | Crea il file (`baseVersionId = null`) o ne registra una nuova versione. |
| `mkdir` | `opId, fileId, path` | Crea una cartella (anche vuota). |
| `move` | `opId, fileId, fromPath, toPath` | Rinomina/sposta file o cartella. Lo spostamento di una cartella è inviato come `move` della cartella **e** di tutti i discendenti nello stesso batch. |
| `delete` | `opId, fileId, baseVersionId` | Cancella (tombstone → cestino). Per una cartella: `delete` dei discendenti, poi della cartella. |

### 5.2 Esiti

| Esito | Significato | Cosa fa il client |
|---|---|---|
| `accepted { seq, versionId?, path }` | Registrata. `path` è quello effettivo sul server. | Aggiorna l'indice, rimuove l'op dall'outbox; se `path` differisce rinomina in locale. |
| `duplicate { ...esito originale }` | `opId` già visto: ripetizione. | Come sopra. |
| `conflict { conflictId, headVersionId }` | Base superata: la versione è salvata come candidata di un conflitto. | Rimuove l'op dall'outbox, marca il file "in conflitto", **non** sovrascrive la copia locale. |
| `rejected { code }` | Non registrata (vedi catalogo). | Dipende dal codice (§5.4). |

### 5.3 Regole del server (in una transazione, con lock sulla riga del vault)

**`put`**
1. `opId` già registrato → `duplicate`.
2. `fileId` sconosciuto e `baseVersionId = null`:
   - nessun file vivo con la stessa `collisionKey` → **accettata** (creazione);
   - esiste un altro file vivo con la stessa `collisionKey` → **conflitto di tipo `both_created`** (il file esistente resta; la nuova versione è candidata).
3. `fileId` noto, `baseVersionId` = versione corrente → **accettata**.
4. `fileId` noto, versione corrente = **tombstone** → **accettata come resurrezione** (la modifica vince sulla cancellazione, C-06); voce di journal `file_restored` e notifica informativa ai dispositivi.
5. `fileId` noto, `baseVersionId` ≠ versione corrente → **conflitto `concurrent_edit`**. Se per quel file esiste già un conflitto aperto, la versione si aggiunge alle candidate.
6. Il `path` di un `put` su file esistente è informativo: se il file è stato spostato nel frattempo vale il path del server (restituito nell'esito).

**`move`**
1. `fromPath` ≠ path corrente sul server (spostamento concorrente) → `rejected { code: moved_elsewhere, path }`: vince il primo arrivato; il client sposta il file locale al path del server. Il contenuto non è toccato.
2. `toPath` con `collisionKey` occupata da un altro file vivo → `rejected { code: path_taken }`: il client rinomina localmente con suffisso deterministico (`Nota (1).md`, `Nota (2).md`...) e ripete, avvisando l'utente.
3. Rinomina che cambia solo maiuscole/minuscole (stessa `collisionKey`, stesso `fileId`) → accettata.
4. Altrimenti → accettata. Il `move` non tocca il contenuto e non ha conflitti di contenuto: una modifica concorrente sullo stesso file si applica comunque.

**`delete`**
1. File già cancellato → accettata (idempotente, nessuna nuova voce).
2. `baseVersionId` = versione corrente → accettata (tombstone, cestino 7 giorni).
3. `baseVersionId` ≠ versione corrente → `rejected { code: modified_since }`: la cancellazione non avviene; il client riscarica la versione corrente e avvisa ("file ripristinato perché modificato su un altro dispositivo").

**`mkdir`**: accettata se la `collisionKey` è libera; se esiste già una cartella con la stessa chiave, accettata come `duplicate` dell'esistente (restituisce il suo `fileId`, il client aggiorna l'indice).

Per ogni op accettata il server: inserisce la versione, aggiorna la testa del file, incrementa `head` del vault, inserisce la voce di journal, aggiorna la contabilità della quota; dopo il commit emette `NOTIFY`.

### 5.4 Codici di rifiuto principali

`path_taken`, `moved_elsewhere`, `modified_since`, `blob_missing` (il contenuto non è stato caricato: il client lo carica e ripete), `path_invalid`, `path_forbidden` (path sempre esclusi, es. dati del plugin), `quota_exceeded`, `file_too_large`, `vault_read_only` (utente in cancellazione), `device_revoked`, `user_blocked`, `rate_limited` (con `Retry-After`), `protocol_unsupported`.

## 6. Ricezione delle modifiche

### 6.1 Journal

```
GET /api/v1/vaults/:vaultId/changes?after=<seq>&limit=<n>   → { entries: Entry[], head, hasMore }
```

Tipi di voce: `file_put`, `file_moved`, `file_deleted`, `file_restored`, `folder_created`, `folder_deleted`, `conflict_opened`, `conflict_resolved`, `vault_settings_changed`.
Ogni voce: `{ seq, type, fileId, versionId?, path, contentHash?, size?, mtime?, deviceId, at }`. I path sono decifrati al momento della consegna al proprietario.

### 6.2 Snapshot (bootstrap e recupero)

```
GET /api/v1/vaults/:vaultId/snapshot   → { head, files: [{ fileId, kind, path, versionId, contentHash, size, mtime }], openConflicts }
```

Letto in un'unica transazione consistente: lo stato corrisponde esattamente a `head`. Usato per il primo collegamento di un dispositivo e quando il cursore è troppo vecchio.

### 6.3 Compattazione del journal

Il journal conserva le voci almeno fino al minimo tra i cursori dei dispositivi attivi e almeno per la finestra di retention dello storico. Dispositivi inattivi da più di 90 giorni non trattengono il journal. Un dispositivo con `cursor` più vecchio della voce più vecchia conservata riceve `cursor_too_old` e procede con una **riconciliazione completa** (§8) partendo dallo snapshot; il suo indice locale (con le basi note) gli permette di distinguere le proprie modifiche locali da quelle remote senza perdite.

### 6.4 Applicazione lato client

Per ogni voce, in ordine di `seq`:
- **Voce generata dal dispositivo stesso** → nessuna azione, avanza il cursore.
- **`file_put` remoto** su file **non modificato localmente** (hash locale = hash dell'indice) → scarica il contenuto, scrive in modo atomico, aggiorna l'indice.
- **`file_put` remoto** su file **con modifiche locali non ancora confermate** → **non sovrascrive**. Il file viene marcato "conflitto in arrivo"; il `put` locale in outbox riceverà `conflict` dal server.
- **`file_moved`** → rinomina locale (se il path locale è occupato da un file non tracciato: il file non tracciato viene rinominato con suffisso e sincronizzato come nuovo).
- **`file_deleted`** su file non modificato localmente → cancellazione locale tramite il cestino di Obsidian/sistema (`vault.trash`), mai cancellazione definitiva. Se modificato localmente → si mantiene e il successivo `put` lo resuscita (§5.3).
- Path non rappresentabile sul dispositivo (nomi riservati Windows, caratteri non ammessi dal filesystem, lunghezza) → il file **non** viene scritto né cancellato, è marcato "non disponibile su questo dispositivo" e segnalato nel pannello di stato.
- Voce esclusa dalle regole del dispositivo (categoria `.obsidian` non attiva, pattern di esclusione, allegato rimandato per rete a consumo) → registrata nell'indice come "remota non applicata", avanza il cursore.

Dopo aver applicato e reso durevole l'indice, il client invia `ack { seq }`. Il server aggiorna il cursore del dispositivo (solo in avanti).

## 7. WebSocket

Messaggi JSON con campo `type`. Heartbeat ogni 30 s; connessione considerata morta dopo 2 heartbeat mancati.

| Direzione | Messaggio | Contenuto |
|---|---|---|
| C → S | `hello` | `deviceToken, protocol: {min,max}, cursor, pluginVersion, platform` — deve arrivare entro 5 s. |
| S → C | `welcome` | `protocol` (negoziato), `head`, `deviceId`, `serverVersion`, `codename`. |
| S → C | `changes` | `entries[]`, `head` — inviato dopo `welcome` per il catch-up (a pagine) e a ogni nuovo commit. |
| C → S | `ack` | `seq` |
| C → S | `status` | `pendingOps, pendingBytes, deferredFiles, lastError?` — permette al server di mostrare "modifiche in attesa" (S-06). |
| S → C | `pairing_request` | `pairingId, deviceName, platform, verificationCode` (solo per il dispositivo che ha generato il link). |
| S → C | `device_revoked` | Il client si ferma, cancella il token e mostra il messaggio. |
| S → C | `vault_settings_changed` | Nuovi default di vault. |
| S → C | `error` | `code, message`, poi chiusura. |
| entrambi | `ping` / `pong` | Heartbeat. |

In modalità **Periodica** e **Manuale** non c'è WebSocket: il client usa `GET /changes` e `POST /api/v1/devices/me/status`.

## 8. Ciclo di sync del client

```
all'avvio / al resume / su "Sincronizza ora" / su timer (Periodica):
  1. scanner: scansione incrementale → nuove op in outbox
  2. push:    per ogni op in outbox: blobs/check → upload mancanti → commits
  3. pull:    changes after=cursor (o snapshot se cursor_too_old) → applica → ack
  4. status:  invia lo stato (pending, rimandati, errori)
in Live, tra un ciclo e l'altro:
  - evento del vault → debounce (5 s file aperto nell'editor, ~1,5 s altri) → push
  - messaggio `changes` dal WebSocket → pull/applica → ack
```

- Retry con backoff esponenziale + jitter (da 1 s a 5 min). L'outbox è persistita prima di qualunque invio.
- L'outbox **compatta** le op dello stesso file non ancora inviate (due `put` consecutivi → l'ultimo, con la base del primo).

### 8.1 Riconciliazione completa (collegamento con contenuto locale, cursore troppo vecchio, perdita dello stato locale)

Confronto tra snapshot remoto e contenuto locale, per path:

| Locale | Remoto | Azione |
|---|---|---|
| presente, hash uguale | presente | allineato: adotta `fileId`/`versionId` remoti |
| presente, hash diverso, **indice locale dice "non modificato dalla base B" e B è nella storia remota** | presente | il remoto è più recente: scarica |
| presente, hash diverso, altrimenti | presente | **conflitto `both_created`** (nessuna sovrascrittura) |
| presente | assente | upload come nuovo file |
| assente, ma l'indice dice che c'era ed era allineato | presente | cancellato localmente mentre non c'era sync: chiede all'utente (cancella sul server / riscarica), default **riscarica** |
| assente | presente | scarica |

Per i casi con molti conflitti (es. ricostruzione del server, V-05) la UI offre la **risoluzione in blocco**: "tieni tutte le versioni del server" / "tieni tutte le mie" / "tieni entrambe per tutti". *(aggiunta del tech lead)*

## 9. Conflitti

### 9.1 Modello

Un conflitto ha: `fileId`, `kind` (`concurrent_edit` | `both_created`), `baseVersionId` (se esiste), `headVersionId` al momento dell'apertura, `candidates[]` (versioni perdenti, con dispositivo e data), stato `open | resolved`.

### 9.2 Stato durante il conflitto

- Sul **dispositivo perdente**, la copia locale resta quella dell'utente; le modifiche remote al file non la sovrascrivono. Ulteriori modifiche locali restano locali (non generano nuovi conflitti) e la vista di risoluzione usa sempre il contenuto locale più recente come "la mia".
- Sugli **altri dispositivi** il file è alla versione corrente del server; il conflitto è visibile nell'elenco ma non ha effetti locali.

### 9.3 Risoluzione

```
POST /api/v1/vaults/:vaultId/conflicts/:id/resolve
  { opId, resolution: keep_head | keep_candidate(versionId) | keep_local(versionId, contentHash) | keep_both | manual(versionId, contentHash), expectedHeadVersionId }
```

- La risoluzione crea una nuova versione corrente con base = `expectedHeadVersionId` (è un normale `put`), più la voce `conflict_resolved`.
- `keep_both`: la versione corrente resta; la candidata (o la copia locale) diventa un **nuovo file** affiancato `Nota (conflitto - <dispositivo> - <AAAA-MM-GG HHmm>).md`. Il suffisso è localizzato nella lingua dell'utente.
- Se nel frattempo la versione corrente è cambiata di nuovo (`expectedHeadVersionId` superato) → `rejected { code: stale_resolution }`: la UI si aggiorna mostrando il nuovo contenuto in arrivo.
- Dal plugin, `keep_local`/`manual` caricano prima il contenuto (§4).
- Al ricevere `conflict_resolved` (risoluzione fatta altrove, es. dalla web app), il dispositivo perdente:
  1. se la copia locale coincide con la versione scelta → allineato;
  2. se la copia locale coincide con una candidata già sul server → scarica la nuova versione corrente;
  3. altrimenti (modifiche locali fatte **dopo** l'apertura del conflitto, mai caricate) → **prima** carica la copia locale come file affiancato (`keep_both` implicito, con suffisso di conflitto) e solo dopo scarica la nuova versione corrente. Nessuna modifica locale viene mai sovrascritta senza essere stata salvata sul server.

### 9.4 Regole automatiche (nessuna domanda all'utente, nessuna perdita)

| Caso | Regola |
|---|---|
| Modifica vs cancellazione (in qualsiasi ordine) | Vince la modifica. |
| Due spostamenti dello stesso file | Vince il primo arrivato; l'altro dispositivo si adegua. |
| Spostamento vs modifica | Entrambi si applicano (dimensioni indipendenti). |
| Spostamento verso path occupato | Suffisso deterministico `(1)`, `(2)`... |
| Due creazioni di cartelle con lo stesso path | Si fondono nella stessa cartella. |
| Due creazioni di file con lo stesso path | Conflitto `both_created` (scelta dell'utente). |

## 10. Pairing (QR / magic link)

```
1. Origine (dispositivo o sessione web):
   POST /api/v1/vaults/:vaultId/pairings              → { pairingId, link, expiresAt }
   link = obsidian://kamino?server=<url>&token=<pairingToken>
2. Nuovo dispositivo (dopo apertura del link):
   POST /api/v1/pairings/claim { token, deviceName, platform }
                                                      → { claimId, claimSecret, verificationCode }
   Il token è monouso: un secondo claim fallisce (`pairing_already_claimed`) e l'origine viene avvisata.
3. Origine riceve `pairing_request` (WS; la web app fa polling) con nome, piattaforma e codice:
   POST /api/v1/pairings/:pairingId/approve | /deny
4. Nuovo dispositivo fa polling:
   GET /api/v1/pairings/claims/:claimId   (Authorization: claimSecret)
                                                      → pending | denied | expired | approved { deviceToken, vaultId }
5. Bootstrap: snapshot + riconciliazione (§8.1).
```

- `pairingToken`: 256 bit casuali, salvato come hash; scadenza 10 minuti per l'intero flusso.
- `verificationCode`: 4 caratteri da un alfabeto senza ambiguità (es. niente `0/O`, `1/I`). L'origine mostra: "Approva solo se sul nuovo dispositivo vedi lo stesso codice".
- Il QR codifica esattamente il `link`.
- Il protocol handler di Obsidian consegna il link al vault aperto: se il vault non è vuoto, il plugin avvisa e spiega le conseguenze (riconciliazione, possibili conflitti) prima di procedere.

**Collegamento manuale**: `POST /api/v1/auth/device-login { username, password, totp? }` → token temporaneo (5 min) per `GET /vaults` e `POST /vaults/:id/devices` → `deviceToken`. Non richiede approvazione (la password è la prova). Gli altri dispositivi e la web app mostrano "nuovo dispositivo collegato"; se SMTP è configurato, email di avviso di sicurezza all'utente. *(scelta del tech lead)*

**Onboarding vault (Jango)**: device-login → `POST /api/v1/vaults { name }` → `deviceToken` → upload iniziale (put con base `null`) a batch, con avanzamento visibile e ripresa.

**Ricostruzione server (V-05)**: identica all'onboarding, con il plugin che scarta il legame con il vecchio server (indice, token). Gli altri dispositivi si ricollegano e passano per la riconciliazione (§8.1).

## 11. Cartella di configurazione

Path canonico `{config}/...`. Categorie (valutate sul path relativo alla config dir):

| Categoria | Path |
|---|---|
| Impostazioni di base | `app.json`, `core-plugins.json`, `core-plugins-migration.json`, altri `*.json` alla radice non elencati sotto |
| Aspetto e temi | `appearance.json`, `themes/**`, `snippets/**` |
| Scorciatoie | `hotkeys.json` |
| Elenco plugin attivi | `community-plugins.json` |
| Plugin installati e impostazioni | `plugins/**` |
| **Sempre esclusi** | `plugins/<PLUGIN_ID>/**`, `workspace.json`, `workspace-mobile.json`, `workspaces.json`, `cache/**`, file temporanei |

Esclusioni predefinite fuori dalla config dir (modificabili): `.trash/`, `.git/`, `.DS_Store`, `Thumbs.db`, `desktop.ini`.

Le impostazioni effettive di un dispositivo = default del vault ⊕ override del dispositivo. Entrambi sono salvati sul server (cifrati, perché i pattern possono rivelare la struttura) e in locale.

## 12. Stato di sync di un dispositivo (derivato)

| Campo | Fonte |
|---|---|
| Ultimo contatto | ultima richiesta autenticata / messaggio WS |
| Ultimo sync riuscito | ultimo `ack` o commit accettato |
| Ritardo | `head − cursor` (numero di modifiche) e tempo dalla prima voce non confermata |
| Modifiche in attesa | ultimo `status` ricevuto |
| Ultimo errore | ultimo `status` / errori lato server per quel dispositivo |
| Stato sintetico | `ok` · `in ritardo` · `fermo` (oltre soglia) · `errore` · `revocato` |

## 13. Versioning del protocollo

- `PROTOCOL_VERSION` intero in `packages/protocol`. Si incrementa **solo** per cambiamenti incompatibili; le aggiunte compatibili (nuovi campi opzionali, nuovi tipi di voce che i client vecchi possono ignorare) non lo cambiano.
- I client **devono ignorare** campi sconosciuti e trattare tipi di voce sconosciuti come "non applicabili" senza fermare il sync (ma avanzando il cursore solo se la voce è marcata `ignorable: true`; altrimenti si fermano e chiedono l'aggiornamento).
- Il server supporta `[PROTOCOL_VERSION − 1, PROTOCOL_VERSION]` come minimo.
- I test di contratto di `packages/protocol` verificano la compatibilità con gli schemi della versione precedente (fixture registrate).

## 14. Casi limite da coprire con test

- Crash del client tra upload e commit (blob orfano → GC), tra commit e aggiornamento dell'indice (risposta persa → `duplicate` alla ripetizione), tra scrittura del file e `ack` (voce riapplicata: idempotente).
- Crash del server durante il commit (transazione annullata, il client ripete).
- Dispositivo offline per settimane con modifiche su file modificati, spostati e cancellati altrove.
- Cartella con migliaia di file spostata mentre un altro dispositivo modifica un file al suo interno.
- `Nota.md` e `nota.md` creati su due dispositivi (uno case-sensitive).
- Nomi con forme Unicode diverse (NFD da macOS/iOS vs NFC).
- File modificati fuori da Obsidian a app chiusa.
- Orologio del dispositivo sbagliato di giorni (non deve influire).
- Quota superata a metà di un upload iniziale.
- Revoca del dispositivo durante un upload.
- Rotazione della master key durante il traffico.
- Due risoluzioni concorrenti dello stesso conflitto (web + plugin).
