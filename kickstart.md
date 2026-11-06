# Kickstart — Kamino (nome in codice)

## Il tuo ruolo e come lavoreremo

Sei il tech lead e architetto di questo progetto. Questa prima fase è di **definizione**: NON scrivere codice applicativo finché non avrò approvato design tecnico e roadmap.

Workflow obbligatorio:

1. Usa la skill **superpowers** di brainstorming: fammi domande **una alla volta**, proponi alternative con pro/contro, sfida le mie assunzioni quando ti sembrano deboli.
2. Man mano che le decisioni si consolidano, scrivile nei documenti in `docs/` (vedi "Deliverable").
3. Quando il design è approvato, usa superpowers per scrivere il piano di implementazione e la roadmap a milestone.
4. Solo dopo il design tecnico, fase UI: usa **UI/UX Pro Max** per definire design system, palette (tema chiaro/scuro), tipografia e layout delle schermate; usa **impeccable** per criticare e rifinire le proposte. Le schermate da progettare sono elencate sotto.
5. Durante l'implementazione: TDD, piccoli commit, piani eseguiti a step.

## Visione

Un sistema self-hosted per sincronizzare i vault Obsidian tra più dispositivi (desktop e mobile), composto da:

- un **plugin Obsidian** (desktop + mobile);
- un **backend** containerizzato che orchestra il sync;
- una **web app** con dashboard di monitoraggio, gestione dispositivi e risoluzione conflitti.

## Nome e lessico interno

"Kamino" è il **nome in codice** (il pianeta di Star Wars dove vengono creati i cloni): usalo per repo, package (`@kamino/*`), immagini Docker e variabili d'ambiente (`KAMINO_*`), ma tieni il nome facilmente sostituibile (costante unica / config), perché il nome pubblico potrebbe cambiare al rilascio per evitare problemi di marchio.

Lessico a tema da usare **solo in codice, log, commenti ed easter egg**, mai nei testi dell'interfaccia utente (che devono restare chiari e comprensibili):

- *clone* = copia del vault su un dispositivo;
- *Jango* = il dispositivo che ha fatto l'onboarding iniziale del vault (template originale);
- *Ordine 66* = conflitto o errore di sync grave che richiede intervento manuale;
- *Kaminoani* = gli amministratori del sistema;
- *archivi Jedi* = lo storico versioni ("se non è negli archivi, non esiste").

Documenta il glossario (termine a tema → termine tecnico → termine in UI) in `docs/glossary.md`.

## Versionamento e nomi delle release

**Semantic Versioning 2.0.0** rigoroso (`MAJOR.MINOR.PATCH`), con Conventional Commits, CHANGELOG generato automaticamente e release automatizzate (valuta changesets o semantic-release). Proponi se usare un'unica versione di prodotto allineata per server, web app e plugin (consigliato, semplifica la compatibilità) o versioni separate, e definisci come si dichiara la compatibilità del protocollo tra plugin e server. Il plugin deve rispettare le regole Obsidian su `manifest.json` e `versions.json`.

Ogni versione MAJOR e MINOR ha un **nome in codice** preso da un clone famoso (fantascienza, fumetti, cinema, videogiochi, o anche reali):

- l'iniziale del nome corrisponde alla MAJOR: A, poi B, poi C, e così via;
- un cambio di MINOR mantiene la lettera ma cambia nome;
- un cambio di PATCH non cambia nome;
- **eccezione:** tutte le versioni `0.x.y` e la `1.0.y` si chiamano **"Ash"** (dalla saga di Alien);
- la regola standard parte da `1.1.0`: ogni minor della 1.x prende un nuovo nome con la A, poi `2.0.0` passa alla lettera B.

Esempi di candidati da cui partire (da verificare e ampliare): A → Alison (Orphan Black), Appo, Alpha-17 (cloni di Star Wars), B → Boba (clone di Jango Fett), C → Cody, D → Dolly (la pecora clonata), E → Echo, F → Fives, H → Hunter, L → Lincoln Six Echo (The Island), M → Mewtwo, O → Omega, R → Rex / Ripley 8, S → Sam Bell (Moon), T → Tech, W → Wrecker, X → X-23.

