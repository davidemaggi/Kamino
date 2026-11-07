# ADR-0011 — Versione di prodotto unica e protocollo versionato a parte

**Stato:** Accettata (2026-11-06)

## Contesto
SemVer 2.0.0 rigoroso, Conventional Commits, CHANGELOG automatico, release automatizzate, nomi in codice per MAJOR/MINOR. Plugin e server vengono aggiornati in momenti diversi (store di Obsidian vs chi gestisce il server).

## Decisione
- **Un'unica versione di prodotto** per server, web app e plugin, gestita con **changesets** in modalità `fixed`. I pacchetti interni (`packages/*`) sono privati.
- **Protocollo con numero intero** separato (`PROTOCOL_VERSION`), incrementato solo per cambiamenti incompatibili; negoziazione del range alla connessione; il server supporta almeno la versione corrente e la precedente.
- Commit secondo Conventional Commits, verificati in CI (commitlint).
- Lo script di release aggiorna `manifest.json` e `versions.json` del plugin, associa il nome in codice da `release-names.json` e lo inserisce in titolo della release, CHANGELOG ed endpoint `/version`.
- Tag Docker numerici (`X.Y.Z`, `X.Y`, `X`, `latest`).

## Alternative
- **semantic-release**: pensato per un pacchetto per repo; nei monorepo richiede plugin di terze parti e deriva la versione solo dai commit.
- **Versioni separate per componente**: più precise, ma la matrice di compatibilità diventa un problema per gli utenti; la compatibilità reale è comunque decisa dal protocollo.

## Conseguenze
- Una release del solo plugin incrementa anche la versione del server (che non cambia): accettato.
- La compatibilità non si deduce mai dal numero di versione di prodotto, solo dal protocollo.
