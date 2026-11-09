# M1a — `packages/sync-core`: logica di sync pura, arbitro e simulatore

> Stato: **in revisione** · Data: 2026-11-09 · Branch: `m1a-sync-core`
> M1 è divisa in sotto-milestone, con il server prima e il plugin dopo gli spike: **M1a** sync-core (questa), **M1b** crypto + auth vera, **M1c** vault/file/blob/upload/commit sul server, **M1d** motore del plugin (dopo gli spike R-1…R-5).
> Riferimenti: [03 — protocollo](../../03-sync-protocol.md) §1–9, 11, 14; [02 — architettura](../../02-architecture.md) §5; requisiti S-01, S-04, S-09, C-01, C-02, C-06, D-07, V-05.

## 1. Decisioni

| #   | Decisione                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Z1  | M1 divisa in M1a–M1d (sopra); il motore del plugin aspetta gli spike perché le sue scelte di I/O dipendono da R-1…R-5.                                                                                                                                                                                                                                                                                                                                                                      |
| Z2  | M1a comprende anche l'**arbitro** (regole di commit del server, 03 §5.3) come funzione pura e il **simulatore** con N client per le proprietà di convergenza e idempotenza (02 §5).                                                                                                                                                                                                                                                                                                         |
| Z3  | **Core funzionale, guscio imperativo.** Tutto in `sync-core` è puro e deterministico: niente orologio, casualità, rete o file system; ID e tempi arrivano come input. Il plugin (M1d) e il server (M1c) forniscono il guscio.                                                                                                                                                                                                                                                               |
| Z4  | Schemi di op, esiti, voci del journal e snapshot in `@kamino/protocol` (`sync.ts`), come per le API della fase UI; `sync-core` li importa.                                                                                                                                                                                                                                                                                                                                                  |
| Z5  | `collisionKey` **conservativa**: in caso di dubbio fa coincidere più nomi, mai meno. Una collisione in più produce un suffisso o un conflitto `both_created`, mai una perdita. Il valore calcolato dal server è quello che conta.                                                                                                                                                                                                                                                           |
| Z6  | Glob delle esclusioni con un matcher scritto qui (`*`, `**`, `?`, classi `[...]`): le librerie comuni dipendono dal modulo `path` di Node, vietato nel plugin.                                                                                                                                                                                                                                                                                                                              |
| Z8  | **Outbox ricavata dall'indice.** L'indice durevole sa per ogni file contenuto locale, base, path locale e path sul server: le op da inviare si calcolano al momento dell'invio (una per file per batch, nell'ordine cancellazioni → spostamenti → put). Si salvano a parte solo le op già inviate con esito ignoto, ripetute identiche (stesso `opId`). La compattazione di 03 §8 vale per costruzione e un crash non lascia code incoerenti; S-04 è rispettato perché l'indice è durevole. |
| Z9  | Sul client M1a gestisce i **file**; gli eventi delle cartelle dipendono dalle API di Obsidian e arrivano con il plugin (M1d). L'arbitro gestisce già anche le cartelle. La riconciliazione con un indice esistente (`cursor_too_old`) arriva in M2 con la compattazione del journal.                                                                                                                                                                                                        |
| Z10 | Un file spostato altrove verso un nome che questo dispositivo non può usare non resta col nome vecchio (bloccherebbe quel nome a un altro file del server): la copia locale va nel cestino **solo quando il suo contenuto è sul server** (con `expect`; le modifiche locali si caricano prima) e il file risulta "non disponibile su questo dispositivo". Precisa 03 §6.4, che descrive i file nuovi; trovato dal simulatore.                                                               |
| Z7  | Fuori perimetro: risoluzione dei conflitti (M3; qui i conflitti si **aprono** e le candidate si **conservano**), WebSocket e compattazione del journal (M2), cifratura (M1b), modalità Live/Periodica (M2).                                                                                                                                                                                                                                                                                 |

## 2. Contratto (`packages/protocol/src/sync.ts`)

Schemi zod per 03 §5–6, con tipi esportati:

- `Op` = `put { opId, fileId, versionId, path, baseVersionId | null, contentHash, size, mtime }` · `mkdir { opId, fileId, path }` · `move { opId, fileId, fromPath, toPath }` · `delete { opId, fileId, baseVersionId }` (discriminata su `type`).
- `OpResult` = `accepted { seq, versionId?, path, fileId }` · `duplicate { original: OpResult }` · `conflict { conflictId, headVersionId }` · `rejected { code, path? }`.
- `CommitRequest { ops: Op[] (max 500) }`, `CommitResponse { results: OpResult[], head }`.
- `JournalEntry { seq, type, fileId, versionId?, path, contentHash?, size?, mtime?, deviceId, at, ignorable? }` con `type` tra quelli di 03 §6.1; `ChangesResponse { entries, head, hasMore }`.
- `Snapshot { head, files: { fileId, kind: "file" | "folder", path, versionId, contentHash, size, mtime }[], openConflicts: { conflictId, fileId }[] }`.
- `ContentHash` = SHA-256 esadecimale minuscolo (64 caratteri); ID = UUID (v7 consigliato, non imposto dallo schema).

