# Design system

> Stato: **in revisione** (fase UI, sotto-fase 1) · Spec: [`2026-11-07-ui-fondamenta-design.md`](../superpowers/specs/2026-11-07-ui-fondamenta-design.md)

Questo documento descrive l'aspetto e il lessico visivo comuni a web app e plugin. La regola che lo guida è la promessa del prodotto: **"non perdi mai niente, e sai sempre se sei al sicuro"**. L'interfaccia deve far capire lo stato di sync a colpo d'occhio, senza allarmare quando va tutto bene.

## 1. Direzione visiva: C "Ibrida"

- **Base neutra** con una leggera tinta blu-ardesia presa dall'icona del prodotto.
- **Ciano** solo per azioni secondarie, link e focus (`--link`, `--ring`). Non è mai un colore di stato.
- **Primario:** blu notte in chiaro, ciano in scuro (bottoni principali).
- **Tipografia:** Source Serif 4 (600/700) per i titoli di pagina e delle card; Inter per tutto il resto. I font sono inclusi nell'app (`@fontsource`): nessuna richiesta a CDN esterni.
- **Icone:** Lucide (`lucide-react` nella web app, `setIcon` di Obsidian nel plugin).
- **Raggio:** 10 px (`--radius`).

Il plugin **non** usa questa palette: eredita il tema di Obsidian dell'utente e prende da qui solo il lessico degli stati (§3).

## 2. Token della web app

Definiti in [`apps/web/src/index.css`](../../apps/web/src/index.css) con lo schema di shadcn/ui ed esposti a Tailwind 4 (`bg-background`, `text-muted-foreground`, `bg-status-safe-surface`, …). Il selettore `:root, .light` imposta i valori chiari, `.dark` quelli scuri: entrambi si possono applicare a un sottoalbero (lo fa la galleria per affiancare i due temi).

| Token | Chiaro | Scuro |
|---|---|---|
| `--background` | `#f7f9f9` | `#0b1820` |
| `--card` | `#ffffff` | `#13232c` |
| `--foreground` | `#132a36` | `#e7eef0` |
| `--muted` | `#eef1f2` | `#1d3340` |
| `--muted-foreground` | `#5b6b73` | `#8a9ba3` |
| `--border` | `#e3e9eb` | `#1d3340` |
| `--primary` / `--primary-foreground` | `#0d2230` / `#ffffff` | `#4fd6e3` / `#071118` |
| `--link` (= `--ring`) | `#0b7685` | `#4fd6e3` |

Colori di stato (testo / superficie):

| Livello | Chiaro | Scuro |
|---|---|---|
| `safe` | `#0b6b52` / `#e3f6ef` | `#7ff0c9` / `#0e3b33` |
| `working` | `#3f5059` / `#eef1f2` | `#b4c3ca` / `#1d3340` |
| `attention` | `#8a5a00` / `#fbf0d9` | `#ffd166` / `#3a2e0c` |
| `decision` | `#5a3fb0` / `#efeafd` | `#c4b2ff` / `#2c2250` |
| `blocked` | `#a3261b` / `#fbe4e1` | `#ff9c90` / `#401a17` |

**Contrasto:** il test [`apps/web/src/theme/tokens.test.ts`](../../apps/web/src/theme/tokens.test.ts) calcola il rapporto WCAG di ogni coppia testo/sfondo, in chiaro e in scuro, e fallisce sotto 4.5:1. Se un ritocco lo rompe si corregge il valore del token, mai la soglia.

**Tema:** chiaro, scuro o sistema (`ThemeSwitcher`). Lo script esterno `public/theme-init.js` applica la classe `dark` prima del primo paint, così non c'è il lampo chiaro al caricamento; è un file esterno e non inline per restare compatibile con una CSP rigida.

## 3. Stati di sync

Lessico e logica stanno in [`packages/status`](../../packages/status) e sono condivisi da web e plugin: stesse parole, stesse icone, stessa precedenza.

