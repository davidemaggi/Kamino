# Fase UI — Sotto-fase 2: pannello di stato e risoluzione conflitti (plugin)

> Stato: **in revisione** · Data: 2026-11-08 · Branch: `ui-stato-conflitti`
> Fonte: brainstorming del 2026-11-08; tutte le scelte sotto sono state approvate dal committente durante la sessione.
> Parte da: [sotto-fase 1](2026-11-07-ui-fondamenta-design.md), [design system](../../ui/design-system.md), [ADR-0005](../../adr/0005-conflitti-v1-rileva-e-scegli.md), [ADR-0016](../../adr/0016-codemirror-merge.md), [protocollo §8–9](../../03-sync-protocol.md).

## 1. Decisioni prese nel brainstorming

| # | Decisione |
|---|---|
| V1 | Diff vero ora: `packages/ui-diff` su `@codemirror/merge`, verificato subito nella vault di prova (parte desktop dello spike R-3). |
| V2 | Telefono: vista di risoluzione con **schede "La tua / Differenze / In arrivo"** e diff unificato; desktop: diff affiancato. |
| V3 | Pannello di stato: **un'unica pagina a sezioni**, mostrate solo se non vuote. |
| V4 | Una risoluzione si **applica subito** con una notice di conferma (nessuna versione si perde: l'altra resta nello storico); conferma esplicita solo per la risoluzione in blocco. |
| V5 | Codice: `packages/ui-diff` indipendente da framework + interfacce dati nel plugin (`SyncStateSource`, `ConflictActions`) con un'implementazione finta in memoria. |

## 2. Perimetro

**Dentro:**

- `packages/ui-diff` (§3).
- Plugin: interfacce dati e `FakeSyncState` (§4); pannello di stato (§5.1); vista di risoluzione per testo e binari (§5.2–5.3); finestra "Risolvi tutti…" (§5.4); notice dopo le risoluzioni; comandi di sviluppo (§5.5).
- Verifica desktop di R-3 nella vault di prova, con esito in `docs/spikes/R-3.md` (§6).

**Fuori:** motore di sync e chiamate al server (M1/M3); centro conflitti della web app (sotto-fase 4); ripetizione insistente delle notice (M1); logica di rilevamento del Wi-Fi (il pannello mostra solo l'elenco dei file rimandati che riceve); prova su telefono (rinviata, insieme agli spike).

## 3. `packages/ui-diff`

Pacchetto `@kamino/ui-diff`, TypeScript, indipendente da framework.

- **Dipendenze:** `@codemirror/merge` (dipendenza); `@codemirror/state` e `@codemirror/view` come **peer dependency**, forniti da chi usa il pacchetto (nel plugin: Obsidian).
- **`createDiffView(parent: HTMLElement, opts): DiffViewHandle`**

  ```ts
  interface DiffViewOptions {
    mine: string;
    incoming: string;
    layout: "split" | "unified";
    editable: boolean;
    labels: { mine: string; incoming: string }; // testi già tradotti
    phrases?: Record<string, string>; // frasi di CodeMirror (es. controlli di merge), già tradotte
  }
  interface DiffViewHandle {
    getMerged(): string; // testo della "tua" versione, con le modifiche fatte
    destroy(): void;
  }
  ```

  - **split:** `MergeView` con `a` = la tua (modificabile solo se `editable`) e `b` = in arrivo (sola lettura). Con `editable`, `revertControls: "b-to-a"`: ogni differenza ha un controllo per portare il blocco in arrivo nella tua versione.
  - **unified:** `EditorView` con il testo tuo come documento e `unifiedMergeView({ original: incoming, mergeControls: editable })`; con `editable`, ogni blocco ha i controlli "tieni la mia" / "prendi quella in arrivo" (frasi di CodeMirror tradotte con `phrases`). Il documento è la tua versione anche qui, così "Salva l'unione" parte dalla stessa base su desktop e mobile. CodeMirror colora il documento come "inserito" e l'originale come "eliminato": il CSS del plugin riallinea i colori a quelli approvati (la tua = rosso, in arrivo = verde, senza barrato).
  - In sola lettura (`editable: false`) nessun controllo e nessuna modifica possibile.
- **`diffSummary(mine: string, incoming: string): { changes: number }`**: funzione pura (usa `Chunk.build` di `@codemirror/merge`), conta i blocchi di righe modificati, l'unico dato che l'interfaccia mostra ("Differenze: 2"). Testata in Node.
- Nessun testo UI nel pacchetto: le etichette arrivano già tradotte.

**Build del plugin:** la lista degli esterni di esbuild passa da `@codemirror/*` a un elenco esplicito: `@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@lezer/highlight` (e gli altri `@codemirror/*`/`@lezer/*` che Obsidian fornisce e il bundle richiede). `@codemirror/merge` e `style-mod` sono inclusi nel bundle. Chiude il punto aperto M3 dell'HANDOVER.

## 4. Dati del plugin

In `apps/plugin/src/state/`.

```ts
type ConflictKind = "concurrent_edit" | "both_created";
interface VersionInfo { device: string; at: number } // epoch ms
interface ConflictSummary {
  id: string;
  path: string;
  kind: ConflictKind;
  binary: boolean;
  mine: VersionInfo;
  incoming: VersionInfo;
}
type ConflictDetail =
  | (ConflictSummary & { binary: false; mineText: string; incomingText: string })
  | (ConflictSummary & { binary: true; mineFile: BinaryInfo; incomingFile: BinaryInfo });
interface BinaryInfo { size: number; mime: string; previewUrl: string | null } // previewUrl solo per immagini
interface PendingChange { path: string; op: "create" | "modify" | "delete" | "rename"; since: number }
interface DeferredFile { path: string; size: number; direction: "upload" | "download" }
interface DeviceInfo { name: string; mode: "live" | "periodic" | "manual"; server: string } // server = solo host

type Resolution =
  | { type: "keep_mine" }
  | { type: "keep_incoming" }
  | { type: "keep_both" }
  | { type: "manual"; text: string };
type ResolveOutcome = { ok: true } | { ok: false; reason: "stale" | "gone" }; // gone = già risolto altrove
type BulkStrategy = "keep_mine" | "keep_incoming" | "keep_both";

interface SyncStateSource {
  snapshot(): SyncSnapshot;            // da @kamino/status
  conflicts(): ConflictSummary[];
  conflict(id: string): Promise<ConflictDetail | null>;
  pending(): PendingChange[];
  deferred(): DeferredFile[];
  device(): DeviceInfo;
  onChange(cb: () => void): () => void; // restituisce la funzione per smettere di ascoltare
}

interface ConflictActions {
  resolve(id: string, resolution: Resolution): Promise<ResolveOutcome>;
  resolveAll(strategy: BulkStrategy, ids: readonly string[]): Promise<{ resolved: number }>; // solo i conflitti mostrati
  syncNow(): Promise<void>;
  transferNow(path: string): Promise<void>; // carica o scarica, secondo DeferredFile.direction
}
```

- **`FakeSyncState`** implementa entrambe le interfacce in memoria. Le risoluzioni modificano davvero lo stato (conflitto chiuso, `snapshot().conflicts` decrementato, `onChange` notificato), così pannello, indicatore e viste reagiscono come con i dati reali. `stale` si simula con un flag di test (`nextResolveStale()`), che fa anche cambiare la versione in arrivo.
- Scenari predefiniti (`loadScenario("conflicts")`): una nota di testo corta, una nota lunga (≥ 200 righe, più differenze), un'immagine (binario, con anteprima generata come data URL), più qualche modifica in coda e un file rimandato al Wi-Fi.
- L'indicatore (sotto-fase 1) si aggiorna da `SyncStateSource.onChange` + `describeStatus(snapshot())`.
- **Privacy:** path e nomi di file compaiono solo nell'interfaccia locale del plugin; mai nei log (il `console.warn` delle icone resta l'unico log e non contiene path).

## 5. Viste

Tutti i testi nei JSON i18n del plugin (it/en); nessun termine del lessico a tema. Icone e colori di stato secondo il [design system](../../ui/design-system.md); solo variabili di Obsidian.

### 5.1 Pannello di stato — `StatusPanelView` (`ItemView`)

- Si apre nella barra laterale destra (su mobile la stessa vista appare nel cassetto). Il clic sull'indicatore (barra di stato, ribbon, azione nell'intestazione) **apre il pannello** (prima apriva una notice). Comando "Apri stato sync".
- **Riepilogo** in alto: icona e messaggio del livello, messaggi secondari, ultimo sync confermato, bottone "Sincronizza ora" (`syncNow`).
- **Sezioni**, ciascuna mostrata solo se non vuota, nell'ordine:
  1. **Conflitti · N**: righe con nome del file, dispositivo e ora della versione in arrivo; clic → apre la vista di risoluzione. "Risolvi tutti…" se N ≥ 2.
  2. **Non ancora sul server · N**: le prime 5 righe (nome, tipo di modifica localizzato, età), poi "Mostra tutte (N)" che espande l'elenco.
  3. **In attesa di Wi-Fi · N**: nome, dimensione, "Carica ora" / "Scarica ora" (`transferNow`).
  4. **Questo dispositivo** (sempre): nome, modalità, host del server.
