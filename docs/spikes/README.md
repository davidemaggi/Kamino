# Spike M0 (R-1…R-5)

Prototipi usa-e-getta per i rischi tecnici di [`02-architecture.md` §10](../02-architecture.md#10-rischi-tecnici-e-spike). Il codice è in [`spikes/`](../../spikes/), un progetto **autonomo, fuori dal workspace pnpm**, da cancellare alla chiusura della milestone.

> **Stato:** prototipi costruiti e verificati in locale (type-check, build, test e smoke test del server di prova). Il plugin di spike **non è stato eseguito dentro Obsidian**: le misure vanno raccolte dal committente su dispositivi reali seguendo i documenti qui sotto. La chiusura (aggiornamento di §10, eventuali ADR, cancellazione di `spikes/`) è rinviata a quando gli esiti saranno disponibili.

## Indice

| ID                    | Domanda                                                               | Dispositivi                  | Stato                                    |
| --------------------- | --------------------------------------------------------------------- | ---------------------------- | ---------------------------------------- |
| [R-1](R-1.md)         | File grandi su mobile: memoria, tempi, API di lettura parziale/append | iPhone, Android, desktop     | PENDING (in attesa di dispositivi reali) |
| [R-2](R-2.md)         | Tipo di rete (`navigator.connection`) in Obsidian mobile              | iPhone, Android              | PENDING (in attesa di dispositivi reali) |
| [R-3](R-3.md)         | `@codemirror/merge` in un modal del plugin                            | desktop, iPhone, Android     | PENDING (in attesa di dispositivi reali) |
| [R-4](R-4.md)         | WebSocket in background/resume e al cambio di rete                    | iPhone, Android (+ desktop)  | PENDING (in attesa di dispositivi reali) |
| [R-5](R-5.md)         | Eventi del vault durante operazioni massicce                          | desktop, iPhone, Android     | PENDING (in attesa di dispositivi reali) |

## Cosa c'è in `spikes/`

```
spikes/
  package.json              progetto autonomo (NON nel workspace), versioni esatte
  pnpm-lock.yaml
  obsidian-spike-plugin/    plugin di prova, id "kamino-spike", isDesktopOnly: false
    src/                    un modulo per spike (r1-…, r2-…, …), note di risultato in report.ts
    esbuild.config.mjs      produce dist/ (CodeMirror di Obsidian) e dist-bundled/ (CodeMirror incluso)
  test-server/              server di prova Node (node:http + ws): upload a chunk (R-1), WebSocket + catch-up (R-4)
```

Il plugin usa solo API di Obsidian, `requestUrl`, `fetch` sugli URL delle risorse del vault, WebSocket, WebCrypto e `@noble/hashes`; nessuna API Node/Electron.

## Setup comune

### 1. Preparare il progetto (sul computer)

Serve Node ≥ 22.12 e pnpm 10.

```bash
cd spikes
pnpm install --ignore-workspace   # obbligatorio: spikes/ non fa parte del workspace
pnpm typecheck                    # opzionale
pnpm build                        # → obsidian-spike-plugin/dist/ e dist-bundled/
pnpm test                         # test unitari del server di prova (opzionale)
```

Ogni cartella `dist*/` contiene `main.js`, `manifest.json`, `styles.css`.

- `dist/` (variante **external**, quella di default): `@codemirror/state`, `@codemirror/view`, `@codemirror/language` e `@lezer/*` sono quelli forniti da Obsidian; solo `@codemirror/merge` è incluso nel bundle.
- `dist-bundled/` (variante **bundled**): tutto incluso tranne `obsidian`. Serve solo per R-3, se la variante external fallisce.

### 2. Usare un vault di prova dedicato

**Mai un vault reale**: gli spike creano file da centinaia di MB e 10.000 note. Creare su ogni dispositivo un vault vuoto, ad esempio `kamino-spike`, in **memoria locale** del dispositivo (non iCloud, non cartelle sincronizzate da altri strumenti), salvo dove indicato.

### 3. Installare il plugin di spike

Copiare i tre file di `dist/` in `<vault>/.obsidian/plugins/kamino-spike/`, poi in Obsidian: _Impostazioni → Plugin della community_ → disattivare la modalità con restrizioni → ricaricare l'elenco → attivare **Kamino spike (M0, throwaway)**.

- **Desktop:** copia diretta nella cartella del vault.
- **Android:** collegare il telefono via USB (trasferimento file) o usare un file manager; la cartella del vault è dove è stata creata (di solito `Documents/<vault>`). La cartella `.obsidian` è nascosta: abilitare la visualizzazione dei file nascosti nel file manager.
- **iPhone:** l'app File non mostra le cartelle che iniziano con il punto. Due strade:
  1. **consigliata:** nel vault di prova, _Impostazioni → File e link → Sovrascrivi cartella di configurazione_ (“Override config folder”) e impostare ad esempio `_obsidian`; riavviare Obsidian. Poi, con l'app File, copiare i tre file (ricevuti via AirDrop o da iCloud Drive) in `Sul mio iPhone/Obsidian/kamino-spike/_obsidian/plugins/kamino-spike/`;
  2. in alternativa: vault su iCloud Drive, e copia dei file da un Mac o da Windows con iCloud per Windows. In questo caso annotare nei risultati che il vault è su iCloud (può influire su R-1 e R-5).

Dopo l'attivazione, in _Impostazioni → Kamino spike (M0, throwaway)_ impostare:

- **Test server URL**: l'URL del server di prova (vedi sotto), senza `/` finale;
- **Device label**: un'etichetta breve, ad esempio `iphone13-ios18`, `pixel7-android15`, `win11`.

Tutti i comandi si lanciano dalla palette dei comandi (desktop: `Ctrl/Cmd+P`; mobile: icona della palette o scorrimento verso il basso) cercando `Kamino spike`. Ogni comando scrive una nota in **`Kamino spike results/`** con nome `R-n <device> <data ora>.md` e mostra un avviso. Le note vengono scritte riga per riga: se l'app si chiude o va in crash, l'ultima riga presente è l'ultimo passo completato.

### 4. Avviare il server di prova (R-1, R-4)

Sul computer, nella stessa rete dei telefoni:

```bash
cd spikes
pnpm server                        # porta 8787 (oppure: pnpm server --port 9000, o SPIKE_PORT=9000)
```

All'avvio stampa gli URL di rete locale (`LAN URL: http://192.168.x.y:8787`); ogni richiesta e ogni connessione WebSocket viene registrata con data e ora. Consentire Node nel firewall del computer se richiesto. Prova rapida dal computer: `pnpm smoke http://localhost:8787` deve stampare `SMOKE OK`.

### 5. Note di rete: HTTP o HTTPS

Obsidian mobile potrebbe rifiutare `http://` in chiaro (App Transport Security su iOS, contenuto misto per `ws://` nella WebView). È parte di ciò che misuriamo, quindi procedere in quest'ordine e **annotare in ogni documento quale strada ha funzionato**:

1. **HTTP sulla LAN** (`http://192.168.x.y:8787`): la più semplice. Se `requestUrl` o il WebSocket falliscono con errori di rete o di sicurezza, passare al punto 2.
2. **HTTPS via Tailscale:** installare Tailscale sul computer e sul telefono (stessa tailnet), poi sul computer `tailscale serve --bg 8787`; l'URL è `https://<nome-computer>.<tailnet>.ts.net`. Il traffico resta nella tailnet.
3. **HTTPS via Cloudflare quick tunnel:** `cloudflared tunnel --url http://localhost:8787`; usare l'URL `https://….trycloudflare.com` stampato. È pubblico finché il comando è attivo: chiuderlo a fine prova. I tempi includono il passaggio da Cloudflare: non confrontarli direttamente con quelli in LAN.

Con HTTPS il WebSocket usa automaticamente `wss://` (il plugin sostituisce `http` con `ws` nell'URL).

| Dispositivo | HTTP LAN `requestUrl` | HTTP LAN WebSocket | Tailscale HTTPS | Cloudflare HTTPS | Note |
| ----------- | --------------------- | ------------------ | --------------- | ---------------- | ---- |
| iPhone      |                       |                    |                 |                  |      |
| Android     |                       |                    |                 |                  |      |
| Desktop     |                       |                    |                 |                  |      |

### 6. Riportare i risultati

Copiare dal telefono le note di `Kamino spike results/` (o il loro contenuto) e compilare le tabelle "Misure da registrare" di ogni documento, poi la sezione "Conclusione". Annotare sempre: modello del dispositivo, versione del sistema operativo, versione di Obsidian (_Impostazioni → Informazioni_; la nota riporta anche `apiVersion` e lo user agent).

### Pulizia

- Comandi `R-1: delete the large test files` e `R-5: delete the synthetic subtree`.
- Disinstallare il plugin e cancellare il vault di prova.
