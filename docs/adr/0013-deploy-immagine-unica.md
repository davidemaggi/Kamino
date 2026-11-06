# ADR-0013 — Deploy: immagine unica + Postgres

**Stato:** Accettata (2026-11-06)

## Contesto
`docker compose up` deve bastare; istanza singola; immagini piccole.

## Decisione
- Un'immagine `kamino` che contiene server, worker dei job, CLI e web app statica (servita da Fastify). Stessa origine per web e API: cookie semplici, niente CORS.
- Postgres come secondo container.
- Storage dei blob con adattatore: **filesystem** (volume, default) o **S3-compatibile** (MinIO, AWS, ecc.) via configurazione.
- TLS a carico di un reverse proxy; il compose di esempio include Caddy opzionale.

## Alternative
- **Container separato per la web app (nginx)**: utile solo con CDN o domini separati; complica il deploy.
- **Worker in container separato**: utile per scalare; oggi superfluo (stessa immagine, si potrà avviare con un flag `--role=worker`).

## Conseguenze
- Il processo unico deve gestire bene lo shutdown (drain delle connessioni WS, completamento dei job in corso).