| Livello | Id | Icone | Quando | Web | Plugin (variabile Obsidian) |
|---|---|---|---|---|---|
| Al sicuro | `safe` | `shield-check` | Coda vuota, almeno un sync confermato, nessun conflitto né blocco | verde | `--color-green` |
| In corso | `working` | `refresh-cw` (invio), `clock` (in coda, mai sincronizzato) | Modifiche in coda entro le soglie; dispositivo mai sincronizzato | grigio | `--text-muted` |
| Attenzione | `attention` | `cloud-off` (offline), `triangle-alert` | Server irraggiungibile ≥ 24 h, modifiche ferme ≥ 1 h, quota ≥ 90% | ambra | `--color-yellow` |
| Decisione | `decision` | `git-compare-arrows` | Conflitti da risolvere (entrambe le versioni conservate) | viola | `--color-purple` |
| Bloccato | `blocked` | `octagon-alert` | Quota piena, dispositivo revocato, accesso scaduto, protocollo incompatibile | rosso | `--color-red` |

- **Precedenza:** Bloccato > Decisione > Attenzione > In corso > Al sicuro. Il livello più grave dà il messaggio principale; le altre condizioni compaiono come messaggi secondari.
- **"Al sicuro" è onesto:** mai se ci sono modifiche in coda, conflitti, blocchi o se il dispositivo non ha mai sincronizzato. Con il server irraggiungibile ma la coda vuota resta "Al sicuro" (i dati sono già sul server) con la nota "Server non raggiungibile da …"; oltre 24 h diventa Attenzione.
- **Regole complete:** `describeStatus()` in [`packages/status/src/describe.ts`](../../packages/status/src/describe.ts), descritte nella spec §3.3 e verificate con test di proprietà.
- **Testi:** [`packages/status/src/messages.ts`](../../packages/status/src/messages.ts), in it/en, con plurali e durate compatte ("2 min", "3 h", "2 g"). Mai "0 modifiche non salvate".

## 4. Regole d'uso

- **Mai solo colore:** ogni stato ha sempre icona + testo (daltonismo, lettori di schermo).
- **Stato di un dispositivo:** pallino colorato accanto al nome (`StatusDot`), **mai** un bordo laterale colorato sulla card.
- **"In attesa" è grigio**, non ciano: il ciano è il colore delle azioni.
- **Ultimo sync confermato** sempre raggiungibile: tooltip del badge (web), etichetta accessibile e dettaglio al clic (plugin).
- **Testi:** solo via i18n (web: `react-i18next`; plugin: `src/i18n/*.json`) o `@kamino/status`. Il lessico a tema (clone, Jango, …) è vietato nei testi UI.
- **Risorse esterne:** nessuna (font, icone e CSS sono nel bundle).

## 5. Plugin

- **Classi CSS** in [`apps/plugin/src/styles.css`](../../apps/plugin/src/styles.css): `.kamino-status`, `.kamino-status--<livello>`, `.kamino-status-action--<livello>`. Solo variabili di Obsidian, nessun colore nostro: ogni tema della community resta coerente. Il prefisso è `PRODUCT_SLUG` (vedi [renaming](../renaming.md)).
- **Indicatore** (`StatusIndicator`):
  - **desktop:** voce nella barra di stato, sempre visibile;
  - **tutte le piattaforme:** icona nel ribbon che cambia col livello;
  - **mobile, dal livello Attenzione in su:** icona nell'intestazione della nota attiva (Obsidian mobile non ha la barra di stato); scompare quando il livello scende e segue il cambio di nota;
  - **notice** quando lo stato passa ad Attenzione o a un livello più grave. La ripetizione insistente prevista da S-05 arriva in M1 con il motore di sync.
- **Icone di riserva:** se la versione di Obsidian non ha un'icona recente, l'indicatore usa un nome più vecchio per lo stesso livello (`check`, `clock`, `alert-triangle`, `git-compare`, `x-octagon`) e lo segnala in console.
- **Clic** sull'indicatore (barra di stato, ribbon, azione nell'intestazione): apre il pannello di stato (§7). C'è anche il comando "Apri stato sync".
- Finché il motore di sync non esiste (M1), i dati vengono da uno stato finto vuoto: lo stato mostrato è "Mai sincronizzato".

## 6. Gallerie

**Web app:**

```bash
pnpm --filter @kamino/web dev
# http://localhost:5173/dev/gallery
```

Palette, tipografia, componenti, i 14 stati di esempio e una card dispositivo, con i temi chiaro e scuro affiancati e i selettori di tema e lingua. La galleria esiste solo in sviluppo: `test/build.test.ts` verifica che non sia nel bundle di produzione.

**Plugin:** la vault di prova sta in `vault/kamino/` (ignorata da git).

