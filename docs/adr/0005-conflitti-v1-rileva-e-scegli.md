# ADR-0005 — Conflitti in v1: rileva e fai scegliere

**Stato:** Accettata (2026-11-06)

## Contesto
Il committente vuole, davanti a un conflitto, "vedere cosa sta arrivando e decidere se tenere quello o il mio". Il merge automatico è "bello ma non prioritario". La direzione iniziale del kickstart prevedeva il 3-way merge lato server quando possibile.

## Decisione
In v1:
- il server **rileva** il conflitto (base non corrente) e **conserva tutte le versioni**;
- l'utente **sceglie** nel plugin o nella web app: tieni la mia, tieni quella in arrivo, tieni entrambe, oppure merge manuale nella vista di diff;
- poche regole automatiche che non perdono dati (modifica batte cancellazione, primo spostamento vince, suffissi per path occupati).

Il merge automatico a 3 vie è rinviato. La base di ogni versione è sempre salvata, quindi aggiungerlo non richiede modifiche al modello dati né al protocollo (un nuovo esito `merged`).

## Alternative
- **3-way merge automatico lato server in v1**: meno interruzioni, ma rischio di merge "silenziosamente sbagliati" su markdown (frontmatter YAML, tabelle, liste), contro la promessa di trasparenza.
- **CRDT (Yjs)**: niente conflitti per il testo, ma richiede integrazione profonda con l'editor di Obsidian, stato CRDT persistito per ogni documento, gestione dei file modificati fuori da Obsidian e un canale per documento. Costo alto, valore basso per un utente con più dispositivi.
- **Last-writer-wins**: semplice e inaccettabile (perde dati).

## Conseguenze
- Più conflitti visibili rispetto a un sistema con merge automatico: la UX di risoluzione è critica e va progettata con cura (fase UI).
- Servono la risoluzione in blocco per i casi di riconciliazione massiva.