## 3. Moduli di `sync-core`

Ogni modulo ha un'interfaccia piccola e si testa da solo.

### 3.1 `paths`

- `normalizePath(raw, configDir)`: separatori `\` → `/`, niente `/` iniziale o finale, niente segmenti vuoti, `.` o `..` (altrimenti `path_invalid`), **NFC**; il prefisso della cartella di configurazione locale (es. `.obsidian/`) diventa `{config}/`. `localPath(canonical, configDir)` fa l'inverso.
- `collisionKey(path)`: `NFC → toUpperCase → toLowerCase → NFC` (folding "largo": `ß`/`SS`/`ss` coincidono). Proprietà: idempotente; uguale per le forme NFC/NFD dello stesso nome; uguale per nomi che differiscono solo per maiuscole.
- `isRepresentable(path, platform)` con `platform ∈ windows | macos | ios | android | linux`: nomi riservati Windows (`CON`, `NUL`, `COM1`…, anche con estensione), caratteri vietati (`<>:"|?*` e caratteri di controllo su Windows; `:` anche su macOS e iOS, in modo conservativo), spazio o punto finale (Windows), lunghezza del segmento (255 byte UTF-8) e del path. Esito: `{ ok: true } | { ok: false, reason }`.
- `conflictSiblingPath(path, n)`: `Nota.md` → `Nota (1).md`, `Nota (2).md`… (03 §5.3 `move`.2, §9.4); per i file senza estensione o con punto iniziale (`.env`) il suffisso va in fondo.

### 3.2 `exclusions`

- `globMatch(pattern, path)`: `*` (non attraversa `/`), `**` (anche zero segmenti), `?`, `[abc]`/`[!abc]`; confronto sensibile alle maiuscole sul path canonico.
- `classify(path, settings)` → `{ category, excluded, reason }`: categorie della cartella di configurazione di 03 §11; **sempre esclusi** (`{config}/plugins/<PLUGIN_ID>/**`, `workspace*.json`, `cache/**`, temporanei) non disattivabili; esclusioni predefinite (`.trash/`, `.git/`, `.DS_Store`, `Thumbs.db`, `desktop.ini`); pattern di vault ⊕ pattern del dispositivo. `PLUGIN_ID` da `@kamino/brand`.

### 3.3 `arbiter` (regole del server)

- `decide(view, op, ctx) → Decision`, dove `view` contiene solo ciò che le regole leggono: esito già registrato per `opId`; file per `fileId` (path, `collisionKey`, versione corrente, tombstone sì/no, tipo); file vivo per la `collisionKey` di destinazione; conflitto aperto sul file. `ctx` = `{ blobPresent(hash), now }`.
- `Decision` = esito (`OpResult` senza `seq`) + **mutazioni** dichiarative (`insertVersion`, `setHead`, `setPath`, `tombstone`, `openConflict`, `addCandidate`, `journal(type)`). Il server vero (M1c) legge la vista con `SELECT … FOR UPDATE`, chiama `decide`, applica le mutazioni e assegna `seq` nella stessa transazione.
- Copre tutte le regole di 03 §5.3 (`put` 1–6, `move` 1–4, `delete` 1–3, `mkdir`) e `blob_missing`; `path_invalid`/`path_forbidden` tramite `paths` ed `exclusions`.
- `MemoryStore`: implementazione in memoria della vista + applicazione delle mutazioni, con `head`, journal, storico delle versioni, conflitti, `snapshot()` e `changes(after, limit)`. Usata dal simulatore e, in M1c, come oracolo nei test del server (stesse sequenze di op → stessi esiti).

### 3.4 `client` (riduttore del dispositivo)

