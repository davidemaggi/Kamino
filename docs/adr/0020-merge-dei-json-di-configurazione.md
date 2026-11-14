# ADR-0020 — JSON di configurazione: merge con la vista di Obsidian

**Stato:** Accettata (2026-11-14). Sostituisce in parte [ADR-0018](0018-configurazione-vince-l-ultimo.md): l'alternativa "merge dei JSON" lì scartata.

## Contesto
Obsidian e i suoi plugin tengono in memoria la configurazione e riscrivono l'intero file da lì. Con la rc.10 un plugin attivato sul Mac (Excalidraw) è arrivato su iOS insieme a `community-plugins.json`. Poi Obsidian su iOS ha riscritto l'elenco che aveva in memoria dall'avvio, senza il plugin nuovo. Con "vince l'ultima scrittura" quell'elenco vecchio è diventato la versione corrente. Un merge a tre vie sulla base del sync non basta: per il sync quella scrittura toglie davvero il plugin.

## Decisione
- La base giusta è **la versione che Obsidian conosce**. Il plugin la ricorda per ogni file `.json` della cartella di configurazione (dimensione massima 1 MB) che il sync sovrascrive durante la sessione. La vista è il contenuto su disco subito prima della prima scrittura del sync, cioè quello che Obsidian ha letto all'avvio o scritto per ultimo. Le scritture del sync non la cambiano.
- Quando la scansione trova un file così riscritto da Obsidian, il plugin fa un merge a tre vie: base = la vista, nostra = quello che Obsidian ha scritto, loro = l'ultima versione scritta dal sync. Il risultato va su disco e da lì segue il percorso normale verso il server. La vista diventa quello che Obsidian ha scritto.
- Regole del merge (`mergeJson3` in sync-core):
  - oggetti chiave per chiave, in profondità;
  - liste di nomi (stringhe, numeri, booleani) come insiemi, con le aggiunte e le rimozioni di entrambi;
  - un valore cambiato da entrambi: vince la scrittura locale, come prima;
  - un risultato uguale a "loro" rimette il loro testo identico, così nessuna versione nuova parte;
  - un risultato uguale a "nostra" lascia il file com'è.
- Se il file non è JSON valido o supera 1 MB, resta "vince l'ultima scrittura" (ADR-0018).
- Al riavvio di Obsidian il plugin si ricarica e la vista si azzera, perché Obsidian ha riletto i file.
- Il server, il protocollo e le regole dell'arbitro non cambiano. Ogni versione sostituita resta nello storico.

## Alternative
- **Merge con la base del sync**: rispetta la rimozione involontaria (vedi Contesto).
- **Unione senza base**: un plugin disattivato tornerebbe sempre.
- **Merge sul server**: il server non sa cosa Obsidian ha in memoria.

## Conseguenze
- Se il plugin viene disattivato e riattivato senza riavviare Obsidian, la vista si perde: per quel file resta "vince l'ultima scrittura".
- Dopo un merge che porta contenuti nuovi, il plugin propone di ricaricare Obsidian (S-12).
