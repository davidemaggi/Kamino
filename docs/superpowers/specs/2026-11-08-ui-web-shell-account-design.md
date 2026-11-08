# Fase UI — Sotto-fase 4a: web app, struttura e account

> Stato: **in revisione** · Data: 2026-11-08 · Branch: `ui-web`
> Fonte: brainstorming del 2026-11-08 (scelte approvate dal committente durante la sessione).
> Parte da: [design system](../../ui/design-system.md), requisiti U-01…U-16, W-03…W-05, E-01, protocollo §3 (trasporto, cookie di sessione).

## 1. Decisioni

| # | Decisione |
|---|---|
| W1 | La sotto-fase 4 è divisa in **4a** (struttura e account), **4b** (area utente: panoramica, vault, dispositivi, centro conflitti, storico/cestino, aggiungi dispositivo) e **4c** (area admin). Questo documento copre la 4a. |
| W2 | Struttura con **barra laterale** su desktop (stato complessivo e contatore conflitti in alto, Amministrazione solo per admin, Account in fondo) e **barra in alto con menu a scomparsa** su telefono. |
| W3 | Dati: **client HTTP vero** (`fetch` + TanStack Query) su un contratto zod in `@kamino/protocol`; le API sono simulate con **MSW** (browser in sviluppo, Node nei test) finché il server non le implementa. |
| W4 | Router: **TanStack Router** (route, parametri e ricerche tipizzati). |

## 2. Perimetro

**Dentro:** `AppShell` responsive con navigazione completa (pagine di 4b/4c come segnaposto); pagine pubbliche (setup iniziale, accesso con TOTP o codice di recupero, password dimenticata, nuova password, invito); configurazione TOTP (obbligatoria per gli admin) con codici di recupero; avviso di reset avviato dall'admin; pagina Account (profilo, password, verifica in due passaggi, sessioni, registro di sicurezza); pagina Informazioni dentro la struttura; contratto in `@kamino/protocol`; client API; MSW con database finto e pannello di sviluppo; guardie di navigazione.

**Fuori:** contenuti di 4b e 4c; API vere del server (M1+); email reali; passkey/OIDC (U-15).

## 3. Contratto (`@kamino/protocol`, file `auth.ts` e `account.ts`)

Tutte le rotte sotto `/api/v1`; corpi JSON; errori nel formato `ErrorBody` esistente.