- Stato **durevole**: `index` (per file: `fileId`, path canonico, `baseVersionId`, hash, size, mtime, flag `conflicted` / `unavailable` / `remoteNotApplied`), `outbox`, `cursor`. Stato **volatile**: op in volo, tentativi, backoff. Un crash perde solo lo stato volatile.
- `step(state, event) → { state, effects }`. Eventi: `localScan(entries)`, `localChange(…)`, `commitResult(opIds, results)`, `commitFailed(retryable)`, `changes(entries)`, `snapshot(s)`, `fileWritten`, `tick(now)`. Effetti: `uploadIfMissing(hash)`, `commit(ops)`, `fetchChanges(after)`, `fetchSnapshot`, `writeFile`, `renameLocal`, `trashLocal`, `ack(seq)`, `persist`, `notify(kind)`. **Ogni effetto che invia qualcosa è preceduto da `persist`** (S-04: l'outbox è durevole prima di qualunque invio).
- **Outbox** (Z8): op calcolate dall'indice al momento dell'invio; le op inviate con esito ignoto restano salvate e si ripetono identiche; backoff esponenziale con jitter da 1 s a 5 min (`retryDelay(tentativo, casuale)`), con il valore casuale passato in input.
- **Esiti** (03 §5.2): `accepted`/`duplicate` aggiornano l'indice e, se il path differisce, rinominano in locale; `conflict` marca il file in conflitto e **non** tocca la copia locale; `rejected` per codice: `moved_elsewhere` → rinomina locale al path del server; `path_taken` → `conflictSiblingPath` e nuovo `move`; `modified_since` → riscarica la versione corrente; `blob_missing` → upload e ripetizione; codici bloccanti (`quota_exceeded`, `file_too_large`, `vault_read_only`, `device_revoked`, `user_blocked`) → op ferma e `notify`, mai scartata.
- **Applicazione delle voci remote** (03 §6.4): voce propria → solo cursore; `file_put` su file non modificato → `writeFile`; su file con modifiche locali → nessuna scrittura, "conflitto in arrivo"; `file_moved` → rinomina (un file locale non tracciato sul path di arrivo viene rinominato con suffisso e caricato come nuovo); `file_deleted` → `trashLocal` solo se non modificato, altrimenti si tiene e il prossimo `put` lo resuscita; path non rappresentabile → `unavailable`; voce esclusa → `remoteNotApplied`; tipo sconosciuto → avanza solo se `ignorable`, altrimenti si ferma e chiede l'aggiornamento (03 §13). `ack` solo dopo `persist` dell'indice.
- **Riconciliazione completa** (03 §8.1): `reconcile(index, localScan, snapshot)` → azioni secondo la tabella (allineato, scarica, `both_created`, upload, riscarica il cancellato-localmente di default, scarica). In M1a: collegamento con contenuto locale (D-07) e ricostruzione del server (V-05: snapshot vuoto → tutto in upload); con indice esistente (`cursor_too_old`) in M2 (Z9).

### 3.5 `sim` (simulatore, solo test)

- `World` con un `MemoryStore`, N client (ognuno: file system finto `path → contenuto`, piattaforma, stato durevole/volatile), una **rete** con code per client che può **perdere, duplicare, riordinare e ritardare** richieste e risposte, e **crash** che azzerano lo stato volatile.
- Azioni casuali (fast-check): creare/modificare/cancellare/rinominare file (Z9), anche con nomi in collisione (`Nota.md`/`nota.md`, NFC/NFD) e nomi non rappresentabili su una piattaforma; consegne di rete; crash; cicli di sync.
- Il simulatore è codice di test (`src/sim/`, non esportato dal pacchetto) ma vive in `sync-core` per riusare tipi e moduli.

## 4. Proprietà (fast-check)

1. **Convergenza:** dopo una fase finale senza perdite né crash e con sync completo, ogni client ha esattamente lo stato vivo del server (path → contenuto), tranne i file `unavailable` sulla sua piattaforma e i file in conflitto dove è perdente (lì ha la sua copia, 03 §9.2).
2. **Nessuna perdita (la promessa):** ogni contenuto scritto da un client e poi sincronizzato è sul server come versione (corrente o nello storico) **o** come candidata di un conflitto aperto; nessuna versione accettata sparisce dallo storico.
3. **Idempotenza:** ripetere qualunque sottoinsieme di richieste o consegne (duplicazione) produce lo stesso stato del server e degli indici.
4. **Arbitro contro modello:** per sequenze casuali di op, `MemoryStore` rispetta gli invarianti: `head` cresce di 1 per voce di journal; nessuna coppia di file vivi con la stessa `collisionKey`; un file ha al più un conflitto aperto; `duplicate` restituisce l'esito originale.
5. **Outbox:** le op calcolate dall'indice coprono ogni differenza tra stato locale e server (una per file per batch) e un'op con esito ignoto viene ripetuta identica.
6. Unità e proprietà di `paths` ed `exclusions` (sopra), più i casi di 03 §14 riproducibili senza I/O: crash tra upload e commit, tra commit e indice, tra scrittura e `ack`; settimane offline con modifiche, spostamenti e cancellazioni altrove; cartella grande spostata mentre un altro modifica un file al suo interno; `Nota.md`/`nota.md`; NFC/NFD; orologio sbagliato (nessun effetto: `mtime` è solo informativo).

Ogni controesempio trovato da fast-check diventa un test di regressione con il suo seme.

## 5. Consegna

- Nuovo pacchetto `packages/sync-core` (aggiunto alle `COPY` di `docker/Dockerfile`, in `ignore` dei changeset come gli altri pacchetti interni); `@kamino/protocol` con `sync.ts`.
- Nessun codice di plugin o server cambia in M1a.
- Piano a blocchi: (A) contratto, `paths`, `exclusions`; (B) arbitro e `MemoryStore`; (C) client: outbox, esiti, voci remote, riconciliazione; (D) simulatore e proprietà; (E) documenti (`02 §5` se cambia qualcosa, HANDOVER) e revisione finale.
- In CI le proprietà girano con un numero di esecuzioni contenuto; uno script `test:deep` le esegue molte più volte in locale.
