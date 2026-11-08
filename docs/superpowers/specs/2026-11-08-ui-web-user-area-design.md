# Fase UI — Sotto-fase 4b: web app, area utente

> Stato: **in revisione** · Data: 2026-11-08 · Branch: `ui-web-user`
> Fonte: brainstorming del 2026-11-08 (scelte approvate dal committente).
> Parte da: [4a](2026-11-08-ui-web-shell-account-design.md), [design system](../../ui/design-system.md) §3 e §7, requisiti V-03, V-04, D-05, D-06, C-03…C-05, H-01…H-05, Q-05, protocollo §9–10.

## 1. Decisioni

| # | Decisione |
|---|---|
| X1 | Tutta l'area utente in un'unica sotto-fase (panoramica, vault, dispositivi, aggiungi dispositivo, centro conflitti, storico, cestino). |
| X2 | **Dettaglio vault**: intestazione (nome, stato, numeri, spazio) + **schede** Dispositivi · Conflitti · Storico e cestino · Impostazioni. |
| X3 | **Centro conflitti**: elenco raggruppato per vault a sinistra, dettaglio con diff e azioni a destra; su telefono elenco e dettaglio sono due pagine. |
| X4 | Stesso schema della 4a: contratto zod in `@kamino/protocol`, client `fetch` + TanStack Query, API simulate con MSW. |

## 2. Perimetro

**Dentro:** panoramica; elenco e dettaglio vault (rinomina, retention dello storico, download ZIP anche "com'era alla data X", cancellazione con conferma); elenco e dettaglio dispositivi (D-06, rinomina, revoca); aggiungi dispositivo con QR e approvazione dal web (protocollo §10); centro conflitti (testo con `ui-diff` tramite adattatore React, binari, modifica e unisci, risoluzione in blocco, versione più recente arrivata nel frattempo, conflitto già risolto); storico di un file (sfoglia, guarda, ripristina); cestino (ripristina). Rinvii della 4a: lingua e tema salvati sul server riapplicati all'accesso; route pesanti caricate a richiesta (bundle diviso).

**Fuori:** area admin (4c); API vere (M1+); invio del link via email.

## 3. Contratto (`@kamino/protocol`, file `vaults.ts`, `devices.ts`, `conflicts.ts`, `history.ts`)

| Rotta | Richiesta | Risposta |
|---|---|---|
| `GET /vaults` | — | `{ vaults: Vault[], quota: { usedBytes, limitBytes \| null } }` |
| `GET /vaults/:id` | — | `Vault` |
| `PATCH /vaults/:id` | `{ name?, retentionDays? }` | `Vault` |
| `DELETE /vaults/:id` | `{ confirmName }` (deve coincidere col nome) | `204` |
| `GET /vaults/:id/zip?at=<ISO>` | — | file ZIP (`at` assente = stato attuale; fuori finestra → `410 history_window`) |
| `GET /devices` | — | `Device[]` (tutti i vault) |
| `GET /devices/:id` | — | `Device` |
| `PATCH /devices/:id` | `{ name }` | `Device` |
| `POST /devices/:id/revoke` | — | `Device` |
| `POST /vaults/:id/pairings` | — | `{ pairingId, link, expiresAt }` |
| `GET /pairings/:id` | — | `{ status: "waiting" \| "requested" \| "approved" \| "denied" \| "expired" \| "cancelled", request?: { deviceName, platform, pluginVersion, code } }` |
| `POST /pairings/:id/approve` \| `/deny` \| `/cancel` | — | `204` (`409 pairing_closed` se non più in attesa) |
| `GET /conflicts` | — | `ConflictSummary[]` |
| `GET /conflicts/:id` | — | `ConflictDetail` |
| `POST /conflicts/:id/resolve` | `{ resolution: keep_mine \| keep_incoming \| keep_both \| { manual: text }, expectedIncomingAt }` | `204` (`409 stale_resolution`, `404 not_found` = già risolto) |
| `POST /conflicts/resolve-all` | `{ strategy, ids }` | `{ resolved }` |
| `GET /vaults/:id/files?q=` | — | `{ files: { fileId, path, versions, lastChangedAt }[] }` (file con storico; ricerca per percorso) |
| `GET /files/:id/versions` | — | `{ fileId, path, versions: { id, at, device, size, current }[] }` |
| `GET /versions/:id` | — | `{ id, path, at, mime, size, text: string \| null, previewUrl: string \| null }` |
| `POST /versions/:id/restore` | — | `204` (diventa la versione corrente; la precedente resta nello storico) |
| `GET /vaults/:id/trash` | — | `{ items: { fileId, path, deletedAt, expiresAt, size }[] }` |
| `POST /trash/:fileId/restore` | — | `204` |