| Rotta | Richiesta | Risposta |
|---|---|---|
| `GET /setup/status` | — | `{ needed: boolean }` |
| `POST /setup` | `{ token, username, email, password }` | `Me` (sessione aperta) |
| `POST /auth/login` | `{ username, password }` | `{ status: "ok", me: Me }` \| `{ status: "totp_required", challengeId }` |
| `POST /auth/totp` | `{ challengeId, code }` (TOTP o codice di recupero) | `Me` |
| `POST /auth/logout` | — | `204` |
| `GET /me` | — | `Me` |
| `POST /auth/forgot` | `{ email }` | `{ smtp: boolean }` (stessa risposta che l'email esista o no) |
| `POST /auth/reset` | `{ token, password }` | `204` |
| `GET /invites/:token` | — | `{ username, email }` |
| `POST /invites/:token/accept` | `{ password }` | `Me` |
| `PATCH /account/profile` | `{ email?, lang?, theme? }` | `Me` |
| `POST /account/password` | `{ current, next }` | `204` |
| `POST /account/totp/setup` | — | `{ secret, otpauthUrl }` |
| `POST /account/totp/confirm` | `{ code }` | `{ recoveryCodes: string[] }` (10) |
| `POST /account/totp/disable` | `{ password }` | `204` (rifiutato per gli admin) |
| `POST /account/totp/recovery-codes` | `{ password }` | `{ recoveryCodes: string[] }` |
| `GET /account/sessions` | — | `Session[]` |
| `DELETE /account/sessions/:id` | — | `204` |
| `DELETE /account/sessions` | — | `204` (tutte tranne la corrente) |
| `GET /account/security-log?page=n` | — | `{ items: SecurityEvent[], page, pages }` |
| `GET /vaults/summary` | — | `{ vaults: { id, name, level, conflicts }[] }` (stato complessivo e contatore conflitti dell'`AppShell`; esteso in 4b) |

Tipi: `Me = { id, username, email, role: "user" | "admin", lang: "it" | "en", theme: "light" | "dark" | "system", totpEnabled, totpSetupRequired, adminResetAt: string | null }`; `Session = { id, current, client, ipPrefix, lastUsedAt }`; `SecurityEvent = { id, type: "login" | "login_failed" | "device_linked" | "password_changed" | "admin_reset" | "totp_enabled" | "totp_disabled", at, client? }`.

Nuovi `ErrorCode` (l'account bloccato usa l'esistente `user_blocked`): `invalid_credentials`, `totp_invalid`, `challenge_expired`, `setup_not_needed`, `setup_token_invalid`, `token_invalid`, `token_expired`, `password_weak`, `password_wrong`, `totp_mandatory`, `forbidden`. La web app traduce ogni codice in un testo i18n.

Password: minimo **12 caratteri** (`PASSWORD_MIN`), controllato nello schema (client) e dal server.

## 4. Sessione e sicurezza lato client

- Cookie di sessione `HttpOnly`, `SameSite=Lax` gestito dal server; il client non legge né salva token. `fetch` con `credentials: "include"`.
- Ogni richiesta che scrive manda `X-Requested-With: kamino-web` (anti-CSRF verificato dal server in M1).
- `401` su qualunque chiamata → `/login?redirect=<pagina>`; il redirect accetta solo percorsi interni (inizia con `/`, non con `//`).
- Nessun dato sensibile in `localStorage`: solo la preferenza del tema (già esistente).
- I campi password non vengono mai precompilati; dopo un errore di accesso il campo password si svuota.

## 5. Client e dati

- `apiClient.request(schema, path, init)`: `fetch` con le regole §4, validazione zod della risposta, errori trasformati in `ApiError { code: ErrorCode, status }` (risposta non conforme → `internal`).
- TanStack Query: `QueryClient` unico; chiavi `["me"]`, `["sessions"]`, `["security-log", page]`, `["vaults-summary"]`; invalidazioni dopo ogni scrittura.
- Messaggi d'errore: `errorMessage(code, t)` con le chiavi `errors.<code>`; codici senza testo dedicato → messaggio generico.

## 6. MSW

- `apps/web/src/mocks/db.ts`: stato in memoria (utenti con password in chiaro **solo nel finto**, sessioni, challenge TOTP, inviti, reset, registro, vault di prova). `resetDb(preset: "default" | "empty")`.
- `apps/web/src/mocks/handlers.ts`: un handler per rotta; **valida la richiesta** con lo schema e risponde con lo schema di risposta; imposta/cancella un cookie finto (`kamino_session`).
- Utenti di prova: `admin` / `admin-password-1` (admin, TOTP attivo, codice `123456`, codici di recupero `AAAA-1111`…), `demo` / `demo-password-1` (utente, senza TOTP), `newadmin` / `newadmin-pass-1` (admin senza TOTP: configurazione obbligatoria), `locked` (bloccato), `reset` / `reset-password-1` (utente con `adminResetAt` valorizzato). Token: setup `setup-token`, invito `invite-token` (utente `invited`), reset `reset-token`, scaduto `expired-token`. SMTP finto: attivo (cambiabile dal pannello).
- Avvio: in `main.tsx`, solo se `import.meta.env.DEV`, `await worker.start()` prima del rendering; nella build di produzione MSW non è presente (test sulla build, marcatore `data-msw`).
- **Pannello di sviluppo** (solo dev): pulsante flottante "Dati finti" con: ripristina, "nessun utente" (per il setup), SMTP sì/no, accesso rapido come `admin`/`demo`/`newadmin`.
- Nei test: `setupServer(...handlers)` in `src/test/msw.ts`, `resetDb()` prima di ogni test.

## 7. Router e guardie

Route (TanStack Router, albero dichiarato in codice):

```
/setup, /login, /forgot, /reset/$token, /invite/$token           pubbliche
/                      → Panoramica (segnaposto 4b)
/vaults, /devices, /conflicts                                     segnaposto 4b
/admin/users, /admin/system                                        segnaposto 4c (solo admin)
/account, /account/totp-setup, /about
```

- `beforeLoad` della radice protetta: `GET /setup/status` (se `needed` → `/setup`); `GET /me` (`401` → `/login?redirect=…`); `me.totpSetupRequired` → `/account/totp-setup` (unica pagina raggiungibile); `/admin/*` con `role !== "admin"` → pagina "non trovata".
- Le pagine pubbliche con utente già autenticato → `/`.
- La galleria di sviluppo resta su `/dev/gallery` (fuori dall'albero protetto, solo dev).

## 8. Schermate

### 8.1 Pagine pubbliche

Colonna centrata (card su `--background`), nome del prodotto da `@kamino/brand`, scelta della lingua in basso.

- **Accesso**: utente, password, "Accedi"; esito `totp_required` → la stessa card mostra "Codice di verifica" (6 cifre, `inputmode="numeric"`, `autocomplete="one-time-code"`) e il link "Usa un codice di recupero" (campo testo); errori: `invalid_credentials` ("Nome utente o password non corretti"), `user_blocked` ("Account bloccato: contatta l'amministratore"), `totp_invalid`, `challenge_expired` (torna al primo passo). Mai indicare se l'utente esiste. Link "Password dimenticata?".
- **Setup**: "Lo trovi nei log di avvio del server" + token, utente, email, password ×2; al termine → `/account/totp-setup`.
- **Password dimenticata**: email → con SMTP "Se l'indirizzo è registrato, ti abbiamo mandato un'email con le istruzioni."; senza SMTP "L'invio di email non è configurato: chiedi all'amministratore un link per reimpostare la password."
- **Nuova password** e **invito**: password ×2 con la regola dei 12 caratteri mostrata prima; token scaduto/non valido spiegato con link all'accesso.

### 8.2 Configurazione TOTP

Tre passi in una pagina: QR (`uqr`, SVG come nel plugin) + chiave copiabile e testo "Scansiona con un'app di autenticazione"; codice di verifica; **10 codici di recupero** (griglia monospazio, "Copia", "Scarica .txt", casella obbligatoria "Li ho salvati in un posto sicuro") → "Fine". Per gli admin con `totpSetupRequired` è l'unica pagina disponibile (nessuna navigazione, solo "Esci").

### 8.3 `AppShell`

- Desktop (≥ 1024 px): barra laterale 240 px; in alto nome del prodotto e `StatusBadge` del livello complessivo (il più grave tra `vaults/summary`); voci con icona Lucide: Panoramica, Vault, Dispositivi, Conflitti (badge viola con il numero se > 0), sezione "Amministrazione" (Utenti, Sistema) solo per admin; in fondo Account (nome e ruolo) ed Esci. Voce attiva con sfondo tenue (`--accent`), **mai bordo laterale colorato**.
- Telefono/tablet stretto: barra in alto (menu, titolo della pagina, badge di stato compatto); menu in un `Sheet` con le stesse voci.
- Accessibilità: `nav aria-label`, `aria-current="page"`, link "Vai al contenuto", focus intrappolato nel menu mobile, chiusura con Esc; titolo della finestra "{pagina} · {prodotto}".
- **Banner di reset** (`me.adminResetAt` valorizzato): in cima a ogni pagina, ruolo `alert`, "L'amministratore ha avviato il reset della tua password il {data}. Se non l'hai chiesto tu, contattalo." con "Ho capito" (nasconde il banner per la sessione; l'evento resta nel registro).
- Segnaposto 4b/4c: titolo della pagina e una riga "Questa sezione arriva con la prossima parte."

### 8.4 Account

Sezioni a card con titoli in serif, ognuna con il proprio salvataggio e una conferma breve (toast):

1. **Profilo**: email, lingua (it/en: cambia subito l'interfaccia), tema (chiaro/scuro/sistema, `ThemeSwitcher` esistente; salvato anche sul server).
2. **Password**: attuale, nuova ×2; `password_wrong`, `password_weak`.
3. **Verifica in due passaggi**: stato; "Attiva" (→ flusso §8.2 non obbligatorio); "Rigenera i codici di recupero" (chiede la password); "Disattiva" (chiede la password) **assente per gli admin**, con la riga "Per gli amministratori è obbligatoria."
4. **Sessioni attive**: client ("Firefox su macOS"), IP abbreviato (`192.168.1.x`), ultimo uso; "Questa sessione"; "Esci" per ciascuna; "Esci da tutte le altre".
5. **Registro di sicurezza**: elenco cronologico (icona, testo localizzato per tipo, data), 20 per pagina, "Più recenti" / "Meno recenti".

### 8.5 Informazioni

La pagina esistente (`AboutPage`) diventa `/about` dentro la struttura, raggiungibile da un link in fondo alla barra laterale.

## 9. Componenti

shadcn (CLI, poi `cn` da `@/lib/utils`, regola U10): Input, Label, Checkbox, Dialog, Sheet, DropdownMenu, Separator, Alert, Skeleton, Sonner. Componenti propri: `AppShell`, `NavItem`, `AuthCard`, `PasswordField` (mostra/nascondi), `CodeInput`, `RecoveryCodes`, `SectionCard`, `ErrorText`.

## 10. Test

- **Contratto** (`@kamino/protocol`): ogni schema accetta un esempio valido e rifiuta i casi limite principali (password corta, ruolo sconosciuto, codici di recupero ≠ 10).
- **Client**: `apiClient` (risposta valida, risposta non conforme → `internal`, `ErrorBody` → `ApiError` col codice, `credentials` e intestazione anti-CSRF sulle scritture); `safeRedirect`.
- **Pagine** (Testing Library + MSW in Node): accesso (ok, TOTP, codice di recupero, errori, password svuotata dopo l'errore, redirect interno rispettato e redirect esterno ignorato); setup (token sbagliato, password debole, successo → TOTP); password dimenticata (con e senza SMTP, stessa risposta per email inesistente); reset e invito (ok, token scaduto); TOTP (QR presente, codice sbagliato, codici di recupero e casella obbligatoria); guardie (non autenticato → login, setup necessario → setup, admin senza TOTP bloccato sulla pagina TOTP, utente su `/admin/*` → non trovata); `AppShell` (voci admin solo per admin, `aria-current`, stato complessivo, contatore conflitti, banner di reset); Account (ogni sezione salva e mostra gli errori; "Disattiva" assente per admin; sessioni; paginazione del registro).
- **Build**: MSW e pannello di sviluppo assenti dal bundle di produzione; galleria assente (test esistente).
- **i18n**: parità chiavi it/en, lessico vietato (test esistenti).

## 11. Consegna

- Branch `ui-web`; piano in `docs/superpowers/plans/`; esecuzione a blocchi; revisione finale con un subagente; PR.
- Documentazione: `docs/ui/design-system.md` §9 (struttura web, pagine pubbliche, account, utenti di prova MSW, pannello di sviluppo); HANDOVER; changeset (`@kamino/web` minor).
- **Uscita:** il committente prova nel browser (`pnpm --filter @kamino/web dev`) accesso, TOTP, setup, account e navigazione con gli utenti di prova, su desktop e a larghezza da telefono.
