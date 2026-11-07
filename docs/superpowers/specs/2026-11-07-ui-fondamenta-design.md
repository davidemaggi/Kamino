# Fase UI — Sotto-fase 1: fondamenta del design system

> Stato: **in revisione** · Data: 2026-11-07 · Branch: `ui-fondamenta`
> Fonte: brainstorming del 2026-11-07 (tutte le scelte sotto sono state approvate dal committente durante la sessione).

## 1. Contesto e scomposizione

La fase UI ([06 — Roadmap](../../06-roadmap.md)) copre il design system e 14 schermate su due superfici. È divisa in quattro sotto-fasi, ciascuna con il proprio ciclo specifica → piano → implementazione → approvazione:

1. **Fondamenta del design system** — questo documento.
2. Plugin: pannello di stato sync e risoluzione conflitti.
3. Onboarding e collegamento: onboarding vault, collegamento manuale/QR, approvazione nuovo dispositivo (plugin), aggiungi dispositivo/QR (web).
4. Web app: login/2FA, dashboard, dettaglio vault/dispositivo, centro conflitti, account, area admin.

### Decisioni prese nel brainstorming

| # | Decisione |
|---|---|
| U1 | I deliverable sono **componenti veri** nel codice (non mockup statici né wireframe). |
| U2 | Viste del plugin con le **API DOM di Obsidian** e CSS sulle variabili di Obsidian; niente framework nel plugin. |
| U3 | Revisione tramite **gallerie interne**: rotta di sviluppo nella web app, comando di sviluppo nel plugin. Niente Storybook. |
| U4 | Direzione visiva **C "Ibrida"** per la web app (vedi §4.1). |
| U5 | Lessico degli stati a **cinque livelli** (vedi §3). |
| U6 | Font **inclusi nell'app** via `@fontsource`: Inter (UI) e Source Serif 4 (titoli). |
| U7 | Lessico e logica degli stati in un pacchetto condiviso **`packages/status`**; token in ciascuna app. |
| U8 | Indicatore su **mobile**: icona nel ribbon + notice + **azione nell'intestazione della nota attiva solo dal livello Attenzione in su**. Su desktop: barra di stato sempre visibile. |

## 2. Perimetro

**Dentro:**

