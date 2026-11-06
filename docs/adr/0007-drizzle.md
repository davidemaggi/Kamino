# ADR-0007 — Drizzle ORM

**Stato:** Accettata (2026-11-06)

## Contesto
Serve un accesso a Postgres tipizzato, con controllo fine sulle transazioni (lock sulla riga del vault, indici parziali, `LISTEN/NOTIFY`) e migrazioni automatiche all'avvio.

## Decisione
Drizzle ORM + drizzle-kit. Migrazioni SQL versionate nel repo, applicate all'avvio sotto advisory lock. Query complesse in SQL esplicito tramite il query builder.

## Alternative
- **Prisma**: ottima DX, ma motore separato, controllo meno diretto sull'SQL e sulle transazioni, immagine più pesante.
- **Kysely**: ottimo query builder, ma niente gestione dello schema e delle migrazioni integrata.
- **SQL puro (postgres.js)**: massimo controllo, nessuna tipizzazione dello schema.

## Conseguenze
- Le migrazioni devono essere sempre compatibili in avanti di una versione (deploy senza downtime non richiesto, ma rollback dell'immagine sì) — da definire nelle convenzioni.