```bash
pnpm --filter @kamino/plugin build:vault
# build di sviluppo + copia in vault/kamino/.obsidian/plugins/kamino-sync/
# (un'altra vault: pnpm --filter @kamino/plugin build:vault -- <percorso>)
```

Aprire la vault in Obsidian, abilitare il plugin, poi dalla palette comandi **"Mostra galleria stati (sviluppo)"**: a ogni esecuzione l'indicatore passa allo stato di esempio successivo. Il comando esiste solo nella build di sviluppo (verificato dal test del bundle).

## 7. Pannello di stato e conflitti (plugin)

Spec: [`2026-11-08-ui-stato-conflitti-design.md`](../superpowers/specs/2026-11-08-ui-stato-conflitti-design.md). Le viste leggono da `SyncStateSource` e agiscono tramite `ConflictActions` (`apps/plugin/src/state/types.ts`); fino a M1/M3 l'implementazione è `FakeSyncState`, in memoria.

### Pannello di stato

- Vista nella barra laterale destra; su mobile la stessa vista appare nel cassetto laterale.
- **Riepilogo:** livello e messaggio (§3), messaggi secondari, ultimo sync confermato, "Sincronizza ora".
- **Sezioni**, mostrate solo se non vuote, in quest'ordine: **Conflitti** (clic su una riga → vista di risoluzione; "Risolvi tutti…" da 2 conflitti in su) · **Non ancora sul server** (prime 5 righe, poi "Mostra tutte") · **In attesa di Wi-Fi** ("Carica ora") · **Questo dispositivo** (sempre).
- Nello stato "Al sicuro" restano solo il riepilogo e "Questo dispositivo": niente rumore quando va tutto bene.

### Risoluzione di un conflitto

- Una scheda dell'editor per conflitto. Intestazione: nome del file, quando e dove sono nate le due versioni, "Entrambe le versioni sono salvate", numero di differenze.
- **Desktop:** diff affiancato, "La tua versione" a sinistra e "In arrivo" a destra. **Mobile:** schede **La tua / Differenze / In arrivo**, si apre su "Differenze" (diff unificato); le altre due mostrano il testo intero, pulito.
- **Colori del diff**, uguali nei due layout: la tua versione in rosso, quella in arrivo in verde (nel diff unificato il CSS del plugin riallinea i colori di `@codemirror/merge`).
- **Azioni:** Tieni la mia · Tieni quella in arrivo · Tieni entrambe · Modifica e unisci… (su mobile in colonna, a tutta larghezza).
- **Modifica e unisci** parte sempre dalla tua versione: su desktop le frecce portano un blocco da "in arrivo", su mobile ogni blocco ha "Tieni la mia" / "Prendi quella in arrivo". Poi "Salva l'unione" o "Annulla".
- **Regola delle scelte:** si applicano subito, con una notice che dice cosa è successo e che l'altra versione resta nello storico. Nessuna finestra di conferma, perché nessuna scelta distrugge dati.
- **Versione più recente arrivata nel frattempo:** la vista si ricarica e mostra un avviso; nessuna notice di successo. Se stavi unendo a mano resti in modifica, con la tua unione come base. **Conflitto risolto altrove:** la vista lo dice e offre "Chiudi"; un'unione non salvata resta visibile per poterla copiare.
- **Mentre una scelta viene inviata** le azioni sono disattivate (niente doppi invii); se l'invio fallisce compare un errore e la vista resta com'era.
- **File binari:** due riquadri (affiancati su desktop, impilati su mobile) con dispositivo, data, dimensione, tipo e anteprima se è un'immagine; niente "Modifica e unisci".

### Risolvi tutti…

Finestra con tre opzioni (tieni tutte le mie / tutte quelle in arrivo / entrambe per tutti), nessuna preselezionata; "Applica" resta disattivato finché non si sceglie. Si applica solo ai conflitti contati all'apertura: quelli arrivati dopo restano aperti. È l'unico punto con una conferma esplicita, perché un tocco cambia molti file.

### Gallerie del plugin

Con la build di sviluppo (`pnpm --filter @kamino/plugin build:vault`):

- **"Carica scenario conflitti (sviluppo)":** 3 conflitti (nota corta, nota lunga, immagine), 3 modifiche in coda, 1 file in attesa di Wi-Fi; apre il pannello.
- **"Apri diff di prova (sviluppo)":** diff di esempio nelle quattro combinazioni affiancato/unificato × sola lettura/modificabile (verifica R-3).
- **"Mostra galleria stati (sviluppo)":** come prima, ora fa cambiare anche il pannello.