- `packages/status` (§3).
- Web: token, font, icone, componenti shadcn di base, `StatusBadge`, galleria `/dev/gallery`, chiusura dei punti aperti "Fase UI" dell'HANDOVER (§4).
- Plugin: classi CSS degli stati, indicatore di stato (barra di stato, ribbon, azione nell'intestazione), comando "Mostra galleria stati" (§5).
- `docs/ui/design-system.md`, aggiornamento di `docs/02-architecture.md` §ui e di `docs/renaming.md` (§7).

**Fuori:** pannello di stato completo, risoluzione conflitti, onboarding, schermate web (sotto-fasi 2–4); router della web app (scelto nella sotto-fase 4); TanStack Query; collegamento a dati reali (arriva con M1).

## 3. `packages/status`

Pacchetto `@kamino/status`, TypeScript puro, **nessuna dipendenza di runtime**, nessun I/O. Usato dalla web app, dal plugin e, da M1, dal motore di sync del plugin.

### 3.1 Livelli

| Livello | Id | Icona Lucide | Significato | Colore semantico |
|---|---|---|---|---|
| Al sicuro | `safe` | `shield-check` | Coda vuota, almeno un sync confermato, nessun conflitto, nessun blocco. Unico stato verde. | verde |
| In corso | `working` | `refresh-cw` (in invio) / `clock` (in coda) | Modifiche in coda o in invio entro le soglie; dispositivo mai sincronizzato. Normale. | grigio |
| Attenzione | `attention` | `cloud-off` (offline) / `triangle-alert` (altri) | Soglia superata. Le modifiche sono al sicuro sul dispositivo, non ancora sul server. | ambra |
| Decisione | `decision` | `git-compare-arrows` | Conflitti da risolvere: entrambe le versioni sono conservate. Non è un pericolo. | viola |
| Bloccato | `blocked` | `octagon-alert` | Il sync non può proseguire senza intervento. Sempre con motivo e azione. | rosso |

Ordine di gravità: `blocked` > `decision` > `attention` > `working` > `safe`. I nomi delle icone sono quelli di Lucide, comuni a `lucide-react` e a `setIcon` di Obsidian; nella web app la mappa nome → componente di `lucide-react` è un `Record` sul tipo dei nomi, quindi un nome mancante è un errore di compilazione. Obsidian include una propria versione di Lucide, che può non avere i nomi più recenti: nella galleria del plugin l'indicatore controlla `getIconIds()` e, se un nome manca, lo segnala in console e usa un'icona di riserva per livello (`check`, `clock`, `alert-triangle`, `git-compare`, `x-octagon`). La verifica sul `minAppVersion` scelto fa parte della revisione della galleria.

### 3.2 Tipi

```ts
type BlockReason = "quota" | "revoked" | "auth" | "protocol";

interface SyncSnapshot {
  queued: number;                    // operazioni nell'outbox non confermate
  oldestQueuedAt: number | null;     // epoch ms della più vecchia, null se coda vuota
  lastConfirmedAt: number | null;    // epoch ms dell'ultimo sync confermato, null se mai
  unreachableSince: number | null;   // epoch ms da cui il server non risponde, null se raggiungibile
  syncing: boolean;                  // invio/ricezione in corso
  conflicts: number;
  blocked: BlockReason | null;
  quotaRatio: number | null;         // uso/quota (0..∞), null se senza quota
}

interface Thresholds {
  staleQueueMs: number;     // default 1 h (S-05, modalità Live)
  unreachableMs: number;    // default 24 h (S-05)
  quotaWarnRatio: number;   // default 0.9 (Q-05)
}

interface StatusMessage { key: StatusKey; params: Record<string, number> }

interface StatusDescription {
  level: Level;
  message: StatusMessage;      // messaggio principale
  secondary: StatusMessage[];  // altri stati presenti, in ordine di gravità
  icon: LucideIconName;
  lastConfirmedAt: number | null;
}
```

### 3.3 `describeStatus(snapshot, thresholds, now): StatusDescription`

Regole, valutate in ordine. Il primo livello che si applica è il livello principale; ogni altra condizione vera finisce in `secondary`.

1. **blocked** se `blocked !== null` → `status.blocked.<reason>` con `{ count: queued }`.
2. **decision** se `conflicts > 0` → `status.decision.conflicts` con `{ count }`.
3. **attention** se vale almeno una di (nell'ordine, la prima è il messaggio principale):
   - `unreachableSince` e `now - unreachableSince ≥ unreachableMs` → `status.attention.offline` con `{ ageMs, count: queued }`;
   - `oldestQueuedAt` e `now - oldestQueuedAt ≥ staleQueueMs` → `status.attention.stale` con `{ count, ageMs }`;
   - `quotaRatio ≥ quotaWarnRatio` → `status.attention.quota` con `{ percent }`.
4. **working** se `queued > 0` (→ `status.working.syncing` se `syncing`, altrimenti `status.working.queued`, con `{ count }`) oppure `lastConfirmedAt === null` (→ `status.working.neverSynced`).
5. **safe** altrimenti → `status.safe`. Se il server è irraggiungibile ma sotto soglia, in `secondary` compare `status.note.unreachable` con `{ ageMs }`: la coda è vuota, quindi i dati sono già sul server.

Proprietà garantite (testate con fast-check):

- **P1 — safe è onesto:** `level === "safe"` ⇒ `queued === 0 && lastConfirmedAt !== null && conflicts === 0 && blocked === null`.
- **P2 — monotonia:** aumentare `queued`, `conflicts`, l'età della coda o del distacco dal server, `quotaRatio`, o impostare `blocked`, non abbassa mai la gravità.
- **P3 — determinismo:** stesso input ⇒ stesso output; nessuna lettura dell'orologio (il tempo entra solo da `now`).
- **P4 — completezza:** ogni condizione vera compare o come messaggio principale o in `secondary`.

### 3.4 Testi e formattazione

- `STATUS_MESSAGES`: testi `it`/`en` per ogni chiave di stato (chiavi senza prefisso, es. `working.queued`), con forme `zero`/`one`/`other` dove serve. **I testi li formatta il pacchetto stesso** con `formatStatusMessage(message, lang)` (plurali con `Intl.PluralRules`, parametri `{count}`, `{age}`, `{percent}`): il plugin non usa i18next, e così web e plugin producono la stessa stringa per costruzione. `formatLastConfirmed(lastConfirmedAt, now, lang)` produce "Ultimo sync confermato: 2 min fa" / "Mai sincronizzato con il server". Il futuro `packages/i18n` potrà assorbirli.
- Testi di partenza (it): "Tutto al sicuro"; "{count} modifiche in attesa"; "Invio di {count} modifiche…"; "Mai sincronizzato"; "Server non raggiungibile da {age} · {count} modifiche non salvate"; "{count} modifiche non salvate da {age}"; "Spazio quasi esaurito ({percent}%)"; "{count} conflitti da risolvere"; "Spazio esaurito · {count} modifiche non salvate"; "Dispositivo revocato: il sync è fermo"; "Accesso scaduto: accedi di nuovo"; "Aggiorna il plugin: versione non compatibile con il server". Gli equivalenti inglesi seguono lo stesso senso.
- `formatAge(ms, lang)`: durata compatta e identica sulle due superfici ("meno di 1 min", "2 min", "3 h", "2 g" / "under 1 min", "2 min", "3 h", "2 d"), con soglie fisse (< 1 min, < 1 h, < 24 h, giorni) e arrotondamento per difetto. Usata per il parametro `age`.
- Nessun termine del lessico a tema nei testi (test di lessico esistente esteso alle nuove chiavi).

### 3.5 Snapshot di esempio

`EXAMPLE_SNAPSHOTS`: elenco nominato usato da entrambe le gallerie e dai test di esempio. Almeno: tutto al sicuro; mai sincronizzato; 3 in attesa; invio in corso; offline sotto soglia (safe con nota); offline 2 giorni con 14 in coda; coda ferma da 2 h; quota al 95%; 1 conflitto; 3 conflitti + offline; quota piena con 12 in coda; dispositivo revocato; accesso scaduto; protocollo incompatibile.

## 4. Web app

### 4.1 Token (direzione C)

Variabili CSS in `apps/web/src/index.css` nello schema di shadcn, esposte a Tailwind 4 con `@theme inline`. Valori di partenza (il test di contrasto in §6 è vincolante; i valori possono cambiare per rispettarlo):

| Token | Chiaro | Scuro |
|---|---|---|
| `--background` | `#f7f9f9` | `#0b1820` |
| `--card` | `#ffffff` | `#13232c` |
| `--foreground` | `#132a36` | `#e7eef0` |
| `--muted-foreground` | `#5b6b73` | `#8a9ba3` |
| `--border` | `#e3e9eb` | `#1d3340` |
| `--primary` / `--primary-foreground` | `#0d2230` / `#ffffff` | `#4fd6e3` / `#071118` |
| `--accent-link` (azioni secondarie, link, `--ring`) | `#0b7685` | `#4fd6e3` |

Stati, coppia testo/superficie:

| Livello | Chiaro | Scuro |
|---|---|---|
| `--status-safe` / `-surface` | `#0b6b52` / `#e3f6ef` | `#7ff0c9` / `#0e3b33` |
| `--status-working` / `-surface` | `#3f5059` / `#eef1f2` | `#b4c3ca` / `#1d3340` |
| `--status-attention` / `-surface` | `#8a5a00` / `#fbf0d9` | `#ffd166` / `#3a2e0c` |
| `--status-decision` / `-surface` | `#5a3fb0` / `#efeafd` | `#c4b2ff` / `#2c2250` |
| `--status-blocked` / `-surface` | `#a3261b` / `#fbe4e1` | `#ff9c90` / `#401a17` |

- `--radius: 10px`; spaziature e scala tipografica di Tailwind.
- Il colore ciano del brand non coincide con nessun colore di stato ("in attesa" è grigio).
- Lo stato di un dispositivo nelle card è indicato da un pallino accanto al nome, **non** da un bordo laterale colorato.
- `components.json` resta `new-york`; i colori vengono dai nostri token, non dal `baseColor`.

### 4.2 Font e icone

- `@fontsource-variable/inter` (UI, numeri tabulari dove servono) e `@fontsource/source-serif-4` pesi 600 e 700, sottoinsieme latino. Serif solo per i titoli di pagina e delle card.
- Nessuna richiesta a CDN esterni. Un test sulla build verifica che il CSS prodotto non contenga URL `http(s)://` di font.
- Icone: `lucide-react`.

### 4.3 Componenti

- shadcn: **Button, Badge, Card, Tooltip** soltanto. Gli altri arrivano con le schermate che li usano.
- `StatusBadge({ status })`: riceve una `StatusDescription`, mostra icona + testo tradotto con i colori del livello; `role="status"`; tooltip con "Ultimo sync confermato: {{age}} fa" (o "mai"). Il testo è sempre presente: il colore non è mai l'unico segnale.

### 4.4 Galleria `/dev/gallery`

- In `main.tsx`: se `import.meta.env.DEV` e il percorso è `/dev/gallery`, `import()` dinamico di `GalleryPage`; altrimenti la pagina normale. Nessun router.
- In produzione la galleria non è nel bundle: un test sulla build cerca un marcatore della galleria nei file prodotti e fallisce se lo trova.
- Contenuto: palette (chiaro e scuro affiancati), tipografia, componenti di base, `StatusBadge` per ogni elemento di `EXAMPLE_SNAPSHOTS`, una card "dispositivo" di esempio. Selettori tema (chiaro/scuro/sistema) e lingua (it/en).

### 4.5 Punti aperti "Fase UI" dell'HANDOVER

- **Flash del tema:** `public/theme-init.js`, caricato in modo sincrono nel `<head>`, legge `localStorage["theme"]` e `prefers-color-scheme` e applica la classe `dark` prima del rendering. File esterno, non inline, per compatibilità con una CSP senza `unsafe-inline`. La chiave resta `THEME_STORAGE_KEY`; un test verifica che lo script e il `ThemeProvider` usino la stessa chiave.
- **Modalità sistema:** test della modalità `system` e del cambio di `prefers-color-scheme` a runtime.
- **Chiavi `theme.*`:** usate dal selettore del tema (componente `ThemeSwitcher`, riusabile dalle schermate future).
- **`<title>`/`lang`:** valori di default in `index.html` (`lang="en"`, titolo = nome prodotto inserito in build da Vite, così `brand` resta l'unica fonte), poi aggiornati in JS come oggi.

## 5. Plugin

### 5.1 CSS

In `apps/plugin/styles.css`, una classe per livello che usa solo variabili di Obsidian:

| Livello | Variabile |
|---|---|
| `safe` | `--color-green` |
| `working` | `--text-muted` |
| `attention` | `--color-yellow` |
| `decision` | `--color-purple` |
| `blocked` | `--color-red` |

Classi `.kamino-status`, `.kamino-status--<livello>`. Il prefisso è scritto a mano in `styles.css` (che non può importare `brand`) e in TS è derivato da una costante unica; il punto viene aggiunto a `docs/renaming.md`.

### 5.2 Indicatore

- `renderStatusIndicator(el, status, t)`: funzione pura che svuota `el` e costruisce icona (`setIcon`) + testo con le API DOM di Obsidian. Testabile con jsdom e i mock di `obsidian` già presenti.
- `StatusIndicator`: componente che mantiene i punti di visualizzazione e li aggiorna a ogni nuova `StatusDescription`:
  - **desktop:** voce della barra di stato, sempre visibile (icona + testo);
  - **ribbon (desktop e mobile):** icona che cambia col livello, `aria-label` con il messaggio;
  - **mobile, livello ≥ `attention`:** azione nell'intestazione della nota attiva (`view.addAction`) con l'icona del livello; viene rimossa quando il livello scende sotto `attention` e spostata quando cambia la nota attiva;
  - **notice:** dal livello `attention` in su, una notice al cambio di livello; la ripetizione insistente di S-05 è implementata in M1 insieme al motore.
- Clic su qualsiasi punto: per ora una `Notice` con messaggio principale, secondari e ultimo sync confermato. Il pannello vero è della sotto-fase 2.
- Regola di decisione "mostrare l'azione nell'intestazione?" estratta in una funzione pura (`shouldShowHeaderAction(level, isMobile)`), testata a parte.

### 5.3 Comando "Mostra galleria stati"

Registrato solo se la costante `__DEV__` (iniettata da esbuild, `false` nella build di produzione e quindi eliminata) è vera. Fa ciclare l'indicatore su `EXAMPLE_SNAPSHOTS`, mostrando il nome dello snapshot in una notice. Funziona su desktop e mobile (con la build di sviluppo copiata in una vault di prova). Un test sulla build di produzione verifica l'assenza del comando.

## 6. Test

- `packages/status`: Vitest + fast-check per P1–P4; un caso d'esempio per ogni `EXAMPLE_SNAPSHOTS` (livello e chiave attesi); `formatAge` alle soglie; parità chiavi it/en e plurali; forme plurali coerenti tra it e en.
- Web: Testing Library per `StatusBadge` (ogni livello: testo, `role`, tooltip), `ThemeSwitcher`, modalità sistema; test di `theme-init.js` in jsdom; test sulla build (galleria assente, nessun font esterno).
- **Contrasto:** test unitario che legge i token di stato da `index.css` e calcola il rapporto WCAG di ogni coppia testo/superficie e di `--foreground`/`--muted-foreground` su `--background` e `--card`, in chiaro e in scuro: ≥ 4.5:1, altrimenti fallisce.
- Plugin: jsdom per `renderStatusIndicator`, `shouldShowHeaderAction`, aggiornamento dei punti di visualizzazione al cambio di livello; test sulla build di produzione (comando galleria assente).
- Lessico: i test esistenti (parità chiavi, termini a tema vietati nella UI) coprono anche le nuove chiavi.

## 7. Documentazione

- **`docs/ui/design-system.md`** (nuovo): direzione C, token con valori, font, tabella dei livelli (parole, icone, regole, precedenza), mappatura sulle variabili di Obsidian, regole d'uso (pallino e non bordo laterale; mai solo colore), come aprire le due gallerie.
- **`docs/02-architecture.md` §ui:** "Indicatore in status bar (desktop) / ribbon + notice (mobile)" diventa "barra di stato (desktop); ribbon + notice + azione nell'intestazione della nota attiva dal livello Attenzione (mobile)".
- **`docs/renaming.md`:** prefisso delle classi CSS del plugin.
- **HANDOVER:** stato della fase UI, decisioni U1–U8, punti aperti "Fase UI" chiusi.

## 8. Consegna e criterio di uscita

- Branch `ui-fondamenta`; piano in `docs/superpowers/plans/`; una changeset (web e plugin cambiano in modo visibile).
- `pnpm build`, `typecheck`, `lint`, `test`, `format:check` verdi; CI verde.
- **Uscita:** il committente apre la galleria web (chiaro/scuro, it/en) e la galleria del plugin su desktop e su telefono, e le approva.
