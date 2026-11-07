# 00 — Visione

> Stato: **approvato** (2026-11-06) · Nome in codice: **Kamino** (nome pubblico da definire al rilascio)

## Il problema

Chi usa Obsidian su più dispositivi (desktop + mobile) e vuole tenere i propri dati in casa oggi ha alternative insoddisfacenti:

- **Git**: su iOS è a pagamento, su Android funziona male, e non è pensato per chi scrive note.
- **Plugin di sync esistenti**: configurazione complicata e piena di parametri oscuri; nella gestione dei conflitti non si capisce cosa sta arrivando né si può decidere.
- **Fallimenti silenziosi**: il caso che ha originato il progetto. Il server di sync ha smesso di funzionare senza che nessuno se ne accorgesse; dopo una reinstallazione di Windows il vault non era recuperabile ed è andato perso.

## La promessa

> **Non perdi mai niente, e sai sempre se sei al sicuro.**

Kamino è un sistema self-hosted che sincronizza i vault Obsidian tra dispositivi, composto da un plugin Obsidian (desktop + mobile), un backend containerizzato e una web app.

Ciò che lo distingue:

1. **Nessun fallimento silenzioso.** Ogni dispositivo mostra sempre quando ha sincronizzato l'ultima volta e quante modifiche non hanno ancora raggiunto il server; oltre una soglia l'avviso diventa insistente. "Sincronizzato" significa *confermato come salvato in modo durevole dal server*.
2. **Conflitti trasparenti.** Quando due dispositivi modificano la stessa nota, vedi cosa sta arrivando, lo confronti con la tua versione e decidi: la tua, quella in arrivo, o entrambe. Direttamente nel plugin, oppure dalla web app. Nessuna versione viene mai scartata.
3. **Configurazione banale.** Un nuovo dispositivo si collega con un QR o un link, confermato dal dispositivo che l'ha generato.
4. **Vie d'uscita sempre aperte.** Cestino di sicurezza, storico versioni, download del vault in ZIP dalla web app (anche "com'era a una certa data"), ricostruzione del server a partire da un dispositivo.
5. **Sync quasi istantaneo** sui dispositivi connessi, con modalità più parsimoniose per chi vuole risparmiare batteria.
6. **Privacy rispetto all'amministratore.** Più utenti sullo stesso server; l'amministratore gestisce utenti e quote ma non vede né contenuti né struttura dei vault. I dati sono cifrati a riposo: un dump del database o dello storage da solo è inutile.

## Per chi

- **Primo anno:** l'autore e qualche collega, su un'unica istanza self-hosted.
- **In seguito:** pubblicazione per altri self-hoster. Per questo la qualità è "da prodotto pubblico" fin da subito: i18n (it/en), regole dello store dei plugin Obsidian, release versionate con nome in codice, nome del prodotto facilmente sostituibile.

## Successo

- Un collega installa il plugin e collega il telefono **senza chiedere aiuto**.
- Nessuna modifica va persa, in nessuno scenario di crash, rete instabile, dispositivo offline per settimane, reinstallazione.
- Prima di formattare un PC, l'utente può verificare a colpo d'occhio che quel dispositivo è "tutto al sicuro".
- Un conflitto si risolve in pochi secondi capendo esattamente cosa si sta scegliendo.

## Anti-obiettivi (fallimento anche se "funziona")

- Perdere anche una sola modifica, o sovrascriverla senza che l'utente lo sappia.
- Un sync che smette di funzionare senza che nessuno se ne accorga.
- Un amministratore che, dall'interfaccia o dalle API, riesce a leggere nomi o contenuti delle note altrui.
- Una configurazione che richiede di capire come funziona il sistema internamente.

## Non-obiettivi (per ora)

- Scalabilità orizzontale: un'istanza singola basta. Si evita solo di fare scelte che la renderebbero impossibile.
- Crittografia end-to-end: è accettato che chi gestisce l'infrastruttura e possiede la master key possa tecnicamente decifrare.
- Merge automatico delle modifiche concorrenti (previsto in una versione successiva; il protocollo è già predisposto).
- Editing collaborativo in tempo reale (CRDT): possibile evoluzione futura, vedi [ADR-0005](adr/0005-conflitti-v1-rileva-e-scegli.md).
- Login con provider esterni (OIDC), passkey: non in v1.
- Sync in background su mobile ad app chiusa: non è consentito dalla piattaforma.

## Documenti correlati

[01 Requisiti](01-requirements.md) · [02 Architettura](02-architecture.md) · [03 Protocollo di sync](03-sync-protocol.md) · [04 Threat model](04-security-threat-model.md) · [05 Modello dati](05-data-model.md) · [Glossario](glossary.md) · [Nomi delle release](release-names.md) · [ADR](adr/)