- Nello stato `safe` il riepilogo è "Tutto al sicuro" e restano solo riepilogo e "Questo dispositivo".
- Si aggiorna a ogni `onChange`; smette di ascoltare in `onClose`.
- Accessibilità: titoli di sezione veri (`h3`), righe come `button` navigabili da tastiera, `aria-live="polite"` sul riepilogo.

### 5.2 Risoluzione di un conflitto di testo — `ConflictView` (`ItemView`)

- Si apre nell'area principale, una scheda per conflitto (riaperta se già aperta). Lo stato della vista contiene l'id del conflitto.
- **Intestazione:** nome del file; "Modificata qui alle {ora} e su {dispositivo} alle {ora}. Entrambe le versioni sono salvate."; per `both_created`: "Due file con lo stesso nome creati qui e su {dispositivo}". Riepilogo da `diffSummary` ("2 differenze").
- **Desktop** (`Platform.isMobile === false`): `createDiffView` con `layout: "split"`, etichette "La tua versione · questo dispositivo" / "In arrivo · {dispositivo}, {ora}".
- **Mobile:** schede **La tua / Differenze / In arrivo**; si apre su "Differenze" (`layout: "unified"`); "La tua" e "In arrivo" mostrano il testo intero in sola lettura, senza evidenziazioni.
- **Azioni:** Tieni la mia · Tieni quella in arrivo · Tieni entrambe · **Modifica e unisci…**. Su mobile in fondo, a tutta larghezza.
- **Modifica e unisci:** il diff viene ricreato con `editable: true` (su mobile si passa alla scheda "Differenze"); le azioni diventano **Salva l'unione** (`manual` con `getMerged()`) e **Annulla** (torna alla vista in sola lettura).
- **Dopo una risoluzione riuscita:** notice (es. "Hai tenuto la tua versione. Quella di {dispositivo} resta nello storico."; per `keep_both`: "Hai tenuto entrambe: la tua è salvata come file affiancato."; per `manual`: "Unione salvata."), la scheda si chiude, pannello e indicatore si aggiornano da `onChange`.
- **`stale`:** la vista ricarica il conflitto e mostra in alto "È arrivata una versione più recente: controlla di nuovo prima di scegliere." Nessuna notice di successo.
- **Conflitto non più esistente** (risolto altrove): la vista mostra "Questo conflitto è già stato risolto" e un bottone per chiudere.
- Il diff viene distrutto (`destroy()`) in `onClose` e prima di ogni ricreazione.

