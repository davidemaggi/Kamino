# 06 — Roadmap

> Stato: **proposta** (2026-11-06). Milestone indicative, senza date: ognuna si chiude quando i suoi criteri di uscita sono verificati.
> Ogni milestone ha un piano di implementazione dettagliato in `docs/superpowers/plans/`, scritto all'inizio della milestone (non prima: i piani successivi dipendono da ciò che M0 scopre con gli spike).
> Tutte le release fino alla `1.0.y` si chiamano **Ash** ([release-names](release-names.md)).

## Panoramica

```
M0 Fondamenta + spike ──▶ Fase UI ──▶ M1 Sync 1 dispositivo ──▶ M2 Multi-dispositivo ──▶ M3 Conflitti + storico
                                                                                                   │
                     M7 Hardening + 1.0 ◀── M6 QR/link ◀── M5 Admin, quote, email ◀── M4 Web utente ◀┘
```

## M0 — Fondamenta e spike

**Obiettivo:** un monorepo che compila, testa e si rilascia; un server che parte solo con la master key giusta; risposte ai rischi tecnici R-1…R-5.

- Monorepo pnpm + Turborepo, TypeScript strict, ESLint, Prettier, Vitest.
- `packages/brand`, `packages/protocol` (versione protocollo, catalogo errori, negoziazione).
- Release: changesets `fixed`, commitlint, `release-names.json` con controllo in CI.
- `apps/server`: config (env + `_FILE`, sorgente di ogni valore), Fastify, `/health/live`, `/health/ready`, `/version`, log pino con redazione, Drizzle + migrazioni con advisory lock, caricamento e **verifica della master key** all'avvio, CLI (`migrate`, `keys generate`, `keys verify`).
- `apps/web` e `apps/plugin`: scheletri che mostrano versione e nome in codice.
- Dockerfile + compose per i tre scenari (LAN desktop, tunnel, Caddy).
- CI GitHub Actions.
- `CLAUDE.md`, `docs/renaming.md`.
- **Spike R-1…R-5** (prototipi usa e getta su dispositivi reali) con esiti in `docs/spikes/`.

**Uscita:** `docker compose up` avvia `kamino` + Postgres, `/health/ready` è verde, il server rifiuta di partire senza chiave o con chiave sbagliata; CI verde; esiti degli spike documentati e, se necessario, ADR aggiornate.

## Fase UI — Design system e schermate

**Obiettivo:** design system e layout delle schermate prima di costruire qualsiasi UI.

- Con **UI/UX Pro Max**: design system (token, palette chiaro/scuro, tipografia, spaziature), layout delle schermate web e plugin elencate nel kickstart.
- Con **impeccable**: critica e rifinitura.
- Output in `docs/ui/` + token pronti per Tailwind/shadcn e per il CSS del plugin (variabili Obsidian dove possibile).
- Priorità di copertura: pannello di stato sync del plugin e risoluzione conflitti (sono il cuore della promessa), poi onboarding/collegamento, poi web.

**Uscita:** schermate approvate dal committente.

Scomposizione (2026-11-07), ogni sotto-fase con spec → piano → implementazione → approvazione:

1. Fondamenta del design system: [spec](superpowers/specs/2026-11-07-ui-fondamenta-design.md), [design system](ui/design-system.md).
2. Plugin: pannello di stato sync e risoluzione conflitti.
3. Onboarding e collegamento (plugin e web, QR).
4. Web app: login/2FA, dashboard, vault, dispositivi, centro conflitti, account, admin.

Nota: le skill UI/UX Pro Max e impeccable sono installate (verificato il 2026-11-07).

## M1 — Sync con un dispositivo

**Obiettivo:** un vault va sul server e torna indietro intatto.

- `crypto` completo: DEK per vault, sottochiavi HKDF, cifratura dei campi, AEAD a segmenti per i blob, HMAC.
- Auth di base: setup del primo utente (token nei log), login, Argon2id, `device-login`, token dei dispositivi.
- Vault, file, versioni, journal, blob (storage fs + S3), sessioni di upload a chunk, commit con le regole di [03 §5](03-sync-protocol.md), idempotenza.
- Plugin: onboarding vault (Jango), scanner incrementale, watcher con debounce, outbox durevole, upload iniziale con avanzamento e ripresa, indicatore di stato **"mai silenzioso"** (S-05) e "tutto al sicuro".
- Ricostruzione del server da un dispositivo (V-05): è l'onboarding su un server vuoto.
- `sync-core`: normalizzazione path, collisionKey, planner, test di proprietà.