Mantieni il registro in `docs/release-names.md` (versione → nome → data → note): un nome non va mai riutilizzato. Il nome in codice compare nel titolo della release, nel CHANGELOG, nella pagina "Informazioni" della web app, nelle impostazioni del plugin e nell'endpoint `/version` del server. I tag Docker restano numerici (`2.1.0`, `2.1`, `2`, `latest`).

## Requisiti funzionali

**Utenti e ruoli**
- Multi-utente. Ogni utente vede e gestisce SOLO i propri vault e dispositivi.
- L'amministratore NON può vedere i contenuti né la struttura dei vault degli utenti da nessuna parte dell'interfaccia o delle API admin. Non serve E2EE: chi gestisce l'infrastruttura e possiede la master key può tecnicamente decifrare i dati, ed è accettato, ma non deve essere banale (un dump di DB o storage da solo deve essere inutile).
- L'admin può: configurare il sistema, creare/cancellare/bloccare utenti, impostare/aumentare/ridurre/rimuovere la quota di ogni utente.
- Per ora esiste solo la quota di **spazio**; il modello dati deve permettere altri tipi di quota in futuro.

**Vault e dispositivi**
- Ogni utente può registrare uno o più vault.
- L'onboarding di un vault avviene dal plugin Obsidian.
- Gli altri dispositivi si collegano a un vault esistente in due modi: configurazione manuale nel plugin oppure **QR code** generato da un Obsidian già configurato o dalla web app.
- L'utente può vedere, rinominare e revocare i propri dispositivi.

**Sync**
- Le modifiche vanno sincronizzate il prima possibile: push immediato ai dispositivi connessi, consegna alla riconnessione per gli altri.
- Il backend deve conoscere sempre lo stato di sync di ogni dispositivo (ultimo contatto, ritardo rispetto alla testa, errori).
- Gestire creazione, modifica, cancellazione, rinomina/spostamento, allegati binari, file grandi, pattern di esclusione, sync opzionale/selettivo della cartella `.obsidian`.
- Predisporre il sistema per notifiche/email future (dispositivo fermo da X giorni, conflitti aperti, quota quasi esaurita).

**Conflitti**
- Rilevamento affidabile dei conflitti (modifiche concorrenti sulla stessa versione base).
- Risoluzione dalla web app (diff side-by-side, scelta versione, merge manuale) e possibilmente anche dal plugin.