### 5.3 Conflitto su file binario

Stessa `ConflictView`, senza diff: due riquadri (affiancati su desktop, impilati su mobile) "La tua" / "In arrivo" con dispositivo, data, dimensione formattata, tipo e **anteprima** solo se `previewUrl` non è nullo (immagini). Azioni: Tieni la mia · Tieni quella in arrivo · Tieni entrambe (niente "Modifica e unisci").

### 5.4 Risolvi tutti… — `BulkResolveModal` (`Modal`)

- Tre opzioni (radio): tieni tutte le mie · tieni tutte quelle in arrivo · tieni entrambe per tutti. Nessuna preselezionata.
- Riepilogo "Si applica a {count} file"; bottone **Applica** disabilitato finché non si sceglie un'opzione; "Annulla".
- Al termine: notice "{count} conflitti risolti" e chiusura. Le viste di conflitto aperte su file risolti mostrano "già risolto" (§5.2).

### 5.5 Comandi di sviluppo (solo con `__DEV__`)

- "Mostra galleria stati (sviluppo)" (esistente): ora imposta lo snapshot di `FakeSyncState`, quindi anche il pannello segue.
- "Carica scenario conflitti (sviluppo)": `loadScenario("conflicts")` e apertura del pannello.
- "Apri diff di prova (sviluppo)": finestra modale con un diff di esempio, commutabile tra affiancato/unificato e sola lettura/modificabile; serve alla verifica R-3 (§6), prima che esista la `ConflictView`.
- Assenti dal bundle di produzione (test sul bundle).

