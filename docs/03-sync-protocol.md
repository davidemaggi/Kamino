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
| `resolve` | `opId, conflictId, expectedHeadVersionId, keep` | Risolve un conflitto aperto (§9.3). |

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

**`resolve`**: conflitto sconosciuto → `rejected { code: not_found }`; già risolto o testa ≠ `expectedHeadVersionId` → `rejected { code: stale_resolution }`; candidata non del conflitto o `versionId` già usato → `invalid_request`; contenuto non caricato → `blob_missing`. Altrimenti §9.3.

**`mkdir`**: accettata se la `collisionKey` è libera; se esiste già una cartella con la stessa chiave, accettata come `duplicate` dell'esistente (restituisce il suo `fileId`, il client aggiorna l'indice).

Per ogni op accettata il server: inserisce la versione, aggiorna la testa del file, incrementa `head` del vault, inserisce la voce di journal, aggiorna la contabilità della quota; dopo il commit emette `NOTIFY`.

### 5.4 Codici di rifiuto principali

`path_taken`, `moved_elsewhere`, `modified_since`, `stale_resolution`, `blob_missing` (il contenuto non è stato caricato: il client lo carica e ripete), `path_invalid`, `path_forbidden` (path sempre esclusi, es. dati del plugin), `quota_exceeded`, `file_too_large`, `vault_read_only` (utente in cancellazione), `device_revoked`, `user_blocked`, `rate_limited` (con `Retry-After`), `protocol_unsupported`.

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

> **Implementazione (M2a).** Job notturno (pg-boss). Elimina le voci già confermate da tutti i dispositivi attivi (non revocati, visti negli ultimi 90 giorni) e più vecchie della retention del vault, e registra l'ultimo `seq` eliminato in `vaults.journal_floor`. Un cursore sotto il floor riceve `410 cursor_too_old` su `GET /changes`, oppure `error cursor_too_old` + chiusura `4410` sul WebSocket. Floor e voci si leggono in un'unica transazione, così una compattazione non può aprire buchi silenziosi. Anche un cursore **oltre la testa** riceve `cursor_too_old`: il journal del server non è quello che il dispositivo conosceva (ad esempio dopo il ripristino da un backup), e saltare i `seq` riusati perderebbe modifiche.

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

> **Implementazione (M2a).** Rotta `GET /api/v1/ws`; schemi in `@kamino/protocol` (`ClientMessage`, `ServerMessage`).
> - **Catch-up:** pagine da 500 voci; un socket invia la pagina successiva solo dopo che la precedente è stata consegnata al socket, e più commit ravvicinati diventano una sola lettura.
> - **Heartbeat:** a ogni battito il server ricontrolla dispositivo e utente, così una revoca o un blocco fatti da un'altra istanza chiudono il socket entro un battito. La revoca fatta sulla stessa istanza lo chiude subito.
> - **Codici di chiusura:**
>   - `4400` messaggio non valido;
>   - `4401` `hello` mancante (5 s) o token non valido;
>   - `4403` dispositivo revocato o utente bloccato;
>   - `4404` vault non trovato;
>   - `4408` client silenzioso per 2 battiti;
>   - `4409` sostituito (massimo 5 socket per dispositivo);
>   - `4410` `cursor_too_old`;
>   - `4426` protocollo non supportato.
> - **Ordine:** solo il primo `hello` conta; i messaggi inviati subito dopo (ad esempio un `ack`) vengono gestiti dopo `welcome`, fino a 20. Prima di `welcome` il server non invia nient'altro.
> - **Limiti:** frame oltre 64 KB → chiusura. Gli `ack` e gli `status` ravvicinati diventano una sola scrittura alla volta, con l'ultimo valore.
> - **Senza WebSocket:** lo stato si invia con `POST /api/v1/vaults/:vaultId/status`, come in M1c.

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

### 8.2 Note di implementazione del guscio (M1d)

Il ciclo è eseguito da `packages/sync-engine` (spec M1d, E1–E10) attorno a `step()` di `sync-core`; il plugin fornisce gli adattatori Obsidian, i test del server usano lo stesso motore contro il server vero.

