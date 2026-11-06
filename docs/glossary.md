# Glossario

Il lessico a tema Star Wars si usa **solo** in codice, log, commenti ed easter egg. I testi dell'interfaccia usano sempre la colonna "Termine in UI".

## Lessico a tema

| Termine a tema | Termine tecnico (codice) | Termine in UI (it) | Termine in UI (en) |
|---|---|---|---|
| *Kamino* | nome in codice del prodotto (`brand.PRODUCT_NAME`) | nome pubblico (da definire) | public name (TBD) |
| *clone* | `device` — copia del vault su un dispositivo | dispositivo | device |
| *Jango* | `device.is_origin` — il dispositivo che ha fatto l'onboarding del vault | dispositivo originale | original device |
| *Ordine 66* | conflitto o errore grave che richiede intervento manuale (`severity: critical`, codici `*_requires_action`) | conflitto da risolvere / errore di sincronizzazione | conflict to resolve / sync error |
| *Kaminoani* | utenti con `role = admin` | amministratori | administrators |
| *archivi Jedi* | storico versioni (`file_versions`, `history`) — "se non è negli archivi, non esiste" | cronologia versioni | version history |

## Termini tecnici

| Termine | Significato | UI (it) |
|---|---|---|
| vault | cartella di note Obsidian sincronizzata | vault |
| journal | registro append-only delle modifiche di un vault, ordinato per `seq` | — |
| `seq` / head | numero progressivo delle voci del journal / ultimo numero assegnato | — |
| cursore | ultimo `seq` applicato e confermato da un dispositivo | (mostrato come "ritardo") |
| `fileId` | identità stabile di un file, invariata nelle rinomine | — |
| versione | un contenuto completo di un file, con la sua base | versione |
| base | la versione da cui una modifica è partita | — |
| tombstone | versione che marca un file cancellato | — |
| cestino di sicurezza | conservazione obbligatoria di 7 giorni di file cancellati/sovrascritti | cestino |
| conflitto | modifica partita da una base non più corrente | conflitto |
| candidata | versione perdente di un conflitto, conservata | versione dell'altro dispositivo / la tua versione |
| outbox | coda locale durevole di operazioni non confermate | modifiche in attesa |
| pairing | collegamento di un nuovo dispositivo via QR/link | collega un dispositivo |
| codice di verifica | 4 caratteri mostrati su entrambi i dispositivi durante il pairing | codice di verifica |
| config dir | cartella di configurazione di Obsidian (`.obsidian` di default), `{config}/` nel protocollo | impostazioni di Obsidian |
| KEK / master key | chiave principale fornita a runtime, mai nel DB | chiave principale |
| DEK | chiave dati di un vault, cifrata con la KEK | — |
| crypto-shredding | cancellazione rendendo inutilizzabile la chiave che cifra i dati | — |
| modalità Live / Periodica / Manuale | modalità di sync per dispositivo | Live / Periodica / Manuale |
| rete a consumo | rete su cui gli allegati grossi richiedono conferma o vengono rimandati | rete a consumo |
| nome in codice | nome di una release MAJOR/MINOR (vedi [release-names.md](release-names.md)) | nome in codice |