Nella build di produzione, fino a M1, `SyncStateSource` è un `FakeSyncState` vuoto nello stato "mai sincronizzato": il pannello mostra il riepilogo e "Questo dispositivo".

## 6. Verifica R-3 su desktop (primo task)

1. Aggiungere `@codemirror/merge` al plugin tramite `ui-diff`, esterni espliciti (§3).
2. `build:vault`, aprire la vault di prova, eseguire "Apri diff di prova (sviluppo)" e provare le quattro combinazioni (affiancato/unificato × sola lettura/modificabile).
3. Controllare: nessun errore in console (in particolare "Unrecognized extension value" / istanze duplicate di `@codemirror/state`), evidenziazione, scorrimento, modifica, controlli per blocco.
4. Annotare in `docs/spikes/R-3.md` versione di Obsidian desktop, versione di `@codemirror/merge`, esito; stato dello spike: "desktop superato, mobile in attesa".
5. **Se fallisce:** fallback dell'ADR-0016 (due pannelli in sola lettura nel plugin, merge manuale solo da web). Prima di proseguire si chiede conferma al committente, perché cambia §5.2.

## 7. Test

- **`ui-diff`:** `diffSummary` (testi uguali → 0; una riga cambiata → 1; righe aggiunte in fondo → 1; due cambi lontani → 2; testi vuoti → 0); `createDiffView` in jsdom: montaggio nei due layout, `getMerged()` uguale a `mine` senza modifiche, solo la tua versione modificabile, `destroy()` svuota il contenitore.
- **`FakeSyncState`:** ogni `Resolution` chiude il conflitto, aggiorna `snapshot().conflicts` e notifica `onChange`; `stale` lascia il conflitto aperto e cambia la versione in arrivo; `resolveAll` applica la strategia a tutti e restituisce il conteggio; `onChange` restituisce una funzione che smette davvero di notificare.
- **Viste** (mock di Obsidian esteso con `ItemView`, `WorkspaceLeaf`, `Modal`, `Platform`):
  - pannello: solo sezioni non vuote; stato `safe` → solo riepilogo e dispositivo; "Mostra tutte" espande; "Risolvi tutti…" solo con ≥ 2 conflitti; si aggiorna su `onChange` e smette in `onClose`;
  - vista conflitto: split su desktop, schede su mobile con "Differenze" iniziale; ogni azione chiama `resolve` con la `Resolution` giusta e mostra la notice giusta; "Modifica e unisci" → `manual` con il testo unito; `stale` ricarica e mostra l'avviso; conflitto inesistente → "già risolto"; `destroy()` chiamato alla chiusura;
  - binario: anteprima solo con `previewUrl`; nessun "Modifica e unisci";
  - modal: "Applica" disabilitato senza scelta; nessuna chiamata a `resolveAll` senza conferma;
  - indicatore: il clic apre il pannello.
- **i18n:** parità delle chiavi it/en e lessico vietato (test esistenti).
- **Bundle di produzione:** nessun comando di sviluppo (id `dev-*`); nessun codice di `@codemirror/state`/`@codemirror/view` incluso (le `require` restano esterne); dimensione del `main.js` prima/dopo annotata nel piano.

## 8. Documentazione

- `docs/ui/design-system.md`: nuove sezioni su pannello di stato, vista di risoluzione (desktop/mobile), binari, risoluzione in blocco, notice.
- `docs/spikes/R-3.md`: esito desktop.
- `CLAUDE.md` (struttura: `packages/ui-diff`), `docs/renaming.md` se compaiono nuovi punti, HANDOVER (stato, decisioni V1–V5, rimozione del punto aperto M3 sugli esterni di esbuild), changeset.
- `docker/Dockerfile`: `packages/ui-diff/package.json` nelle `COPY` (regola di `CLAUDE.md`), anche se l'immagine non lo usa ancora.

## 9. Consegna e criterio di uscita

- Branch `ui-stato-conflitti`; esecuzione a blocchi (R-3 + `ui-diff` → dati finti + pannello → vista conflitto, binari, risoluzione in blocco → documenti); revisione finale con un subagente; PR.
- `pnpm build`, `typecheck`, `lint`, `test`, `format:check` verdi; build Docker verde; CI verde.
- **Uscita:** il committente prova pannello e risoluzioni nella vault di prova su desktop (scenario conflitti) e approva. Prova su telefono rinviata con gli spike.
