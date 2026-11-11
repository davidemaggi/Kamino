# M2b — Tempo reale nel plugin

> Stato: **approvata** (2026-11-11) · Data: 2026-11-11 · Branch: `m2b-plugin-realtime`
> M2 = M2a (server, fatta, PR #11) + **M2b** (questa). Base: motore di M1d (PR #12).
> Riferimenti: [01 — requisiti](../../01-requirements.md) S-02, S-03, S-05, S-08, D-07; [03 — protocollo](../../03-sync-protocol.md) §7–8; spec M2a (D1–D8), spec M1d (E1–E10); revisione finale di M1d in `docs/HANDOVER.md`.
> Spec "rigorosa" (accelerazioni del 2026-11-11): qui si possono perdere dati, quindi TDD, simulatore e revisione finale come in M1d.

## 1. Intento

Con M1d il plugin sincronizza davvero, ma solo a cicli (avvio, modifiche locali, pull ogni 60 s). M2b lo rende **in tempo reale**: una modifica fatta su un dispositivo arriva sugli altri in pochi secondi, senza aspettare il pull. Aggiunge anche le **modalità** della S-02, il rispetto delle **reti a consumo** (S-08) e gli **avvisi insistenti** (S-05). Così si arriva all'uscita di M2: due desktop e un telefono restano allineati per una settimana di uso reale.

**Obiettivi:** WebSocket nel motore; modalità Live / Periodica / Manuale; nessun lavoro inutile per gli eventi generati dalle scritture del motore stesso (eco); allegati grossi solo in Wi-Fi; avvisi che non si possono ignorare; i minori rinviati da M1d che toccano il motore.

**Non obiettivi:** risoluzione dei conflitti (M3); default di vault per la modalità impostabile dal web (pacchetto M4–M6); QR (M6); WebSocket nella web app.

**Anti-obiettivi:** il tempo reale non deve mai indebolire le garanzie di M1d. Una modalità cambia solo *quando* si sincronizza, mai *cosa* (S-04); un WebSocket caduto non deve mai far sembrare "al sicuro" qualcosa che non lo è; nessuna scrittura remota deve perdersi sul file aperto nell'editor.

## 2. Decisioni

| # | Decisione | Di chi |
|---|---|---|
| F1 | **WebSocket come notifica, dati via REST.** Il socket (`/api/v1/ws`, 03 §7) serve a sapere *subito* che c'è qualcosa: ogni `changes` del server avvia un pull REST (coalescente: un solo pull alla volta, uno in più se ne arrivano altri durante). `ack` e `status` restano REST come in M1d. Così `step()` non cambia e il catch-up resta quello già provato. Le chiusure del server mappano sugli stop del motore: `4401`/`4403` → revocato o bloccato (ricontrollato con una chiamata REST), `4410` → `resync`, `4426` → aggiornare il plugin; le altre → riconnessione con backoff (1 s → 5 min). | tech lead |
| F2 | **Porta `Socket` in `sync-engine`** (connect/send/onMessage/onClose), adattatori: `WebSocket` del browser nel plugin, `ws` nei test del server. Heartbeat: il client risponde ai `ping`; se non riceve nulla per 75 s chiude e si riconnette. | tech lead |
| F3 | **Modalità (S-02).** **Live**: socket aperto, invio dopo una pausa di scrittura (`liveDebounceSec`, 2–30 s, default 5 s per il file aperto nell'editor; ~1,5 s per gli altri), ricezione immediata; se il socket è giù, pull ogni 5 min finché non torna. **Periodica**: niente socket, un ciclo ogni `periodicMinutes`; le modifiche locali restano in coda (durevole) fino al ciclo. **Manuale**: solo "Sincronizza ora". In tutte: ciclo all'avvio e al ritorno in primo piano (S-03); cambio di modalità applicato subito, senza ricaricare. Il pull fisso ogni 60 s di M1d sparisce. La modalità resta per dispositivo; il default di vault arriva col pacchetto M4–M6. | requisiti (S-02, S-03), default di vault rinviato: tech lead |
| F4 | **Eco.** Le scritture, rinomine, cestinazioni e cartelle fatte dal motore generano eventi del vault: il motore tiene per pochi secondi l'elenco dei path che ha appena toccato e il watcher li ignora. Una modifica dell'utente sullo stesso file subito dopo resta comunque coperta dalla scansione del ciclo successivo. | tech lead |
| F5 | **File aperto nell'editor.** Prima di scrivere un file aperto nell'editor, se l'editor ha modifiche non salvate (buffer diverso dal disco) il motore **non scrive**: l'esito è `changed` e il ciclo dopo riparte dal contenuto dell'utente (che diventa un conflitto sul server se serve). Con il buffer pulito la scrittura avviene e Obsidian ricarica il file. Da verificare sui dispositivi (test aggiunto, minore M11). | tech lead |
| F6 | **Reti a consumo (S-08).** Opzione per dispositivo "allegati grossi solo in Wi-Fi" con soglia (default 10 MB, già nelle impostazioni). Rete letta da `navigator.connection` dove esiste (`cellular` o `saveData` → a consumo; `wifi`/`ethernet` → libera); su **iOS** sempre a consumo: alla prima occasione il plugin chiede conferma, con "non chiedere più per questa sessione"; su desktop mai a consumo; su Android senza informazione → libera. I file oltre soglia su rete a consumo restano **rimandati** nel pannello con "carica/scarica ora" (che li sblocca una volta). Note e file sotto soglia passano sempre. | requisiti (S-08); Android senza informazione: tech lead (R-2 non eseguito) |
| F7 | **Avvisi insistenti (S-05).** Quando lo stato è Attenzione o peggio da oltre la soglia (modifiche non inviate da più di 1 h in Live, server non raggiungibile da più di 24 h), una notice si ripete ogni ora finché la situazione non cambia; badge e indicatore come oggi. Soglie di `DEFAULT_THRESHOLDS`, non configurabili in M2b (§6.8). | requisiti (S-05); intervallo di ripetizione: tech lead |
| F8 | **D-07** (collegamento con contenuto locale): la logica c'è già (allineati se identici, conflitti `both_created` se diversi, mai sovrascritture); M2b collega al motore vero il passo "Riconciliazione" già disegnato nella sotto-fase UI 3 (conteggio dei file locali, spiegazione, conferma prima di partire). | requisiti (D-07), UI già decisa |
| F9 | **Minori rinviati da M1d** che toccano il motore e gli adattatori: M1 (sostituzione di un file: il vecchio messo da parte, non rimosso, poi rinomina, con recupero all'avvio); M2 (rinomine di sole maiuscole su Windows/macOS via nome temporaneo); M3 (cache degli stat: rihash dei file con mtime più recente di 2 s e voce invalidata quando una scrittura o un cestino trovano il file cambiato); M4 (streaming: ripiego per file, disattivato solo dopo fallimenti ripetuti, controllo dei byte letti con `stat.size`); M5 (HTTPS obbligatorio su mobile anche in `ObsidianHttp` e nel socket); M6 (`Engine.open` fallito ritentato); M7 (messaggi del login per 5xx e 426); M8 (`onunload` attende lo stop; file `.part` orfani ripuliti all'avvio); M9 (trasferimento iniziale "completato, N file in attesa"); M10 (impostazioni locali applicate subito, poi confermate dal server); M11 (test sul dispositivo per F5). | committente (HANDOVER), dettagli: tech lead |
| F10 | `PROTOCOL_VERSION` resta 1: M2b usa solo ciò che M2a ha già messo nel protocollo. | tech lead |

## 3. Vincoli

- Nessuna API Node/Electron nel plugin; `WebSocket` del browser va bene (CLAUDE.md). Su mobile solo `wss://`.
- Mai nei log: path, nomi, contenuti, token. Il token del dispositivo va nel messaggio `hello`, mai nell'URL.
- Il motore resta indipendente dalla piattaforma (porte); `sync-core` cambia solo se serve, e in quel caso si rieseguono i 3000 scenari (in CI).
- Su questo PC lento: test un pacchetto alla volta (vedi memoria/HANDOVER).

## 4. Test

- `sync-engine`: socket finto (messaggi, chiusure, silenzio); coalescenza dei pull; mappa dei codici di chiusura; modalità (timer finti); eco; reti a consumo; un test di proprietà con socket che cade, duplica e riordina le notifiche: alla fine convergenza e nessun contenuto perso.
- **Server vero** (`apps/server/test`): due motori con socket reale (`ws`) sullo stesso vault: una modifica su A arriva su B senza "Sincronizza ora"; revoca durante la connessione → motore fermo; server riavviato → riconnessione e convergenza; compattazione mentre B è connesso → `4410` → resync.
- Plugin: adattatori (`WebSocket`, rete), modalità nelle impostazioni, passo D-07, notice ripetute, file aperto con buffer sporco (mock).
- Ogni minore di F9 col suo test.

## 5. Consegna

Piano a blocchi: (A) socket e notifiche nel motore; (B) modalità, eco, file aperto; (C) reti a consumo e avvisi; (D) minori F9; (E) integrazione col server vero; (F) plugin (adattatori, impostazioni, D-07); (G) documenti, verifica, revisione finale, PR. Changeset `@kamino/plugin` minor.

## 6. Precisazioni dopo la verifica (scelte del tech lead)

1. **Cursore e notifiche.** Il `cursor` di `hello` è il cursore durevole del motore (quello che `sync-core` avanza dopo aver applicato le voci). Una notifica `changes` con `head` non oltre il cursore del motore si ignora; le altre avviano un pull (coalescente). I commit del dispositivo stesso tornano come `changes`, ma il pull che segue ogni push nello stesso ciclo porta il cursore alla testa, quindi la notifica successiva si ignora.
2. **Chiusure.** Il client risponde `pong` a ogni `ping`. `4409` (sostituito da un'altra connessione dello stesso dispositivo): nessuna riconnessione immediata, nuovo tentativo dopo 5 min con jitter, nel frattempo pull ogni 5 min (evita due finestre che si scacciano a vicenda). `4404`: verifica REST (`GET /device`); se anche lì il vault o il dispositivo non c'è più, il motore si ferma come per la revoca. `4410` → l'evento `resync` di M1d (snapshot riconciliato), poi riconnessione col nuovo cursore. `status` e `ack` restano REST (`POST /vaults/:vaultId/status`, `/ack`), come oggi.
3. **File rimandati per la rete (F6) senza toccare `sync-core`.** Stesso meccanismo dei rimandati di M1d: un upload rimandato non si carica (il commit riceve `blob_missing` e l'op resta in coda, durevole); un download rimandato chiude la scrittura con `ok: false` (la voce resta nell'indice come "non scaricata", il cursore avanza, nessuna perdita). "Carica/scarica ora" sblocca quel path una volta e avvia un ciclo. I rimandati **non contano come "al sicuro"**: l'indicatore mostra "in attesa del Wi-Fi" (livello Attenzione) ma **non** fanno scattare l'avviso insistente di F7, perché sono una scelta dell'utente.
4. **Modalità nel motore.** Il motore riceve la modalità (`setMode`) e gestisce i timer con il suo `Clock`. In Periodica e Manuale il watcher continua a segnalare le modifiche, che marcano lo stato "modifiche in attesa" senza avviare un ciclo (la coda deriva dall'indice al ciclo successivo, quindi è già compatta). In Live con il socket giù il debounce d'invio resta attivo. Al cambio di modalità il lavoro in corso finisce, il socket si chiude con `1000`. Sparisce `PULL_PERIOD_MS` (60 s); il debounce del file aperto è `liveDebounceSec` (impostazione, 2–30 s, default 5 s), quello degli altri file resta fisso a 1,5 s.
5. **File aperto con modifiche non salvate (F5)** è un controllo dell'adattatore `ObsidianFs.write` (ha accesso all'editor), non una porta nuova: buffer diverso dal disco → `changed`. La voce remota resta nell'indice (testa più nuova della base), il cursore avanza, niente si perde. Se poi l'utente salva, il suo `put` con la base vecchia diventa un conflitto sul server (entrambe le versioni conservate, elencato nel pannello; la risoluzione arriva in M3); se non cambia nulla, il ciclo dopo scrive la versione remota.
6. **Eco (F4)** con chiave sicura: per ogni path toccato il motore ricorda dimensione e mtime dopo l'operazione, per 10 s; il watcher ignora un evento solo se lo `stat` del file coincide. Una modifica dell'utente nella finestra cambia mtime o dimensione e passa.
7. **Rete (F6) come porta** `Network` fornita dal plugin: `metered(): "free" | "metered" | "ask"` e `ask(): Promise<boolean>` (la finestra di conferma su iOS, con "non chiedere più per questa sessione"). Finché la domanda è aperta i file oltre soglia restano rimandati. iOS = `Platform.isIosApp`. Su desktop la rete è sempre libera, quindi l'opzione `wifiOnly` (default solo su mobile) non ha effetto.
8. **Avvisi (F7)** con le soglie di `DEFAULT_THRESHOLDS` (1 h, 24 h), **non configurabili in M2b** (niente nuovo schema di impostazioni; correzione rispetto al §2). Le notice si ripetono solo con Obsidian aperto, ogni ora dalla prima, e si azzerano quando lo stato migliora.
9. **D-07:** la riconciliazione sul primo collegamento esiste già nel motore (snapshot su un indice vuoto: identici allineati, diversi `both_created`). F8 è solo collegare il passo "Riconciliazione" del `ConnectModal` (conteggio dei file locali, conferma) al flusso vero.
10. **Minori (F9)** nella stessa PR, nel blocco D **dopo** il blocco B (toccano lo stesso codice di F4/F5).
11. **Test:** il server finto di `sync-engine` (`src/testing/fake-server.ts`) riceve un canale di notifiche (un socket finto che emette `changes` a ogni commit) per il test di proprietà. La settimana d'uso con due desktop e un telefono è il criterio di chiusura di **M2**, non della PR.

## 7. Lasciato a chi costruisce

Struttura interna del client socket, nomi, intervallo esatto del ping lato client entro 75 s, forma degli eventi interni tra motore e watcher per l'eco, testo esatto delle notice (it/en, i18n).
