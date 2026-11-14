# ADR-0018 — Cartella di configurazione: vince l'ultima scrittura

**Stato:** Accettata (2026-11-14)

## Contesto
Con le categorie della cartella di configurazione attive (`{config}/…`), Obsidian riscrive da solo file come `app.json`, `core-plugins.json` e `community-plugins.json` su ogni dispositivo, ciascuno con il proprio stato in memoria. Ogni riscrittura su una base vecchia apriva un conflitto `concurrent_edit`. Risolto un conflitto, il successivo salvataggio di Obsidian ne apriva un altro (rc.8–rc.9, su tutti i dispositivi). Chiedere all'utente di scegliere tra due versioni di un file di impostazioni che non ha toccato non serve.

## Decisione
- Una `put` su un file `{config}/…` con base vecchia **diventa la versione corrente** invece di aprire un conflitto. La versione che sostituisce resta nello storico e si può ripristinare (C-02: nulla si butta).
- Una `put` di un file nuovo `{config}/…` su un percorso già occupato diventa una versione del file esistente. L'esito porta il `fileId` di quel file e il client lo adotta.
- Un conflitto aperto su quel file (nato prima di questa regola) si chiude con la nuova versione (`conflict_resolved`).
- Per qualunque percorso: una `put` con lo stesso contenuto della versione corrente non è un conflitto. È accettata come quella versione (nessuna versione nuova, `versionId` = corrente), anche per un file nuovo sullo stesso percorso.
- Le note e gli allegati non cambiano: aprono ancora un conflitto.
- La sincronizzazione della cartella di configurazione è segnata **Beta** nel plugin e nella web app.

## Alternative
- **Chiedere sempre**: i conflitti si ripresentano a ogni salvataggio di Obsidian.
- **Merge dei JSON**: non sempre sensato (liste ordinate, valori in conflitto) e diverso per ogni plugin.

## Conseguenze
- Modifica le regole 2 e 5 di `put` in `03-protocollo-sync.md` §5.3, solo per `{config}/…` e per il contenuto identico.
- Il simulatore conta come "non perso" il contenuto sostituito in un file di configurazione, perché resta tra le versioni.