**Web app**
- Utente: elenco vault, dispositivi, stato sync per dispositivo, conflitti da risolvere, uso quota, generazione QR.
- Admin: gestione utenti, quote, configurazione di sistema, stato di salute del servizio (solo metriche aggregate, nessun contenuto).
- Tema chiaro/scuro/sistema. Multilingua (italiano e inglese all'avvio, architettura i18n estendibile).

## Requisiti non funzionali

- Self-hostabile con `docker compose up` e configurazione via variabili d'ambiente; immagini piccole, healthcheck, migrazioni automatiche.
- Sicurezza: threat model esplicito; autenticazione robusta (valutare 2FA/TOTP); token per dispositivo revocabili; rate limiting.
- Affidabilità: nessuna perdita di dati in caso di crash, rete instabile o dispositivi offline a lungo; operazioni idempotenti.
- Osservabilità: log strutturati, metriche, endpoint di health.
- Codice in TypeScript strict ovunque.

## Direzione architetturale proposta (da validare nel brainstorming)

- **Niente message broker al centro del sync.** Proposta: *change journal* append-only per vault in Postgres con sequenza monotona; ogni dispositivo mantiene un *cursore* (ultima sequenza applicata) → lo stato di sync di ogni device è derivabile in ogni momento. Valuta alternative e dimmi se RabbitMQ/NATS/altro avrebbero senso e perché.
- **WebSocket** per push realtime; riconnessione con "dammi tutto dopo la sequenza N".
- **Blob content-addressed** (hash) su filesystem locale o storage S3-compatibile (MinIO), con garbage collection.
- **Job in background** con pg-boss (solo Postgres) o BullMQ (Redis): valuta quale.
- **Crittografia a riposo lato server (envelope encryption)**, NON end-to-end: master key (KEK) fornita via variabile d'ambiente o Docker secret, mai salvata nel DB; una chiave dati (DEK) per vault, cifrata con la KEK; contenuti dei blob e path dei file cifrati (es. AES-256-GCM). Prevedere rotazione della master key, backup cifrati, audit log delle azioni amministrative. Le API e la UI admin espongono solo metriche aggregate (spazio usato, numero dispositivi, stato), mai nomi o contenuti.
- **Conflitti**: dato che il server può decifrare, il 3-way merge dei file markdown avviene lato server quando possibile (con la versione base dal journal); altrimenti copia di conflitto + risoluzione manuale da web app o plugin; storico versioni. Valuta CRDT (es. Yjs) come evoluzione futura e spiegane i costi.

## Stack tecnologico

Monorepo **pnpm + Turborepo**:

- `packages/protocol`: tipi e schemi condivisi (zod), versione del protocollo.
- `packages/sync-core`: logica di sync, diff e merge condivisa tra server, plugin e web app, testata con property-based testing (fast-check).
- La crittografia a riposo vive in un modulo dedicato di `apps/server` (envelope encryption, rotazione chiavi), isolato e ben testato.
- `apps/server`: Node + TypeScript (proponi Fastify o NestJS motivando la scelta), Postgres, Drizzle ORM (o alternativa motivata).
- `apps/web`: React + Vite, una libreria di componenti open source ben mantenuta (confronta almeno Mantine e shadcn/ui e scegli motivando), TanStack Query, react-i18next.
- `apps/plugin`: plugin Obsidian (TypeScript, esbuild).

Test: Vitest, Playwright per la web app, test di integrazione del protocollo con più client simulati.

## Vincoli del plugin Obsidian

- `isDesktopOnly: false`: niente API Node/Electron; usare le API Vault/adapter di Obsidian, `requestUrl`, WebSocket e WebCrypto.
- Su mobile non c'è esecuzione in background ad app chiusa: sync all'apertura, al resume e mentre l'app è in primo piano. Gestire batteria e rete in modo responsabile.
- Prestazioni su vault grandi (migliaia di file): scansione incrementale, debounce degli eventi, upload a chunk.
- Rispetto delle linee guida dei plugin della community Obsidian (dichiarazione dell'uso di rete, nessuna telemetria nascosta, naming).

## Schermate da progettare (fase UI)

Web app: login/2FA, dashboard utente, dettaglio vault, dettaglio dispositivo, centro conflitti con diff, aggiungi dispositivo/QR, impostazioni account, area admin (utenti, quote, configurazione, salute del sistema).
Plugin: onboarding vault, collegamento a vault esistente (manuale + scansione QR), pannello stato sync, impostazioni, risoluzione conflitti.

## Domande aperte (da affrontare nel brainstorming)

- Gestione della master key: dove vive, come si ruota, cosa succede se viene persa (e come documentarlo per chi fa self-hosting).
- QR code: token di pairing monouso a scadenza breve; come lo si conferma e lo si revoca.
- Retention dello storico versioni e se conta nella quota.
- Cosa succede ai dati di un utente bloccato o cancellato.
- Registrazione aperta, su invito o solo da admin?
- Limite di dimensione dei file e gestione degli allegati grandi.
- Sync della cartella `.obsidian`: sì/no/selettivo per dispositivo.
- Scalabilità: istanza singola all'inizio, ma cosa serve per scalare orizzontalmente?

## Deliverable di questa fase

- `docs/00-vision.md`
- `docs/01-requirements.md`
- `docs/02-architecture.md` (con diagrammi drawio)
- `docs/03-sync-protocol.md` (messaggi, stati, casi limite, versioning del protocollo)
- `docs/04-security-threat-model.md`
- `docs/05-data-model.md`
- `docs/adr/` (una ADR per ogni decisione rilevante)
- `docs/06-roadmap.md`, milestone indicative: M0 scheletro monorepo + CI + docker compose; M1 sync singolo dispositivo; M2 multi-dispositivo realtime; M3 conflitti; M4 web dashboard utente; M5 admin e quote; M6 onboarding con QR; M7 hardening e prima release.
- `CLAUDE.md` con convenzioni di progetto, comandi e struttura.

## Prima azione

Leggi tutto. Poi:

1. riassumi in massimo 10 righe ciò che hai capito;
2. elenca le 5 decisioni più rischiose o con più impatto;
3. avvia il brainstorming con la prima domanda.