Tipi principali:
- `Vault = { id, name, fileCount, deviceCount, level, conflicts, usedBytes, historyBytes, trashBytes, retentionDays, maxRetentionDays, historyFrom }` (`historyFrom` = data più vecchia ripristinabile; `level` come in `@kamino/status`).
- `Device = { id, vaultId, vaultName, name, platform, pluginVersion, lastSeenAt, lastSyncAt \| null, lag, pending, lastError \| null, level, revoked }`.
- `ConflictSummary = { id, vaultId, vaultName, path, kind, binary, mine: { device, at }, incoming: { device, at } }`; `ConflictDetail` = summary + `{ mineText, incomingText }` (testo) oppure `{ mineFile, incomingFile }` con `{ size, mime, previewUrl }` (binario).
- `GET /vaults/summary` della 4a resta (stato e contatore nella barra laterale), calcolato dagli stessi dati.

Nuovi `ErrorCode`: `confirm_mismatch`, `history_window`, `pairing_closed`. Riusati: `stale_resolution`, `not_found`.

## 4. Pagine

### 4.1 Panoramica (`/`)
- **Spazio**: barra "{usato} di {limite}" (o "{usato}, nessun limite"); **≥ 90%** avviso ambra "Spazio quasi esaurito" (Q-05).
- **Vault**: card per vault con pallino di stato, nome (serif), `LevelBadge`, file, dispositivi, conflitti; clic → dettaglio.
- **Dispositivi da guardare**: dispositivi con livello ≥ Attenzione (nome, vault, motivo), max 5, link "Tutti i dispositivi".
- Bottone **Aggiungi un dispositivo** (scelta del vault se più di uno).
- Nessun vault: testo che spiega di crearlo dal plugin ("Il primo vault si crea da Obsidian, con il plugin").

### 4.2 Vault (`/vaults`, `/vaults/$vaultId?tab=`)
- Elenco: le stesse card della panoramica.
- Dettaglio: intestazione (nome, `LevelBadge`, file, dispositivi, spazio "{totale} · storico {x} · cestino {y}"), schede con `tab` nella ricerca (`devices` predefinita, `conflicts`, `history`, `settings`):
  - **Dispositivi**: righe (nome, piattaforma, ultimo sync, badge) → dettaglio dispositivo; "Aggiungi un dispositivo".
  - **Conflitti**: elenco dei conflitti del vault → centro conflitti filtrato.
  - **Storico e cestino**: ricerca per percorso + elenco file con storico → storico del file (§4.5); sotto, il **cestino** (§4.6).
  - **Impostazioni**: rinomina; retention dello storico (0…`maxRetentionDays` giorni, H-02); **Scarica ZIP** ("Stato attuale" o "Com'era il…" con data e ora entro `historyFrom`); **Elimina il vault** in una zona separata: finestra che spiega la cancellazione definitiva (crypto-shredding) e chiede di digitare il nome.

### 4.3 Dispositivi (`/devices`, `/devices/$deviceId`)
- Elenco di tutti i dispositivi (nome, vault, piattaforma, ultimo sync, badge); i revocati in fondo, attenuati, con "Revocato".
- Dettaglio (D-06): piattaforma, versione del plugin, ultimo contatto, ultimo sync riuscito, ritardo ("{n} modifiche indietro"), modifiche in attesa, ultimo errore. **Rinomina**. **Revoca** con conferma: "Il dispositivo smette subito di sincronizzare. I file già presenti sul dispositivo non vengono cancellati." (D-05).

