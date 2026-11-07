# ADR-0006 — Fastify come framework server

**Stato:** Accettata (2026-11-06)

## Contesto
Server Node + TypeScript con API REST, WebSocket, upload binari in streaming e schemi condivisi in zod.

## Decisione
Fastify con `fastify-type-provider-zod` (gli schemi di `packages/protocol` validano e tipizzano direttamente richieste e risposte), `@fastify/websocket`, `@fastify/static` per la web app, `@fastify/rate-limit`, `@fastify/cookie`. Architettura a moduli con servizi espliciti; le rotte sono adattatori sottili.

## Alternative
- **NestJS**: moduli e dependency injection pronti, utile con team grandi; più cerimonia e validazione basata su classi che si sovrappone a zod.
- **Hono / Express**: Hono è ottimo ma con ecosistema Node meno maturo per streaming e WS; Express è datato e lento.

## Conseguenze
- La struttura modulare va mantenuta per disciplina (convenzioni in `CLAUDE.md`, test di architettura sulle import), non imposta dal framework.
