# ADR-0001 — Registrare le decisioni architetturali

**Stato:** Accettata

## Contesto
Il progetto sarà sviluppato in larga parte con agenti AI e verrà pubblicato. Servono decisioni tracciabili, con il loro perché, per evitare di ridiscuterle e per poterle cambiare consapevolmente.

## Decisione
Ogni decisione rilevante (tecnologia, protocollo, sicurezza, modello dati, processo) ha una ADR in `docs/adr/`, numerata, in italiano, nel formato contesto → decisione → alternative → conseguenze. Le ADR accettate sono immutabili; i cambi di rotta producono una nuova ADR che sostituisce la precedente.

## Conseguenze
- `CLAUDE.md` istruirà gli agenti a consultare le ADR prima di proporre cambiamenti strutturali.
- Il costo è basso: una ADR è una pagina.
