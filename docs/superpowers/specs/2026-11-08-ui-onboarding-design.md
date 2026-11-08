# Fase UI — Sotto-fase 3: onboarding, collegamento e impostazioni (plugin)

> Stato: **in revisione** · Data: 2026-11-08 · Branch: `ui-onboarding`
> Fonte: brainstorming del 2026-11-08; tutte le scelte sotto sono state approvate dal committente durante la sessione.
> Parte da: [sotto-fase 2](2026-11-08-ui-stato-conflitti-design.md), [design system](../../ui/design-system.md), [ADR-0012](../../adr/0012-pairing-link-obsidian.md), [protocollo §10](../../03-sync-protocol.md), requisiti D-01…D-08, S-02…S-12, P-02, P-08.

## 1. Decisioni prese nel brainstorming

| # | Decisione |
|---|---|
| O1 | Perimetro: **solo plugin**, comprese le **impostazioni**. La schermata web "aggiungi dispositivo" passa alla sotto-fase 4. |
| O2 | Primo avvio in un vault non collegato: **scheda di benvenuto** con tre strade (primo dispositivo · vault esistente · QR/link). |
| O3 | Pairing: flusso del protocollo §10 in quattro passi; la finestra "Aggiungi un dispositivo" diventa la richiesta di approvazione. |
| O4 | Se all'origine la finestra è chiusa: **notice** che la riapre + sezione **"Richieste di collegamento"** in cima al pannello di stato, finché non si risponde o scade. |
| O5 | Impostazioni **complete** (collegamento, sincronizzazione, file grandi, esclusioni, cartella di configurazione, informazioni); i valori di comportamento si salvano ora e si applicano con M1/M2, e la UI lo dice. |
| O6 | Codice: interfacce `ConnectionService` / `InitialTransfer` con un `FakeServer` in memoria (stesso schema della sotto-fase 2). |

## 2. Perimetro

**Dentro:** scheda di benvenuto; flusso "primo dispositivo" (onboarding) con vista di caricamento iniziale; flusso "vault esistente" (manuale) con avviso di riconciliazione e download iniziale; gestione del link `obsidian://` con schermata del codice di verifica; finestra "Aggiungi un dispositivo" (QR + link + approvazione) e richieste di collegamento nel pannello; impostazioni complete; interfacce e `FakeServer`; comandi di sviluppo per simulare il server.

