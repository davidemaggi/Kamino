# ADR-0019 — Sincronizzazione forzata da un dispositivo

**Stato:** Accettata (2026-11-14)

## Contesto
Se un dispositivo si disallinea in modo che la sync normale non riesce a correggere (conflitti che non si chiudono, file che non convergono), l'utente vuole dire: "questo dispositivo ha ragione, gli altri si adeguino". Le regole normali (base, conflitti) lo impediscono di proposito.

## Decisione
- L'utente sceglie, dalla web app o dal plugin, un **dispositivo sorgente** e uno o più **dispositivi destinazione** della stessa vault. Il server registra la richiesta e scrive nel journal un evento `force_push` indirizzato alla sorgente (`fileId` = id della richiesta, `deviceId` = dispositivo a cui è rivolto, `ignorable`).
- **Sorgente** (alla prossima connessione, dopo aver letto l'evento): invia come `put` con `force: true` ogni file locale il cui contenuto differisce dalla versione corrente del server (o che il server non ha). Una `put` forzata vince sempre: diventa la versione corrente, quella sostituita resta nello storico, un conflitto aperto sul file si chiude. Finito, conferma al server, che scrive un evento `realign` per ogni destinazione.
- **Destinazioni** (alla prossima connessione): dimenticano l'indice locale e si ri-agganciano al server come un dispositivo nuovo. Un file locale diverso da quello del server sullo stesso percorso viene prima caricato con una `put` `archive: true` (diventa una versione dello storico, **non** la corrente), poi sovrascritto con quello del server. I file presenti solo sulla destinazione restano e salgono come file nuovi. Finito, la destinazione conferma al server.
- I file presenti sul server ma non sulla sorgente restano: le destinazioni si allineano al server, che per i file della sorgente è identico alla sorgente.
- La web app mostra lo stato dell'ultima richiesta (in attesa della sorgente, in attesa di quali destinazioni, completata).

## Alternative
- **Copia diretta dispositivo→dispositivo**: richiede che siano online insieme; il server è già il punto d'incontro.
- **Destinazioni identiche alla sorgente (cancellando i file in più)**: scartata, perde dati senza che l'utente l'abbia chiesto.
- **Riallineare con conflitti risolti in automatico**: un file modificato sulla destinazione con base aggiornata diventerebbe la versione corrente, contro l'intenzione.

## Conseguenze
- `PutOp` ha due campi opzionali, `force` e `archive`; il journal due tipi nuovi ignorabili. Additivo: `PROTOCOL_VERSION` non cambia.
- Nulla si perde: ogni contenuto sostituito (sul server o su una destinazione) resta nello storico.
- Un dispositivo che rientra dal snapshot (journal compattato) non vede gli eventi persi: la richiesta resta in attesa e si può ripetere.
