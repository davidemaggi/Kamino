# ADR-0004 — Sync a file intero con identità stabile

**Stato:** Accettata (2026-11-06)

## Contesto
La priorità è non perdere mai dati e rilevare i conflitti in modo affidabile. Le rinomine e gli spostamenti sono frequenti in Obsidian e non devono far perdere lo storico né forzare il ricaricamento degli allegati.

## Decisione
- L'unità di sync è il **file intero**: ogni versione è un contenuto completo identificato dal suo SHA-256.
- Ogni file/cartella ha un **`fileId`** (UUIDv7 generato dal client) stabile per tutta la vita; le rinomine sono operazioni `move`, non cancellazione + creazione.
- Ogni modifica dichiara la propria **base** (`baseVersionId`).
- Modello dei path **piatto** (path completo per file), non ad albero con `parentId`.

## Alternative
- **Delta/patch**: meno banda per file di testo grandi, ma molta più complessità e superficie di bug. Le note sono piccole; gli allegati sono binari e non beneficiano di delta testuali.
- **Identità = path**: semplice, ma le rinomine diventano cancellazione + creazione, perdendo storico e causando conflitti spuri.
- **Modello ad albero**: rinomina di cartella O(1), ma conflitti più complessi (cicli, genitori cancellati). Con il modello piatto lo spostamento di una cartella è un batch di `move`, accettabile per vault da migliaia di file.

## Conseguenze
- Il client deve generare e conservare gli ID: la perdita dello stato locale si recupera con la riconciliazione per hash.
- La base salvata abilita il merge a 3 vie futuro senza modifiche al protocollo.
- Uno spostamento di cartella grande produce molte voci di journal: va testato (rischio R-5).