## 8. Collegamento, pairing e impostazioni (plugin)

Spec: [`2026-11-08-ui-onboarding-design.md`](../superpowers/specs/2026-11-08-ui-onboarding-design.md). Le viste lavorano su `ConnectionService` e `InitialTransfer` (`apps/plugin/src/connection/types.ts`); fino a M1/M2 l'implementazione è `FakeServer`, in memoria.

### Scheda di benvenuto

- Si apre da sola all'avvio se il vault **non è collegato**; poi dal comando "Collega questo vault", da "Collega…" nel pannello di stato e dalle impostazioni. Si chiude da sola al collegamento.
- Tre strade: **È il primo dispositivo** · **Collega a un vault esistente** · **Ho un QR o un link** (istruzioni; su desktop anche un campo per incollare il link).
- Lo stato "Non collegato" (`working.notLinked`) non è mai "Al sicuro".

### Collegamento manuale

- Passi: server → accesso (codice TOTP nello stesso passo se richiesto) → vault (nome nuovo, oppure scelta dall'elenco) → nome del dispositivo → **riconciliazione** se la cartella locale ha già dei file → trasferimento iniziale.
- **Regola `http`:** su desktop è ammesso con un avviso ("Connessione non cifrata"); **su telefono è bloccato**, con le alternative (Tailscale, Cloudflare Tunnel, reverse proxy).
- Ogni errore ha il suo messaggio (indirizzo non valido, server irraggiungibile, versione incompatibile, credenziali errate, codice errato, account bloccato). La password non viene salvata né lasciata nella finestra.
- La riconciliazione arriva **prima** di toccare qualunque file: "quelli identici restano come sono, quelli diversi diventano conflitti da guardare. Nessun file viene sovrascritto."

### Trasferimento iniziale

Scheda con barra di avanzamento (file e MB), "Puoi continuare a lavorare", Pausa/Riprendi; interruzione con ripresa automatica; errore con "Riprova"; al termine "Apri lo stato sync".

### Pairing con QR o link

- **Origine** ("Aggiungi un dispositivo", solo da collegato): QR (nero su bianco, leggibile con qualunque tema), link copiabile, tempo rimasto, "usabile una volta sola"; alla scadenza "Genera di nuovo".
- **Nuovo dispositivo** (apre `obsidian://kamino?server=…&token=…`): nome del dispositivo, poi il **codice di 4 caratteri** grande e "approvala solo se vedi questo stesso codice"; attesa con scadenza; rifiuto/scadenza spiegati.
- **Approvazione**: la finestra dell'origine diventa la richiesta (nome, piattaforma, codice, Approva/Rifiuta). A finestra chiusa: notice cliccabile e sezione **"Richieste di collegamento"** in cima al pannello di stato.
- Altri avvisi: "Nuovo dispositivo collegato: {nome}" (collegamento con password) e "Il link è stato usato da un secondo dispositivo ed è stato bloccato".
- Link malformato → "Link di collegamento non valido", mai un errore inatteso; vault già collegato → spiegazione, nessuna azione.

### Impostazioni

Sezioni: **Collegamento** (server, utente, vault, nome del dispositivo, Aggiungi un dispositivo, Scollega con conferma) · **Sincronizzazione** (modalità e relative opzioni) · **File grandi** · **Esclusioni** (pattern non validi segnalati e ignorati; elenco di ciò che è sempre escluso) · **Cartella di configurazione** · **Informazioni**. Finché il motore di sync non esiste, una riga dice: "Queste impostazioni verranno usate quando il sync sarà attivo." I valori vivono in `data.json` (cartella del plugin, mai sincronizzata); un file vecchio o rovinato riporta ai valori di default.

### Prove con il server finto (build di sviluppo)

| Cosa | Come |
|---|---|
| Accesso | `demo` / `demo`; `demo2fa` / `demo` + codice `123456`; `locked` → account bloccato |
| Errori del server | host che contiene `unreachable` o `old`; `http://…` su telefono |
| Errori del link | token `expired`, `used`, `bad` |
| Comandi | "Mostra QR di prova", "Simula richiesta di collegamento", "Simula approvazione/rifiuto", "Simula nuovo dispositivo", "Simula interruzione/errore del trasferimento" (tutti "(sviluppo)") |
| Ricominciare da capo | "Scollega" nelle impostazioni (oppure cancellare `data.json` nella cartella del plugin) |

## 9. Web app: struttura e account

Spec: [`2026-11-08-ui-web-shell-account-design.md`](../superpowers/specs/2026-11-08-ui-web-shell-account-design.md).

### Struttura

- **Desktop:** barra laterale (240 px) con nome del prodotto, **stato complessivo** (il livello più grave tra i vault), Panoramica, Vault, Dispositivi, Conflitti (badge viola col numero), sezione **Amministrazione** solo per gli admin, in fondo Account, Informazioni, Esci e il ruolo. Voce attiva con sfondo tenue, mai bordo laterale.
- **Telefono:** barra in alto (menu, nome, badge di stato) e menu a scomparsa con le stesse voci.
- Accessibilità: `nav` con etichetta, `aria-current="page"`, "Vai al contenuto", titolo della finestra "{pagina} · {prodotto}".
- Banner in cima a ogni pagina dopo un reset della password avviato dall'amministratore, finché non si chiude.

### Accesso e account

- **Pagine pubbliche** (card centrata, scelta della lingua): accesso → codice TOTP o codice di recupero; setup iniziale (token dai log del server, il primo utente è admin); password dimenticata (stessa risposta che l'email esista o no; senza SMTP rimanda all'amministratore); nuova password; invito.
- **Regole:** password di almeno 12 caratteri; dopo un errore di accesso il campo password si svuota; dopo l'accesso si torna solo a percorsi interni (mai `//…` o altri siti).
- **TOTP:** QR + chiave, codice di verifica, **10 codici di recupero** (copia, scarica, casella "Li ho salvati" obbligatoria). Obbligatorio per gli admin: finché non è fatto è l'unica pagina disponibile.
- **Account:** Profilo (email, lingua, tema), Password, Verifica in due passaggi (gli admin non possono disattivarla), Sessioni attive (client, IP abbreviato, "Esci da tutte le altre"), Registro di sicurezza (20 voci per pagina).

### Dati in sviluppo (MSW)

Le pagine chiamano le API vere descritte in `@kamino/protocol` (`auth.ts`, `account.ts`); in sviluppo e nei test le risponde **MSW** con un database in memoria (`apps/web/src/mocks/`). Nella build di produzione MSW non c'è (test sulla build).

| Utente | Password | Note |
|---|---|---|
| `admin` | `admin-password-1` | admin, TOTP `123456`, codici di recupero `AAAA-1111`…`AAAA-1120` |
| `demo` | `demo-password-1` | utente senza TOTP |
| `newadmin` | `newadmin-pass-1` | admin che deve configurare il TOTP |
| `reset` | `reset-password-1` | mostra il banner del reset avviato dall'admin |
| `locked` | qualsiasi | account bloccato |

Link di prova: `/reset/reset-token`, `/invite/invite-token`, `/reset/expired-token`; codice di setup `setup-token`. Il pulsante **"Dati finti"** in basso a destra ripristina i dati, simula "nessun utente" (per vedere il setup), attiva/disattiva l'SMTP e permette di entrare come uno degli utenti di prova.

## 10. Web app: area utente

Spec: [`2026-11-08-ui-web-user-area-design.md`](../superpowers/specs/2026-11-08-ui-web-user-area-design.md). Dati dal contratto `@kamino/protocol` (`vaults.ts`, `devices.ts`, `conflicts.ts`, `history.ts`); in sviluppo e nei test li simula MSW.

- **Panoramica:** spazio usato (avviso ambra da 90% della quota, Q-05), card dei vault (pallino, nome, file, dispositivi, `LevelBadge`), "Dispositivi da guardare" (livello ≥ Attenzione), "Aggiungi un dispositivo". Senza vault: spiega che il primo si crea da Obsidian.
- **Vault:** intestazione (nome, stato, file, dispositivi, spazio con storico e cestino) + schede nell'URL (`?tab=devices|conflicts|history|settings`).
  - *Storico e cestino:* ricerca dei file, storico di un file (versioni, anteprima, "Ripristina questa versione": diventa l'attuale, la precedente resta nello storico); cestino con ripristino ("almeno 7 giorni").
  - *Impostazioni:* rinomina, retention (fino al massimo dell'admin), ZIP dello stato attuale o "com'era il…" (entro lo storico), **elimina** solo digitando il nome esatto.
- **Dispositivi:** elenco (revocati in fondo, attenuati) e dettaglio D-06 (piattaforma, versione, ultimo contatto e sync, ritardo, modifiche in attesa, ultimo errore), rinomina, **revoca** con conferma ("i file sul dispositivo non vengono cancellati").
- **Aggiungi un dispositivo (web):** scelta del vault, QR + link + scadenza, attesa; la richiesta mostra il **codice** con "approva solo se coincide"; Approva/Rifiuta; chiudendo la finestra l'offerta viene annullata.
- **Centro conflitti:** su desktop elenco raggruppato per vault a sinistra e dettaglio a destra (si apre il primo; dopo una scelta si passa al successivo); su telefono due pagine, con le schede "La tua / Differenze / In arrivo" come nel plugin. Stesse regole del plugin per azioni, "Modifica e unisci", versione più recente arrivata nel frattempo, conflitto già risolto, "Risolvi tutti…". Il diff è `@kamino/ui-diff` tramite l'adattatore React `DiffView`, caricato a richiesta (chunk separato).
- **Lingua e tema** salvati sul server vengono applicati all'accesso.
- **Pannello "Dati finti"** (sviluppo): in più "Richiesta di collegamento in arrivo", "Versione più recente in arrivo", "Quota quasi piena".

## 11. Web app: area admin

Spec: [`2026-11-08-ui-web-admin-design.md`](../superpowers/specs/2026-11-08-ui-web-admin-design.md). Dati dal contratto `@kamino/protocol` (`admin.ts`); in sviluppo e nei test li simula MSW. Visibile solo agli amministratori (per gli altri le rotte `/admin/*` non esistono).

- **Privacy (U-03):** l'admin vede degli altri utenti **solo numeri e stato aggregato** (spazio, vault, dispositivi, `LevelBadge`), mai nomi di vault, file o cartelle; la riga fissa "Per privacy non vedi nomi di vault né file degli utenti" lo dichiara in elenco e dettaglio.
- **Utenti:** tabella con spazio "usato / quota" e barra (ambra quando la quota è raggiunta), stato testuale (Attivo, Invitato, Bloccato, In cancellazione), ultimo accesso.
- **Crea utente:** invito via email (disattivato con la spiegazione se l'email non è configurata) oppure **link di attivazione** da consegnare a mano. L'admin non sceglie mai la password di un altro (U-10).
- **Link monouso** (attivazione e reset): mostrati **una sola volta** in un campo di sola lettura con "Copia"; il link di reset passa prima da una conferma che spiega cosa vedrà l'utente (U-09).
- **Dettaglio utente:** riepilogo; quota (illimitata o in GB, con avviso ambra se sotto lo spazio già usato: non cancella nulla); ruolo (l'ultimo amministratore non si può togliere: errore spiegato); zona pericolosa con Blocca/Sblocca ed Elimina, sempre con conferma; l'eliminazione chiede lo username esatto e offre lo ZIP solo con l'email configurata. Su sé stessi: niente blocco né eliminazione, con la frase che lo spiega.
- **Sistema** (schede nell'URL `?tab=config|health|audit`):
  - *Configurazione:* sezioni Registrazione, Quote e limiti, Email, ognuna col suo Salva. Un campo con valore dall'ambiente è **disattivato** e mostra "Impostato dall'ambiente" (E-03); la UI non lo invia e il server lo rifiuta (`config_locked`). La password SMTP è solo in scrittura (segnaposto "Impostata: lascia vuoto per non cambiarla"). "Accetta certificati non validi" mostra un avviso. **Invia email di prova** sta dopo Salva e mostra l'esito o l'errore tecnico dettagliato (E-04).
  - *Salute:* stato complessivo (pillola con i colori dei livelli), versione e nome in codice, tempo di attività, controlli (database, archivio dei file, disco, attività in coda, email) con testo, totali aggregati e dispositivi per stato.
  - *Registro:* quando, chi, azione localizzata, su cosa (username o chiave di configurazione, mai contenuti); 20 voci per pagina.
- **Pannello "Dati finti"** (sviluppo): in più "Email di prova fallisce"; "SMTP attivo/non configurato" vale anche per l'area admin.