- **Ogni ciclo fa una scansione completa** (contratto Z11), ma rilegge solo i file con dimensione o mtime cambiati (cache degli stat). Le cartelle sono riportate a parte (`folders` dell'evento `sync`). Il ciclo parte all'avvio, al ritorno in primo piano, dopo le modifiche locali (debounce 5 s / 1,5 s), su "Sincronizza ora" e con un **pull periodico ogni 60 s**, ponte fino al WebSocket di M2b.
- **Write-ahead:** lo stato durevole è salvato (file temporaneo + rename) prima di qualunque altro effetto; gli effetti sui file avvengono in ordine, ognuno col suo evento.
- **File grandi:** l'upload legge a pezzi e invia chunk della dimensione indicata dal server, riprendendo le sessioni salvate; il download chiede intervalli `Range` di 4 MiB e scrive su un file temporaneo, verificando l'hash prima di metterlo al suo posto. Dove lo streaming non è disponibile, i file oltre 100 MB restano **rimandati** e visibili, mai persi.
- **Cartelle (Z9):** il server tiene i path piatti. Una cartella spostata dall'utente produce lo spostamento della cartella e di ogni file al suo interno; uno spostamento remoto crea la nuova cartella, i file seguono uno a uno e la vecchia è rimossa quando resta vuota. Una cartella cancellata altrove è rimossa qui solo se vuota: con dentro file di questo dispositivo torna sul server. Su un disco case-sensitive `d` e `D` restano due cartelle locali che per il server sono una (la seconda non invia nulla).
- **Cursore troppo vecchio (§6.3):** il pull riceve `cursor_too_old`, il client chiede lo snapshot e lo **riconcilia con l'indice che già ha**: per ogni file e cartella noti ricava ciò che le voci di journal perse avrebbero detto (nuova versione, spostamento, cancellazione, resurrezione) e applica le stesse regole del journal. Con l'indice intatto non serve la tabella del §8.1: una cancellazione locale avvenuta nel frattempo è inviata normalmente; la tabella resta per il collegamento con contenuto locale e la perdita dello stato locale.
- **Tempo reale (M2b):** in Live il WebSocket è solo un **campanello**: ogni `changes` con `head` oltre il cursore del dispositivo avvia un ciclo (coalescente), i dati arrivano sempre via REST; dopo ogni (ri)connessione parte un ciclo di recupero. Riconnessione con backoff (1 s → 5 min); `4409` aspetta 5 min (un'altra finestra dello stesso dispositivo); `4401`/`4403`/`4426` fermano il motore; `4410` → riconciliazione dallo snapshot; `4404` → verifica REST. Con il socket giù, in Live, pull ogni 5 min. Periodica: niente socket, un ciclo ogni N minuti; Manuale: solo "Sincronizza ora" (sempre all'avvio e al ritorno in primo piano).
- **Eco:** gli eventi del vault causati dal motore si riconoscono per path, dimensione e mtime per 10 s; una modifica dell'utente nello stesso intervallo passa. Una nota aperta con modifiche non salvate non viene mai sovrascritta: la scrittura risulta `changed` e il ciclo dopo riparte dal contenuto dell'utente.
- **Reti a consumo (S-08):** con "allegati grossi solo in Wi-Fi", i file oltre soglia su rete a consumo restano rimandati (mai "al sicuro", ma senza avvisi insistenti); su iOS si chiede, con "non chiedere più fino al riavvio".
- **Impostazioni (S-10…S-13):** prima del primo ciclo il motore legge le impostazioni effettive (senza rete: gli ultimi default del vault visti più le scelte del dispositivo), così un ciclo non gira mai con meno esclusioni di quelle impostate; la voce `vault_settings_changed` le fa rileggere.

## 9. Conflitti

### 9.1 Modello

Un conflitto ha: `fileId`, `kind` (`concurrent_edit` | `both_created`), `baseVersionId` (se esiste), `headVersionId` al momento dell'apertura, `candidates[]` (versioni perdenti, con dispositivo e data), stato `open | resolved`.

### 9.2 Stato durante il conflitto

- Sul **dispositivo perdente**, la copia locale resta quella dell'utente; le modifiche remote al file non la sovrascrivono. Ulteriori modifiche locali restano locali (non generano nuovi conflitti) e la vista di risoluzione usa sempre il contenuto locale più recente come "la mia".
- Sugli **altri dispositivi** il file è alla versione corrente del server; il conflitto è visibile nell'elenco ma non ha effetti locali.

### 9.3 Risoluzione

Dal dispositivo la risoluzione è un'op `resolve` nel normale `POST /commits` (§5), idempotente per `opId` come le altre:

```
{ type: "resolve", opId, conflictId, expectedHeadVersionId, keep }
keep: { kind: "head" }                                           // la versione corrente resta
    | { kind: "candidate", candidateVersionId, versionId }       // nuova versione corrente = candidata
    | { kind: "content", versionId, contentHash, size, mtime }   // nuova versione corrente = contenuto caricato (copia locale, unione manuale)
    | { kind: "both", candidateVersionId, fileId, versionId, path }  // la candidata diventa un file affiancato
```

- La nuova versione corrente ha base = testa attuale (come un `put`); se il file era nel cestino torna in vita (`file_restored`). Poi la voce `conflict_resolved { conflictId, fileId, versionId, contentHash }`, con la versione scelta.
- `both`: la versione corrente resta; la candidata diventa un **nuovo file** affiancato `Nota (conflitto - <dispositivo> - <AAAA-MM-GG HHmm>).md` (suffisso nella lingua dell'utente; path occupato → `(1)`, `(2)`…). Journal: `file_put` del nuovo file, poi `conflict_resolved` con la testa.
- Se nel frattempo la versione corrente è cambiata (`expectedHeadVersionId` superato) o il conflitto è già chiuso → `rejected { code: stale_resolution }`: la UI si aggiorna mostrando il nuovo contenuto in arrivo.
- Dal plugin, `content` carica prima il contenuto (§4).
- **Web app:** `POST /api/v1/conflicts/:id/resolve { resolution, expectedIncomingAt, expectedMineAt? }` e `POST /api/v1/conflicts/resolve-all { strategy, ids }`. Il server costruisce la stessa op `resolve` ("mia" = testa, "in arrivo" = candidata più recente; `manual` = il server salva il testo come blob) e la passa alle stesse regole. Candidata o testa diverse da quelle viste → 409 `stale_resolution`. In blocco, solo gli id visti; quelli chiusi o cambiati nel frattempo si saltano. Le voci di journal scritte dalla web app hanno `deviceId` = UUID nullo, le versioni nessun dispositivo.
- **Ripristini dalla web app** (`POST /versions/:id/restore`, `POST /trash/:id/restore`): un `put` costruito dal server con il contenuto scelto e base = testa letta in quel momento. Se la testa cambia prima del commit il ripristino diventa una candidata di conflitto: niente va perso. Dal cestino il file torna al suo path, o con `(1)` se occupato (`file_restored`).
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

> **Rotte reali (M6).** Come sopra, con questi dettagli:
> - claim: `{ token, deviceName, platform, pluginVersion, protocolVersion }` → `{ claimId, claimSecret, verificationCode, expiresAt }`; token sconosciuto 400 `token_invalid`, flusso chiuso o scaduto 410 `token_expired`, `protocolVersion` non supportata 426 `protocol_unsupported`.
> - Polling e ritiro con `Authorization: Claim <claimSecret>`: `GET /api/v1/pairings/claims/:claimId` → `pending | denied | expired | consumed | approved { deviceId, deviceToken, username, vault { id, name } }`; `POST /api/v1/pairings/claims/:claimId/cancel` (204) ritira la richiesta. Il `deviceToken` si riconsegna a ogni poll entro i 10 minuti del flusso (una risposta persa si recupera); dopo, lo stato è `consumed`.
> - Origine: anche `GET /api/v1/pairings/:pairingId` (stato, per il polling della web app) e `POST /api/v1/pairings/:pairingId/cancel`; un flusso già chiuso risponde 409 `pairing_closed`. `?email=1` sull'offerta manda il link all'utente (409 senza SMTP).
> - WebSocket verso tutti i dispositivi del vault: `pairing_request`, `pairing_closed`, `pairing_reused`.
> - Il server salva solo hash (token del link, segreto del claim, token del dispositivo) e cancella i pairing un giorno dopo la scadenza. Offerte limitate a 30 ogni 15 minuti per utente. Decisioni Q1–Q9 in `docs/HANDOVER.md`.

**Collegamento manuale**: `POST /api/v1/auth/device-login { username, password, totp? }` → token temporaneo (5 min) per `GET /vaults` e `POST /vaults/:id/devices` → `deviceToken`. Non richiede approvazione (la password è la prova). Gli altri dispositivi e la web app mostrano "nuovo dispositivo collegato"; se SMTP è configurato, email di avviso di sicurezza all'utente. *(scelta del tech lead)*

> **Rotte reali (M1c).** Il collegamento manuale è implementato così:
> 1. `POST /api/v1/devices/login { username, password, totp? }` → `{ status: "ok", enrollToken, expiresAt }` oppure `{ status: "totp_required" }`. Il token di iscrizione vale **10 minuti**.
> 2. Con `Authorization: Bearer <enrollToken>`: `GET /api/v1/enroll/vaults`, `POST /api/v1/enroll/vaults { name }` (onboarding: il primo dispositivo del vault è l'origine) e `POST /api/v1/enroll/vaults/:vaultId/devices { name, platform, pluginVersion, protocolVersion }` → `{ deviceId, deviceToken, vault }`.
> 3. Con il `deviceToken`: `PATCH /api/v1/device` (rinomina) e `DELETE /api/v1/device` (il dispositivo si scollega da solo).
>
> Le rotte con Bearer non richiedono l'intestazione anti-CSRF della web app. L'avviso "nuovo dispositivo collegato" arriva con M2 (WebSocket) e l'email con SMTP. Dettagli nella spec M1c (`docs/superpowers/specs/2026-11-09-m1c-sync-server-design.md` §2).

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

> **Implementazione (M2a).**
> - **Default S-10:** nessuna categoria della cartella di configurazione, più le esclusioni predefinite (`DEFAULT_SYNC_SETTINGS` in `@kamino/protocol`).
> - **Rotte del plugin:** `GET`/`PUT /api/v1/vault/settings` e `GET`/`PUT /api/v1/device/settings` (`{ override, effective }`, con `override: null` = segue il default).
> - **Propagazione:** una modifica del default è la voce di journal `vault_settings_changed` con `fileId`/`path` riservati `_vault` (`VAULT_EVENT_ID`) e `ignorable: true`. Sul WebSocket è seguita dal messaggio `vault_settings_changed { settings }`.

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
