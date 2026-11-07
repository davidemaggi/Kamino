# ADR-0008 — pg-boss per i job in background

**Stato:** Accettata (2026-11-06)

## Contesto
Job necessari: garbage collection dei blob, retention, pulizia upload, export ZIP, finalizzazione cancellazioni, invio email, ricalcolo quote. Volumi bassi.

## Decisione
pg-boss, che usa Postgres come coda. I job possono essere accodati nella stessa transazione della modifica che li genera.

## Alternative
- **BullMQ + Redis**: più potente e con dashboard, ma aggiunge Redis al deploy e perde la transazionalità con il DB.

## Conseguenze
- Nessun servizio in più nel `docker compose`.
- Se in futuro i volumi crescessero molto, migrare a BullMQ è isolato nel modulo `jobs`.