### 4.4 Aggiungi un dispositivo (finestra)
Scelta del vault (se serve) → `POST /vaults/:id/pairings` → QR (`uqr`) + link copiabile + "Valido ancora {mm:ss} · usabile una volta sola"; polling di `GET /pairings/:id` ogni 2 s; `requested` → la finestra mostra nome, piattaforma, versione e **codice** con "Approva solo se sul nuovo dispositivo vedi lo stesso codice"; Approva/Rifiuta (disattivati durante l'invio); esiti `approved`/`denied`/`expired`/`pairing_closed` spiegati; chiusura → `cancel` se ancora in attesa; nessun aggiornamento dopo la chiusura.

### 4.5 Storico di un file
Pannello (finestra) con l'elenco delle versioni (data, dispositivo, dimensione, "attuale") → anteprima della versione (testo in `pre`, immagine, oppure "Anteprima non disponibile") → **Ripristina questa versione** (conferma breve: "Diventa la versione attuale; quella di adesso resta nello storico.").

### 4.6 Cestino
Elenco (percorso, eliminato il, "si cancella definitivamente il {data}", dimensione) → **Ripristina**. Testo fisso: "I file eliminati restano qui almeno 7 giorni." (H-01).

### 4.7 Centro conflitti (`/conflicts`, `/conflicts/$conflictId`)
- **Desktop (≥ 1024 px)**: colonna sinistra con i conflitti raggruppati per vault (nome file, dispositivo, ora), voce selezionata evidenziata; a destra il dettaglio del selezionato. Nessun conflitto: "Nessun conflitto da risolvere" con badge "Tutto al sicuro".
- **Telefono**: `/conflicts` è l'elenco, `/conflicts/$id` il dettaglio a tutta pagina con "Indietro".
- **Dettaglio testo**: intestazione come nel plugin (versioni, dispositivi, "Entrambe le versioni sono salvate", differenze); diff **affiancato** su desktop, **schede La tua / Differenze / In arrivo** su telefono (stesse regole del plugin); azioni Tieni la mia · Tieni quella in arrivo · Tieni entrambe · Modifica e unisci… → Salva l'unione / Annulla.
- **Binari**: due riquadri con anteprima per le immagini; niente Modifica e unisci.
- Dopo una risoluzione: toast con lo stesso testo del plugin, il conflitto sparisce dall'elenco e si apre il successivo (o lo stato vuoto). `stale_resolution` → ricarica + avviso; `not_found` → "già risolto" (un'unione in corso resta visibile per copiarla). Azioni disattivate durante l'invio.
- **Risolvi tutti…** (≥ 2 conflitti): finestra con le tre strategie, nessuna preselezionata, "Si applica a {n} file" (solo i conflitti mostrati), Applica disattivato finché non si sceglie.
- **Adattatore React** `DiffView` per `@kamino/ui-diff` (`createDiffView` in un effetto, `destroy` alla pulizia, `getMerged` tramite ref); frasi di CodeMirror tradotte come nel plugin; colori del diff unificato riallineati (la tua = rosso, in arrivo = verde) con i token di stato.

### 4.8 Rinvii della 4a
- All'accesso (e quando cambia l'utente) lingua e tema di `me` vengono applicati all'interfaccia.
- Le route Conflitti e Storico (CodeMirror) sono caricate a richiesta; obiettivo: nessun chunk > 500 KB nella build.

## 5. MSW
Dati di prova condivisi da tutti gli utenti: vault **Note** (3 dispositivi, 2 conflitti: `Spesa.md` testo, `Progetti/Piano.md` lungo) e **Lavoro** (1 dispositivo, 1 conflitto binario `Foto/vacanza.svg`); dispositivi con stati diversi (al sicuro, offline da 2 giorni con modifiche in attesa, revocato, con ultimo errore); quota 2,1 GB di 10 GB (preset "quota quasi piena" dal pannello di sviluppo); file con 3–5 versioni; 3 file nel cestino. Simulazioni dal pannello: "Richiesta di collegamento in arrivo" (per la finestra di §4.4), "Versione più recente in arrivo" (prossima risoluzione → `stale_resolution`).

## 6. Test
- Contratto: esempi validi e casi limite per ogni schema nuovo.
- Handler MSW: ogni rotta (inclusi `confirm_mismatch`, `history_window`, `pairing_closed`, `stale_resolution`, `not_found`, ripristini).
- Pagine: panoramica (quota e avviso ≥ 90%, card, dispositivi da guardare, stato vuoto); vault (schede da ricerca URL, rinomina, retention, ZIP con data fuori finestra, eliminazione con nome sbagliato/giusto); dispositivi (D-06, rinomina, revoca con conferma); aggiungi dispositivo (QR, richiesta, approva/rifiuta, chiusura → cancel, nessun polling dopo la chiusura); centro conflitti (elenco raggruppato, selezione, ogni azione → richiesta giusta + toast + passaggio al successivo, stale, già risolto, risolvi tutti con scelta obbligatoria, telefono a due pagine); storico (versioni, anteprima, ripristino); cestino (ripristino); lingua/tema applicati da `me`.
- `DiffView`: montaggio, `destroy` allo smontaggio, `getMerged`.
- Build: nessun chunk > 500 KB; MSW e dati finti assenti (test esistente).

## 7. Consegna
Branch `ui-web-user`; piano in `docs/superpowers/plans/`; esecuzione a blocchi; revisione finale con un subagente; PR. Documentazione: `docs/ui/design-system.md` §10, HANDOVER, changeset (`@kamino/web` minor, `@kamino/protocol` incluso nel gruppo ignorato). **Uscita:** prova del committente nel browser.
