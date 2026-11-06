# Kamino

Sistema di sincronizzazione self-hosted per vault Obsidian (server, web UI e plugin), con cifratura end-to-end. Monorepo pnpm + Turborepo: `apps/server`, `apps/web`, `apps/plugin`, `packages/*`.

## Documentazione

- [Visione](docs/00-vision.md)
- [Requisiti](docs/01-requirements.md)
- [Architettura](docs/02-architecture.md)
- [Protocollo di sincronizzazione](docs/03-sync-protocol.md)
- [Sicurezza e threat model](docs/04-security-threat-model.md)
- [Modello dati](docs/05-data-model.md)
- [Roadmap](docs/06-roadmap.md)
- [Glossario](docs/glossary.md)
- [Nomi di release](docs/release-names.md)
- [ADR](docs/adr/)

## Sviluppo

Richiede Node >= 22.12 e pnpm 10.

```
pnpm install
pnpm build | typecheck | lint | test | format
```