**Uscita:** onboarding di un vault da 5.000 file; kill del client e del server in punti casuali durante l'upload senza perdite; il plugin mostra correttamente lo stato in assenza di server.

## M2 — Multi-dispositivo in tempo reale

- WebSocket (hello/welcome/changes/ack/status), fan-out con LISTEN/NOTIFY, catch-up, snapshot, `cursor_too_old`, compattazione del journal.
- Applicazione lato client, soppressione dell'eco, scritture atomiche, path non rappresentabili.
- Modalità Live / Periodica / Manuale; ciclo di sync all'avvio e al resume.
- Collegamento manuale di un secondo dispositivo; riconciliazione con contenuto locale (D-07).
- Stato di sync per dispositivo sul server (S-06), elenco/rinomina/revoca dispositivi dal plugin.
- Categorie della cartella di configurazione ed esclusioni con default di vault e override (S-10…S-13).
- Allegati grossi solo in Wi-Fi; iOS sempre a consumo (S-08).
- Test di integrazione multi-client (rete che perde, duplica e riordina; crash).

**Uscita:** due desktop e un telefono restano allineati per una settimana di uso reale; test di convergenza verdi.

## M3 — Conflitti e storico

- Rilevamento (`concurrent_edit`, `both_created`), candidate, regole automatiche (C-06).
- `packages/ui-diff` su `@codemirror/merge`; risoluzione nel plugin (tieni mia / in arrivo / entrambe / merge manuale), risoluzione in blocco.
- Caricamento della copia locale prima di applicare una risoluzione remota (03 §9.3).
- Cestino 7 giorni, storico 0–90 giorni, retention, GC dei blob, job pg-boss.

**Uscita:** suite di scenari di conflitto (03 §14) verde; nessun caso in cui una modifica sparisce.

## M4 — Web app utente

- Login, TOTP + codici di recupero, sessioni, impostazioni account, **registro di sicurezza** (U-16).
- Dashboard: vault, dispositivi e stato, uso quota.
- Centro conflitti con diff, storico e cestino con ripristino.
- **Download ZIP** del vault, anche alla data X.
- Tema chiaro/scuro/sistema, i18n it/en, pagina "Informazioni".
- Playwright sui flussi principali.

## M5 — Admin, quote, email

- Gestione utenti: creazione con **link di attivazione**, inviti, blocco/sblocco, cancellazione con ZIP via email e crypto-shredding.
- Reset avviato dall'admin visibile all'utente.
- Quote (riserva, esenzioni di Q-03, stato "spazio esaurito" nel plugin).
- Configurazione di sistema con precedenza "ambiente vince" e campi bloccati in UI.
- **SMTP** (tutte le modalità, test), template email localizzati, reset password via email, outbox.
- Salute del sistema e metriche aggregate, audit log, test "l'admin non vede contenuti".

## M6 — Collegamento con QR e magic link

- Pairing con token monouso, codice di verifica, approvazione da dispositivo o web.
- Protocol handler `obsidian://`, QR nel plugin e nella web app, invio del link via email.
- Guida nel plugin quando il vault di destinazione non è vuoto.

**Uscita:** un collega collega il telefono senza aiuto (test con una persona reale).

## M7 — Hardening e prima release

- Revisione del threat model, rate limiting, CSP, test di autorizzazione completi, `pnpm audit`.
- `kamino keys rotate`, `kamino backup create` / `verify`, ripristino testato in CI.
- Prestazioni su vault da 10.000 file, consumo di batteria su mobile.
- Documentazione per chi fa self-hosting: i tre scenari di rete, custodia della master key, backup.
- Plugin distribuito via BRAT; **scelta del nome pubblico** prima dell'invio allo store (vedi [02 §9](02-architecture.md)).
- Release **1.0.0 "Ash"**.

## Dopo la 1.0

Merge automatico a 3 vie (1.1, primo nome con la A), notifiche email (dispositivo fermo, conflitti vecchi, quota), ripristino dallo storico dal plugin, passkey/OIDC.