**Fuori:** chiamate HTTP e token veri (M1/M2); applicazione delle impostazioni di comportamento (M1/M2); ricostruzione del server da un dispositivo (V-05, M1: stesso flusso dell'onboarding con avvisi propri); schermata web "aggiungi dispositivo" (sotto-fase 4); invio del link via email; prova su telefono (rinviata con gli spike).

## 3. Flussi

### 3.1 Scheda di benvenuto — `WelcomeView` (`ItemView`)

- Si apre da sola al caricamento del plugin se il vault **non è collegato** e non è già aperta (una volta per avvio di Obsidian). Si riapre con il comando "Collega questo vault", dal bottone "Collega…" del pannello di stato (nello stato non collegato) e dalle impostazioni.
- Titolo "Benvenuto in {product}" (`PRODUCT_NAME` da `@kamino/brand`), una frase sulla promessa ("Nessun file viene sovrascritto senza chiedertelo"), tre scelte come bottoni grandi con una riga di spiegazione:
  1. **È il primo dispositivo** — "Crea il vault sul server partendo da questi file." → flusso §3.2.
  2. **Collega a un vault esistente** — "Accedi al server con nome utente e password." → flusso §3.3.
  3. **Ho un QR o un link** — "Generalo da un dispositivo già collegato e aprilo qui." → istruzioni in linea: su telefono "Inquadra il QR con la fotocamera: si aprirà Obsidian"; su desktop anche un campo **"Incolla il link"** con "Collega" (stesso percorso del protocol handler, §3.4).
- Quando il vault risulta collegato la scheda si chiude da sola.

### 3.2 Primo dispositivo (onboarding)

Finestra modale a passi (`ConnectModal`, modalità `create`), con "Indietro" e "Annulla" a ogni passo:

1. **Server**: campo URL; "Verifica" chiama `checkServer`. Esiti: `invalid_url` ("Indirizzo non valido"), `unreachable` ("Server non raggiungibile: controlla l'indirizzo e la connessione"), `incompatible` ("Versione del server non compatibile con questo plugin: aggiorna il plugin o il server"), `insecure_on_mobile` (solo telefono, bloccante: spiega che su mobile serve HTTPS e cita Tailscale/Cloudflare Tunnel/reverse proxy, P-08). Su desktop un `http://` valido passa con un **avviso non bloccante** ("Connessione non cifrata: usa solo in una rete di cui ti fidi").
2. **Accesso**: utente e password; esiti `bad_credentials`, `locked`; `totp_required` mostra il campo codice (6 cifre) nello stesso passo; `bad_totp`. La password non viene salvata (D-08) e il campo si svuota alla chiusura.
3. **Vault**: nome del vault sul server, precompilato con il nome del vault di Obsidian.
4. **Dispositivo**: nome del dispositivo, precompilato ("{piattaforma}", es. "macOS", "iPhone"); modificabile poi nelle impostazioni.
5. **Conferma** → `createVault` + `linkDevice` → si apre la **vista di trasferimento** (§3.5) in modalità caricamento.

### 3.3 Vault esistente (manuale)

`ConnectModal`, modalità `join`: **Server** e **Accesso** come in §3.2, poi:

3. **Vault**: elenco dei vault dell'utente (`listVaults`: nome, numero di file, dispositivi collegati); vuoto → "Nessun vault su questo server: usa 'È il primo dispositivo'".
4. **Dispositivo**: come §3.2.
5. **Riconciliazione** (solo se la cartella locale contiene file, D-07): "Questo vault contiene già {count} file: li confronto con quelli sul server. Quelli identici restano come sono, quelli diversi diventano conflitti da guardare. Nessun file viene sovrascritto." → "Continua" / "Annulla".
6. `linkDevice` → vista di trasferimento in modalità download. Gli altri dispositivi ricevono la notice "Nuovo dispositivo collegato: {nome}" (§3.6).

### 3.4 Link `obsidian://` (nuovo dispositivo)

- Il plugin registra `registerObsidianProtocolHandler(PROTOCOL_ACTION)`; `PROTOCOL_ACTION` deriva da `@kamino/brand` (oggi `kamino`).
- `parsePairingLink(params)` valida i parametri: `server` URL `https://` o `http://`, `token` non vuoto. Link malformato → notice "Link di collegamento non valido"; mai un'eccezione. Su telefono un server `http://` segue la regola di §3.2 (bloccato).
- Se il vault è **già collegato**: finestra informativa (`ConfirmModal` con il solo "Chiudi") che spiega che va prima scollegato; nessuna azione automatica.
- Altrimenti si apre `PairingClaimModal`:
  - **Nome del dispositivo** (precompilato) → `claim(link, deviceName)`; esiti `invalid`, `expired` ("Il link è scaduto: generane uno nuovo"), `already_claimed` ("Il link è già stato usato").
  - **Codice**: "Collegamento a {host}", testo "Sul dispositivo da cui hai generato il codice comparirà una richiesta. Approvala solo se vedi questo stesso codice:", codice di 4 caratteri grande e monospazio, "In attesa di approvazione…", tempo rimasto, "Annulla". Polling di `claimStatus` ogni 2 s (fermato alla chiusura).
  - `denied` → "Collegamento rifiutato dall'altro dispositivo."; `expired` → "Tempo scaduto: generane uno nuovo."; `approved` → **riconciliazione** se la cartella non è vuota (come §3.3.5) → vista di trasferimento (download).

### 3.5 Vista di trasferimento iniziale — `TransferView` (`ItemView`)

- Titolo "Caricamento iniziale" / "Download iniziale"; barra di avanzamento (`<progress>` con testo), "{done} di {total} file · {bytesDone} di {bytesTotal}"; "Puoi continuare a lavorare: le modifiche nuove si aggiungono alla coda."
- **Pausa / Riprendi**; in caso di interruzione: "Interrotto: riprendo appena possibile" e ripresa automatica (`InitialTransfer` la gestisce; la vista mostra solo lo stato); errore bloccante → messaggio + "Riprova".
- Al termine: "Fatto: {count} file sincronizzati." e "Apri lo stato sync"; l'indicatore passa allo stato reale.
- Durante il trasferimento l'indicatore e il pannello mostrano lo stato `working` (invio/ricezione di N modifiche).

### 3.6 Lato origine — `AddDeviceModal`

- Aperta da impostazioni ("Aggiungi un dispositivo") e dal comando omonimo; solo se collegato.
- **Attesa**: titolo "Aggiungi un dispositivo", istruzioni ("Inquadra il codice con la fotocamera del nuovo dispositivo, dove Obsidian e il plugin sono già installati in un vault vuoto"), **QR** (SVG, §5.2), link in un campo di sola lettura + "Copia link", "Valido ancora {mm:ss} · usabile una volta sola"; alla scadenza "Codice scaduto" + "Genera di nuovo".
- **Richiesta** (evento da `ConnectionService.onChange`): la stessa finestra mostra "Nuovo dispositivo: '{nome}'", piattaforma, versione del plugin, ora, il **codice** grande, il testo "Approva solo se sul nuovo dispositivo vedi lo stesso codice. Se non sei stato tu, rifiuta." e **Approva** / **Rifiuta**. Dopo la risposta: "Dispositivo collegato" / "Richiesta rifiutata" e chiusura.
- **Finestra chiusa**: alla richiesta compare una notice "Un nuovo dispositivo chiede di collegarsi" (clic → riapre la finestra sulla richiesta) e il pannello di stato mostra in cima la sezione **"Richieste di collegamento · N"** (nome, piattaforma, scadenza; clic → finestra di approvazione). La sezione sparisce alla risposta o alla scadenza.
- Collegamenti con password (§3.3) da altri dispositivi: notice "Nuovo dispositivo collegato: {nome}" (nessuna approvazione, è la password la prova).
- Un secondo `claim` sullo stesso token: l'origine riceve un avviso "Il link è stato usato da un secondo dispositivo ed è stato bloccato" (protocollo §10).

### 3.7 Scollegare

Dalle impostazioni, con finestra di conferma: "Il sync di questo vault si ferma e questo dispositivo viene revocato sul server. I file su questo dispositivo restano dove sono." → `unlink` → stato non collegato (indicatore "Non collegato", §4.3) e scheda di benvenuto disponibile.

## 4. Servizi e dati

In `apps/plugin/src/connection/`.

### 4.1 `ConnectionService`

```ts
type ServerCheck =
  | { ok: true; host: string; insecure: boolean } // insecure = http su desktop
  | { ok: false; reason: "invalid_url" | "unreachable" | "incompatible" | "insecure_on_mobile" };
type LoginResult =
  | { ok: true; session: Session }
  | { ok: false; reason: "bad_credentials" | "totp_required" | "bad_totp" | "locked" };
interface Session { server: string; user: string; expiresAt: number } // nessuna password
interface VaultSummary { id: string; name: string; fileCount: number; deviceCount: number }
interface LinkInfo { server: string; host: string; user: string; vaultId: string; vaultName: string; deviceName: string }
interface PairingOffer { pairingId: string; link: string; expiresAt: number }
interface PairingRequest { pairingId: string; deviceName: string; platform: string; pluginVersion: string; code: string; at: number; expiresAt: number }
type ClaimResult = { ok: true; claimId: string; code: string; expiresAt: number; host: string } | { ok: false; reason: "invalid" | "expired" | "already_claimed" };
type ClaimStatus = "pending" | "approved" | "denied" | "expired";

interface ConnectionService {
  link(): LinkInfo | null;                       // null = non collegato
  checkServer(url: string): Promise<ServerCheck>;
  login(server: string, user: string, password: string, totp?: string): Promise<LoginResult>;
  listVaults(session: Session): Promise<VaultSummary[]>;
  createVault(session: Session, name: string): Promise<VaultSummary>;
  linkDevice(session: Session, vaultId: string, deviceName: string): Promise<LinkInfo>;
  renameDevice(name: string): Promise<void>;
  unlink(): Promise<void>;
  startPairing(): Promise<PairingOffer>;
  pairingRequests(): PairingRequest[];           // richieste in attesa (origine)
  approve(pairingId: string): Promise<void>;
  deny(pairingId: string): Promise<void>;
  cancelPairing(pairingId: string): Promise<void>;
  claim(link: PairingLink, deviceName: string): Promise<ClaimResult>;
  claimStatus(claimId: string): Promise<ClaimStatus>;
  cancelClaim(claimId: string): Promise<void>;
  onChange(cb: (event: ConnectionEvent) => void): () => void;
}
type ConnectionEvent =
  | { type: "linked" | "unlinked" }
  | { type: "pairing_request"; request: PairingRequest }
  | { type: "pairing_closed"; pairingId: string } // approvata, rifiutata, scaduta o annullata
  | { type: "pairing_reused"; pairingId: string }
  | { type: "device_joined"; deviceName: string };
```

`PairingLink = { server: string; token: string }`, prodotto da `parsePairingLink`. `checkServer` applica la regola HTTPS-su-mobile ricevendo `isMobile` dal costruttore del servizio.

### 4.2 `InitialTransfer`

```ts
interface TransferProgress {
  direction: "upload" | "download";
  phase: "running" | "paused" | "interrupted" | "failed" | "done";
  files: { done: number; total: number };
  bytes: { done: number; total: number };
}
interface InitialTransfer {
  start(direction: "upload" | "download"): void; // dopo il collegamento e l'eventuale riconciliazione
  progress(): TransferProgress | null; // null = nessun trasferimento
  pause(): void;
  resume(): void;
  retry(): void;
  onChange(cb: () => void): () => void;
}
```

### 4.3 `FakeServer` e collegamento con lo stato di sync

- `FakeServer` implementa `ConnectionService` e `InitialTransfer` in memoria, con ritardi simulati (orologio e timer iniettabili per i test). Credenziali di prova: utente `demo`, password `demo`; utente `demo2fa` / `demo` richiede il TOTP `123456`; utente `locked` → `locked`. Server: qualsiasi URL valido risponde, tranne host che contengono `unreachable` / `old` (→ `unreachable` / `incompatible`).
- Il trasferimento finto avanza a passi su un numero di file pari ai file del vault locale (upload) o fisso (download), con dimensioni simulate.
- **Stato non collegato** nell'indicatore e nel pannello: nuovo messaggio di stato `working.notLinked` ("Non collegato", icona `cloud-off`) in `@kamino/status`, che ha la precedenza su `working.neverSynced`; il pannello mostra "Collega…" al posto di "Sincronizza ora". `SyncSnapshot` riceve il campo **opzionale** `linked?: boolean` (assente = collegato, così gli snapshot esistenti non cambiano); i test di proprietà si estendono: `linked: false` ⇒ mai `safe`.
- Le richieste di collegamento in attesa arrivano al pannello di stato tramite `ConnectionService.pairingRequests()` e `onChange`.

### 4.4 Impostazioni salvate

```ts
interface PluginSettings {
  sync: { mode: "live" | "periodic" | "manual"; liveDebounceSec: number; periodicMinutes: number };
  largeFiles: { wifiOnly: boolean; thresholdMb: number };
  exclusions: string[];                 // glob, uno per voce
  configDir: { useVaultDefault: boolean; categories: Record<ConfigCategory, boolean> };
}
type ConfigCategory = "core" | "appearance" | "hotkeys" | "enabledPlugins" | "installedPlugins";
```

- Default: `live`, 5 s, 15 min; Wi-Fi only `false` (desktop) / `true` (mobile), 10 MB; nessuna esclusione; `useVaultDefault: true`, categorie tutte `false`.
- `SettingsStore` legge/scrive con `plugin.loadData()` / `saveData()` (`data.json` nella cartella del plugin, sempre esclusa dal sync, S-11) sotto la chiave `settings`; i dati di collegamento del `FakeServer` stanno sotto una chiave separata `link` (in M1: token vero). `normalizeSettings(raw)` riempie i default e corregge valori fuori limite (2–30 s, ≥ 1 min, ≥ 1 MB): un `data.json` vecchio o rovinato non rompe mai il caricamento.
- Validazione dei glob: `validateGlob(pattern)` (sintassi: parentesi bilanciate, nessun `**` attaccato a caratteri, non vuoto); i non validi sono segnalati sulla riga e **ignorati**, gli altri si salvano.

## 5. Componenti tecnici

### 5.1 Nome dell'azione `obsidian://`

`PROTOCOL_ACTION` in `@kamino/brand` (= `PRODUCT_SLUG`); va in `docs/renaming.md` (cambiarlo invalida i QR/link già generati, che però scadono in 10 minuti).

### 5.2 QR

- Libreria **`uqr`** (UnJS, MIT, nessuna dipendenza): `renderSVG(link)` → stringa SVG, inserita come immagine (`data:image/svg+xml`) con `alt` = "Codice QR per collegare un dispositivo". Il QR codifica esattamente il link.
- Colori fissi nero su bianco con margine (leggibilità della fotocamera indipendente dal tema).

### 5.3 Viste e finestre

`WelcomeView` (ItemView), `TransferView` (ItemView), `ConnectModal` (Modal, modalità `create`/`join`), `PairingClaimModal`, `AddDeviceModal`, `ConfirmModal` (generica, per scollegare); `SettingsTab` riscritta (§6). Stesso schema della sotto-fase 2: `UiContext` esteso con `connection: ConnectionService`, `transfer: InitialTransfer`, `settings: SettingsStore`, `openWelcome()`, `openAddDevice()`, `openTransfer()`.

## 6. Impostazioni — `SettingsTab`

`PluginSettingTab` con `Setting` di Obsidian e titoli di sezione (`setHeading`). Sezioni in ordine:

1. **Collegamento.** Non collegato: "Questo vault non è collegato." + **Collega…** (→ scheda di benvenuto). Collegato: server (host), utente, vault, **Nome di questo dispositivo** (campo di testo, salvato con `renameDevice` all'uscita dal campo), **Aggiungi un dispositivo**, **Scollega questo vault** (stile di avvertimento, conferma §3.7). Se `http`: avviso "Connessione non cifrata".
2. **Sincronizzazione.** Riga in evidenza finché il motore non esiste: "Queste impostazioni verranno usate quando il sync sarà attivo." (testo legato a un flag `engineAvailable` del contesto; in M1 diventa vero e la riga sparisce). **Modalità** (menu: Live / Periodica / Manuale) con la spiegazione "Le modalità cambiano solo quando si sincronizza, mai cosa viene salvato." Live → **Pausa di scrittura per le note aperte** (2–30 s); Periodica → **Ogni quanti minuti** (≥ 1).
3. **File grandi.** **Solo in Wi-Fi** (interruttore) e **Soglia** in MB (≥ 1). Su iOS nota: "Su iPhone e iPad la rete è sempre considerata a consumo: ti verrà chiesta conferma."
4. **Esclusioni.** Area di testo, un pattern per riga, esempio `Archivio/**`; sotto: elenco dei pattern non validi (se ce ne sono) e "Sempre esclusi: i dati di questo plugin, lo stato delle finestre (workspace), la cache." (S-11).
5. **Cartella di configurazione** (`{configDir}`, letta da `app.vault.configDir`). **Usa le impostazioni del vault** (interruttore); se spento, cinque interruttori: Impostazioni di base, Aspetto e temi, Scorciatoie, Elenco dei plugin attivi, Plugin installati e loro impostazioni. Nota: "Le modifiche in arrivo per questa cartella non si applicano subito: ti verrà proposto di riavviare Obsidian." (S-12).
6. **Informazioni.** Versione, nome in codice (esistenti), versione del protocollo (`PROTOCOL_VERSION` da `@kamino/protocol`).

Ogni modifica si salva subito (`SettingsStore.update`), normalizzata.

## 7. Test

- **`parsePairingLink`:** valido https/http; `server` mancante/non URL/schema diverso; `token` mancante o vuoto → errore tipizzato, mai eccezione.
- **`FakeServer`:** ogni esito di `checkServer` (incluso `insecure_on_mobile` solo con `isMobile`, `insecure: true` su desktop); `login` con `demo`, `demo2fa` (con e senza TOTP, TOTP sbagliato), `locked`, credenziali errate; `listVaults`/`createVault`/`linkDevice` → `link()` valorizzato ed evento `linked`; `unlink` → `null` ed evento `unlinked`; pairing completo (offer → claim → `pairing_request` → approve → `claimStatus` `approved`), deny, scadenza (orologio avanzato), secondo claim → `already_claimed` + evento `pairing_reused`; trasferimento: avanzamento, pausa/ripresa, interruzione con ripresa automatica, `done`.
- **`@kamino/status`:** `working.notLinked` (testi it/en, precedenza su `neverSynced`); proprietà: `linked: false` ⇒ mai `safe`.
- **`SettingsStore` / `normalizeSettings` / `validateGlob`:** default, valori fuori limite corretti, `data.json` rovinato → default; round-trip `saveData`/`loadData` (mock); glob validi/non validi.
- **Viste** (mock esteso con `registerObsidianProtocolHandler`, `loadData`/`saveData`, `vault.configDir`, `vault.getFiles`):
  - benvenuto: si apre solo se non collegato e una sola volta; le tre scelte avviano il flusso giusto; il campo "Incolla il link" solo su desktop; si chiude al collegamento;
  - `ConnectModal`: ogni errore del server e dell'accesso ha il suo messaggio; `http` bloccato su mobile e avviso su desktop; TOTP richiesto → campo nello stesso passo; elenco vault vuoto; riconciliazione solo se la cartella ha file; "Indietro"/"Annulla"; la password non resta nel DOM dopo la chiusura;
  - `PairingClaimModal`: codice e conto alla rovescia; approved/denied/expired; polling fermato alla chiusura; link già usato/scaduto;
  - `AddDeviceModal`: QR (`img` con `alt`) e link presenti, "Copia link", scadenza → "Genera di nuovo"; richiesta in arrivo → stessa finestra con codice e Approva/Rifiuta;
  - finestra chiusa + richiesta → notice + sezione "Richieste di collegamento" nel pannello, che sparisce a risposta/scadenza;
  - `TransferView`: avanzamento, pausa/ripresa, interruzione, errore + Riprova, completamento;
  - `SettingsTab`: sezioni coerenti con lo stato (collegato/non), condizionali della modalità, nota iOS solo su iOS, glob non validi segnalati, riga "verranno usate…" presente, scollega chiede conferma.
- **i18n:** parità delle chiavi it/en e lessico vietato; **bundle di produzione:** nessun `dev-*`.

## 8. Rischi e primo checkpoint

- **Link `obsidian://` su desktop:** verificare nella vault di prova che `open "obsidian://kamino?server=…&token=…"` (o il clic da browser) arrivi al plugin con i parametri intatti.
- **QR:** verificare che la fotocamera di un telefono riconosca il QR mostrato su desktop (propone di aprire un link `obsidian://`). L'apertura in Obsidian mobile resta per la prova su telefono rinviata.
- Sono il primo task del piano (comando di sviluppo che mostra un QR di prova e registra il protocol handler); se uno dei due fallisce ci si ferma e si decide col committente.

## 9. Documentazione e consegna

- `docs/ui/design-system.md`: nuova sezione "8. Collegamento, pairing e impostazioni"; `docs/renaming.md`: `PROTOCOL_ACTION`; HANDOVER (stato, decisioni O1–O6); changeset (plugin minor, status patch).
- Branch `ui-onboarding`; esecuzione a blocchi con checkpoint (primo: link + QR); revisione finale con un subagente; PR.
- **Uscita:** il committente prova nella vault di prova, su desktop, tutti i flussi con le credenziali di prova e i comandi di simulazione, e approva. Prova su telefono rinviata.
