# M1d — Motore di sync del plugin

> Stato: **approvata** · Data: 2026-11-10 · Branch: `m1d-plugin-engine`
> M1: M1a sync-core, M1b crypto + auth, M1c server (fatte), **M1d** (questa). Il committente ha scelto di procedere **senza gli esiti degli spike** R-1…R-5: le ipotesi usate qui sono in §8 e i test da eseguire sui dispositivi in §9.
> Riferimenti: [03 — protocollo](../../03-sync-protocol.md) §4–8, §11; [06 — roadmap](../../06-roadmap.md) M1; spec M1a (Z1–Z13, contratto del guscio Z11), M1c (C1–C10), M2a (D1–D8); [spike](../../spikes/README.md).

## 1. Decisioni

| # | Decisione |
|---|---|
| E1 | **Perimetro:** guscio di `step()` di `sync-core`, collegamento vero con credenziali, stato vero (indicatore, pannello, trasferimento iniziale), cartelle sul client (Z9), impostazioni da `/vault/settings` e `/device/settings`. Abbinamento con QR (M6) e risoluzione dei conflitti (M3) restano visibili ma **disattivati con "in arrivo"** nelle build di produzione; il `FakeServer` resta solo nelle build di sviluppo. WebSocket e modalità Live in M2b. |
| E2 | **Nuovo pacchetto `packages/sync-engine`**, indipendente dalla piattaforma: esecutore degli effetti, ciclo di sync, scanner con cache degli stat, trasferimenti, retry, stato. Parla con due porte, `VaultFs` e `Http`. Il plugin fornisce gli adattatori Obsidian; i test del server usano lo stesso motore con un file system in memoria contro il server vero. |
| E3 | **File grandi, streaming dove possibile**, scoperto a runtime. Lettura: `fetch` sull'URL della risorsa (`getResourcePath`) a pezzi, con SHA-256 incrementale (`@noble/hashes`); se lo stream manca o fallisce → `readBinary`. Scrittura: download con `Range` a pezzi di 4 MiB e `appendBinary` su un file temporaneo nella cartella del plugin, poi `rename` atomico; senza `appendBinary` (Obsidian < 1.12.3) → `writeBinary`. Il risultato si verifica sempre con l'hash atteso prima di metterlo al suo posto. Nel modo di ripiego, su mobile, i file oltre **100 MB** (configurabile) restano "rimandati" e visibili nel pannello. |
| E4 | **Scanner e watcher:** cache degli stat (path → dimensione, mtime, hash), così la scansione non ri-hasha i file invariati; eventi del vault con debounce (5 s per il file aperto nell'editor, ~1,5 s per gli altri, 03 §8) → ciclo; le rinomine → `localRename`. Ogni ciclo fa una scansione completa (contratto Z11). |
| E5 | **Stato durevole** (`durable` di `sync-core`, cache degli stat, sessioni di upload in corso) nella cartella del plugin, scritto in modo atomico (file temporaneo + rename). `persist` è sempre il primo effetto (write-ahead); dopo un crash la scansione successiva decide. |
| E6 | **Rete:** REST con `requestUrl`, intestazione `Kamino-Protocol`, Bearer del dispositivo. Push = `blobs/check` → upload a chunk con ripresa → `commits`; pull = `changes` (→ `snapshot` su `cursor_too_old`) → `ack`; `status` dopo ogni ciclo. Retry con `retryDelay` (1 s → 5 min, jitter). Cicli: all'avvio, al resume, dopo modifiche locali, su "Sincronizza ora" e **pull periodico ogni 60 s** (ponte fino al WebSocket di M2b). `401 device_revoked` ferma il motore e chiede di ricollegare. HTTPS obbligatorio su mobile. |
| E7 | **Collegamento vero:** `ConnectionService` sulle rotte di M1c (login con TOTP nella stessa richiesta, `totp_mandatory` con un messaggio chiaro, elenco/creazione vault, collegamento, rinomina, scollegamento). `InitialTransfer` mostra file e byte del primo ciclo, con pausa e ripresa. |
| E8 | **Stato vero:** `SyncStateSource` derivato dal motore (livello con `@kamino/status`, modifiche in attesa, file rimandati, errori), mai silenzioso (S-05). I conflitti aperti sul server sono elencati; la risoluzione arriva in M3. |
| E9 | **Cartelle sul client** (Z9) in `sync-core`: `mkdir`, spostamento e cancellazione di cartelle (l'arbitro le gestisce già); simulazione profonda rieseguita. |
| E10 | **Impostazioni:** all'avvio e alla voce `vault_settings_changed` il motore legge le impostazioni effettive e le passa a `config` di `step()`. Le categorie del plugin (`core`, `enabledPlugins`, `installedPlugins`) si mappano su quelle del contratto (`base`, `pluginList`, `plugins`). Una modifica della configurazione non si applica a caldo (S-12): il plugin propone di ricaricare Obsidian. |

## 2. `packages/sync-engine`

```ts
interface VaultFs {
  list(): Promise<FsEntry[]>;                       // file e cartelle, path canonici
  stat(path: string): Promise<{ size: number; mtime: number } | null>;
  read(path: string): AsyncIterable<Uint8Array>;   // a pezzi quando possibile
  write(path: string, parts: AsyncIterable<Uint8Array>, expect: string | null): Promise<WriteOutcome>;
  rename(from: string, to: string): Promise<boolean>;
  trash(path: string, expect: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  /** Stato del plugin (index, cache): scrittura atomica. */
  loadState(name: string): Promise<string | null>;
  saveState(name: string, data: string): Promise<void>;
}
interface Http {
  request(req: { method: string; path: string; json?: unknown; body?: Uint8Array; headers?: Record<string, string> }): Promise<{ status: number; json?: unknown; body?: Uint8Array }>;
}
```

Componenti: `Engine` (ciclo di vita, coda degli eventi verso `step()`, un solo `step` alla volta), `Executor` (effetti in ordine, Z11), `Scanner` (con `StatCache`), `Transfers` (upload a chunk con ripresa, download a pezzi), `Api` (rotte tipizzate con gli schemi di `@kamino/protocol`), `Status` (deriva `SyncSnapshot`). Tempo e casualità iniettati.

## 3. Plugin

- `apps/plugin/src/engine/obsidian-fs.ts`: `VaultFs` su `app.vault.adapter` (streaming di E3 con rilevamento).
- `apps/plugin/src/engine/obsidian-http.ts`: `Http` su `requestUrl` (`throw: false`).
- `connection/real-server.ts`: `ConnectionService` e `InitialTransfer` veri.
- `state/engine-state.ts`: `SyncStateSource` dal motore.
- `main.ts`: il `FakeServer` solo con la costante di sviluppo; le azioni non ancora supportate (QR, risoluzione) mostrano "in arrivo".

## 4. Errori

- Rete assente o server irraggiungibile: il motore riprova con backoff; lo stato mostra "non raggiungibile" con l'orario (S-05).
- `401 device_revoked`: motore fermo, notice e invito a ricollegare. `403 user_blocked`: motore fermo, messaggio chiaro.
- `426 protocol_unsupported`: motore fermo, "aggiorna il plugin".
- File non leggibile o scrittura fallita: l'effetto riporta `ok: false`; `sync-core` decide (ripete al ciclo dopo).
- Mai nei log: path, contenuti, token.

## 5. Test

- `sync-engine`: unità con porte finte; proprietà (fast-check) con crash in punti casuali tra gli effetti, verificando che dopo la ripresa nessun file vada perso e lo stato converga.
- **Integrazione col server vero** (in `apps/server/test`): onboarding di un vault da migliaia di file; ricostruzione da un secondo dispositivo; kill di client e server durante l'upload senza perdite (uscita di M1); server assente con lo stato corretto; `cursor_too_old` → snapshot.
- Plugin: adattatori Obsidian sui mock esistenti; build di produzione senza `FakeServer` (controllo sul bundle).

## 6. Consegna

Branch `m1d-plugin-engine`; piano a blocchi: (A) `sync-engine` e porte; (B) cartelle in `sync-core`; (C) rete e file grandi; (D) integrazione col server vero; (E) adattatori Obsidian, collegamento e stato nel plugin; (F) impostazioni e build di produzione; (G) documenti, revisione, PR. Changeset per il plugin (minor) e il server (patch, se cambia).

## 7. Fuori perimetro

WebSocket e modalità Live/Periodica/Manuale (M2b); riconciliazione con contenuto locale D-07 (M2b); risoluzione dei conflitti (M3); abbinamento QR (M6); allegati solo in Wi-Fi (M2b, dipende da R-2).

## 8. Ipotesi senza spike

| Spike | Ipotesi usata | Dove |
|---|---|---|
| R-1 | Lo stream dell'URL della risorsa e `appendBinary` funzionano dove esistono; il ripiego in memoria regge fino a 100 MB su mobile | E3 |
| R-2 | Nessuna (Wi-Fi in M2b) | — |
| R-3 | Il merge di `@codemirror/merge` su mobile (risoluzione in M3) | — |
| R-4 | Nessuna (WebSocket in M2b); al resume si avvia un ciclo REST | E6 |
| R-5 | Una cartella spostata produce un `rename` per ogni file; il debounce raccoglie la raffica; la scansione completa del ciclo corregge eventuali eventi persi | E4 |

## 9. Test da eseguire sui dispositivi (alla fine di M1d)

L'elenco definitivo, con cosa misurare e i criteri, si consegna alla chiusura di M1d in `docs/spikes/README.md`: R-1 (file da 50/200/500 MB su iPhone e Android, con il motore vero), R-4 (resume e cambio di rete con il pull periodico), R-5 (spostamento di una cartella da 2.000 file), R-3 e R-2 quando arriveranno M3 e M2b, più una prova d'uso di una settimana con un desktop e un telefono.
