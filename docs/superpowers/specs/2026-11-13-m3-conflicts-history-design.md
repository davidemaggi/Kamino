# M3 — Conflitti e storico (spec leggera)

> 2026-11-13. Rigore pieno solo dove si possono perdere dati. Riferimenti: 03 §9, §14; 05 §5–6; HANDOVER U6, U9, C10.

## Cosa c'è già

- Rilevamento dei conflitti al commit (`concurrent_edit`, `both_created`) sul server; nel client il lato perdente segna `conflictId` e non sovrascrive mai la copia locale.
- Letture: elenco/dettaglio conflitti, versioni, cestino, albero a una data, ZIP.
- UI: vista conflitto e risoluzione in blocco nel plugin (su `FakeSyncState`), centro conflitti, storico e cestino nella web app (scritture dietro `features.historyWrites`).

## Cosa manca, in due PR

### M3a — server e web app

| # | Decisione |
|---|---|
| A1 | `ResolutionService` (`src/conflicts/resolve.ts`): una sola logica per web e dispositivi, in transazione con il lock sulla riga del vault come il commit. Scelte interne: `head` (nessuna nuova versione), `candidate` (nuova versione corrente con il blob della candidata), `content` (blob già caricato dal dispositivo, per `keep_local`/`manual`), `text` (manuale dalla web app: il server cifra e salva il blob), `both` (la versione corrente resta; candidata o contenuto diventano un file affiancato `Nota (conflitto - <dispositivo> - <AAAA-MM-GG HHmm>).md`, suffisso nella lingua dell'utente). Ogni risoluzione scrive `conflict_resolved` nel journal e, se c'è, la `file_put`/`file_created` corrispondente; la nuova versione ha base = testa attuale |
| A2 | Concorrenza: web con `expectedIncomingAt` (la candidata vista) più la testa al momento della lettura; dispositivo con `expectedHeadVersionId`. Testa o candidata cambiate → `stale_resolution` (409). Conflitto già risolto → 409 `conflict_resolved` (la UI lo tratta come "già risolto altrove") |
| A3 | Rotte: web `POST /conflicts/:id/resolve` e `POST /conflicts/resolve-all` (contratto già in `@kamino/protocol`; in blocco solo gli id visti, saltando quelli non più aperti); dispositivo `POST /vaults/:vaultId/conflicts/:id/resolve { opId, resolution, expectedHeadVersionId, archiveContentHash? }` idempotente con `applied_ops`. `resolution`: `keep_head`, `keep_candidate(versionId)`, `keep_content(contentHash)`, `keep_both(contentHash?)` |
| A4 | Nessuna perdita dal plugin: con `archiveContentHash` il contenuto locale non ancora sul server viene salvato come candidata del conflitto (è nello storico) prima di risolvere. Il plugin lo manda sempre quando la copia locale differisce da tutte le versioni del server |
| A5 | Ripristino di una versione (`POST /versions/:id/restore`): nuova versione corrente con il blob di quella scelta, base = testa; se il file è nel cestino, torna anche in vita. Ripristino dal cestino (`POST /trash/:id/restore`): il file torna all'ultimo path con l'ultima versione con contenuto; path occupato → suffisso `(1)`, `(2)`… (03 §9.4). Journal `file_restored`. Quota controllata come per un `put` |
| A6 | Retention (job giornaliero `history-retention`): si cancellano le versioni non correnti più vecchie di `history_retention_days` (0–90, ≤ massimo di sistema), **tranne** quelle di conflitti aperti (candidate, base, testa all'apertura). I file nel cestino da più di max(7, retention) giorni perdono versioni e riga (resta la voce di journal, già compattabile) |
| A7 | GC dei blob (nello stesso job): blob senza versioni che li citano, senza sessione di upload aperta e più vecchi di 24 h → cancellati dallo storage, poi la riga; `quota_usage` aggiornata. Prima lo storage, poi la riga: un crash lascia una riga orfana che il giro dopo ripulisce, mai una versione senza blob |
| A8 | Web: `features.historyWrites` acceso; i pulsanti "In arrivo" spariscono. U9 resta com'è (404 sull'ambiguità, nessuna fuga) |

**Test:** integrazione per ogni scelta di risoluzione e per lo stale; due risoluzioni concorrenti (web + dispositivo: una vince, l'altra 409); ripristini con path occupato e quota; retention che non tocca i conflitti aperti; GC che non tocca blob ancora referenziati o in upload; e2e Playwright: risolvi, ripristina dallo storico e dal cestino sul server vero.

**Come è andata (deviazioni dall'implementazione, 2026-11-13):**

- **A1/A3:** niente rotta dispositivo dedicata. La risoluzione è una nuova op `resolve` nell'unione `Op` di `@kamino/protocol`, decisa dall'arbitro puro di sync-core (`decideResolve`) e applicata dal normale `SyncService.commit` (stesso lock, stessa idempotenza con `applied_ops`). `keep`: `head`, `candidate`, `content`, `both` (03 §9.3). La web app costruisce la stessa op sul server (`ResolutionService`, `src/conflicts/resolve.ts`); `manual` passa da `storePlain` (upload lato server, quota compresa).
- **A2:** conflitto già chiuso → `stale_resolution` (non un codice a parte); la web app può mandare anche `expectedMineAt`.
- **A4** passa a M3b: con le op attuali il plugin archivia la copia locale caricandola e usando `content`, o con un `put` di un file affiancato nello stesso batch prima del `resolve`.
- **A7:** ordine invertito, **prima la riga, poi l'oggetto** (sotto il lock del vault e un advisory lock sulla chiave, lo stesso di `complete` dell'upload). Un crash in mezzo lascia un oggetto senza riga (spazio sprecato), mai una versione senza contenuto né una riga che punta al vuoto. La quota segue da sola (somma delle righe `blobs`).
- **Nessuna migrazione:** le versioni della web app hanno `device_id` nullo; il journal (colonna non nulla) usa l'UUID nullo `WEB_AUTHOR`.
- **A8:** il flag `features.historyWrites` è stato rimosso del tutto.

### M3b — client (sync-core, motore, plugin)

| # | Decisione |
|---|---|
| B1 | sync-core: azione di risoluzione del lato perdente → effetti (upload dell'eventuale contenuto, poi `resolve`); il `conflictId` si toglie solo dopo la conferma del server |
| B2 | `conflict_resolved` ricevuto (risolto altrove), i tre casi di 03 §9.3: copia locale = versione scelta → allineato; = candidata già sul server → scarica la testa; altrimenti **prima** carica la copia locale come file affiancato, poi scarica. Test di proprietà nel simulatore: nessun contenuto locale sparisce mai, anche con crash in mezzo |
| B3 | Motore: `resolve()`, dettaglio conflitto con "la mia" = copia locale più recente e "in arrivo" = testa del server; `stale_resolution` → aggiorna e rimostra |
| B4 | Plugin: `SyncStateSource`/`ConflictActions` veri al posto di `FakeSyncState` quando il motore c'è; risoluzione in blocco con gli stessi id visti |

**Test:** unità e proprietà in sync-core (`test:deep` in CI), motore contro il server vero (`engine-*.test.ts`): conflitto su due dispositivi, risolto dal plugin e dalla web app.

## Fuori

Merge automatico a 3 vie (1.1), ripristino dallo storico dal plugin (dopo la 1.0), anteprime dei binari.
