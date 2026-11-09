# Fase UI — Sotto-fase 4c: web app, area admin

> Stato: **in revisione** · Data: 2026-11-08 · Branch: `ui-web-admin`
> Fonte: richiesta del committente di proseguire senza nuove scelte; segue gli schemi approvati in 4a/4b.
> Requisiti: U-03, U-04, U-09…U-13, E-01…E-04, W-02.

## 1. Decisioni

| # | Decisione |
|---|---|
| Y1 | Due voci di menu già presenti: **Utenti** (`/admin/users`, `/admin/users/$userId`) e **Sistema** (`/admin/system?tab=config|health|audit`). |
| Y2 | L'admin vede **solo metriche aggregate** degli altri utenti: conteggi, spazio, stato di sync aggregato; mai nomi di vault, file o cartelle (U-03). Il contratto non ha campi che potrebbero contenerli. |
| Y3 | L'admin **non imposta mai** la password di un altro utente: crea l'utente con un invito email (se SMTP) o un **link di attivazione** da consegnare a mano (U-10); per il reset genera un link monouso (U-09). I link si mostrano una sola volta. |
| Y4 | Configurazione: ogni campo dice da dove viene il valore; **impostato dall'ambiente** → campo bloccato con la scritta, mai modificabile dalla UI (E-03). |
| Y5 | Stesso schema di 4a/4b: contratto zod in `@kamino/protocol` (`admin.ts`), client + TanStack Query, MSW. |

## 2. Contratto (`admin.ts`)

| Rotta | Richiesta | Risposta |
|---|---|---|
| `GET /admin/users` | — | `AdminUser[]` |
| `GET /admin/users/:id` | — | `AdminUser` |
| `POST /admin/users` | `{ username, email, role, delivery: "email" \| "link" }` | `{ user: AdminUser, link: string \| null }` (`link` solo con `delivery: "link"`; `email` senza SMTP → `409 smtp_not_configured`) |
| `PATCH /admin/users/:id` | `{ role?, quotaBytes?: number \| null }` | `AdminUser` (togliere il ruolo admin all'ultimo admin → `409 last_admin`) |
| `POST /admin/users/:id/block` \| `/unblock` | — | `AdminUser` (bloccare sé stessi → `409 forbidden`) |
| `POST /admin/users/:id/reset-link` | — | `{ link }` (l'utente vedrà l'avviso e la voce nel registro, U-09) |
| `DELETE /admin/users/:id` | `{ confirmUsername, sendZip }` | `204` (`confirm_mismatch`; `sendZip` senza SMTP → `smtp_not_configured`; cancellare sé stessi → `forbidden`) |
| `GET /admin/config` | — | `SystemConfig` |
| `PATCH /admin/config` | valori parziali | `SystemConfig` (campo bloccato → `409 config_locked`) |
| `POST /admin/config/smtp-test` | — | `{ ok: true }` \| `{ ok: false, error: string }` (errore dettagliato, E-04; mai la password) |
| `GET /admin/health` | — | `SystemHealth` |
| `GET /admin/audit?page=` | — | `{ items: AuditEntry[], page, pages }` |

- `AdminUser = { id, username, email, role, status: "active" | "invited" | "blocked" | "deleting", totpEnabled, createdAt, lastLoginAt | null, quotaBytes | null, usedBytes, vaultCount, deviceCount, syncLevel, deletionAt | null }` (`syncLevel` = livello aggregato dei dispositivi; nessun nome di vault).
- `Field<T> = { value: T, source: "env" | "ui" | "default" }`. `SystemConfig = { registration: Field<"closed" | "open">, defaultQuotaBytes: Field<number | null>, maxRetentionDays: Field<number>, maxFileBytes: Field<number>, smtp: { host, port, security ("none" | "starttls" | "tls"), username, from, allowInvalidCerts: Field<…>, passwordSet: boolean, passwordSource }, smtpConfigured: boolean }`. La password SMTP non torna mai al client: si può solo impostare.
- `SystemHealth = { status: "ok" | "degraded" | "down", version, codename, uptimeSeconds, checks: { name: "database" | "storage" | "disk" | "jobs" | "smtp", status: "ok" | "warn" | "error" | "off", detail? }[], totals: { users, vaults, devices, storageBytes, devicesByLevel: Record<Level, number> } }`.
- `AuditEntry = { id, at, actor, action, target }` con `action` in un enum (creazione, invito, blocco, sblocco, cancellazione, quota, ruolo, link di reset, configurazione, email di prova); `target` è uno username o una chiave di configurazione, mai contenuti.
- Nuovi `ErrorCode`: `smtp_not_configured`, `last_admin`, `config_locked`.

## 3. Pagine

### 3.1 Utenti (`/admin/users`)
- Tabella (lista su telefono): username, email, ruolo, stato (badge testuale), spazio "{usato} / {quota | illimitata}" con barra, vault, dispositivi, `LevelBadge` aggregato, ultimo accesso.
- **Crea utente** (finestra): username, email, ruolo, consegna "Invia invito via email" (disattivato senza SMTP, con la spiegazione E-01) o "Genera un link di attivazione"; con il link: mostrato **una volta**, copiabile, "Consegnalo a mano all'utente: scade tra 7 giorni".

### 3.2 Dettaglio utente (`/admin/users/$userId`)
- Riepilogo: stato, ruolo, TOTP sì/no, creato il, ultimo accesso, spazio, vault, dispositivi, stato di sync aggregato. Testo fisso: "Per privacy non vedi nomi di vault né file degli utenti."
- **Quota**: illimitata sì/no + valore in GB; ridurla sotto l'uso attuale è permesso con l'avviso "Non cancella nulla: l'utente non potrà caricare finché non libera spazio" (Q-03).
- **Ruolo**: utente/amministratore (errore `last_admin` spiegato).
- **Blocca / Sblocca** con conferma ("niente accesso né sync, i dati restano e contano nella quota", U-11).
- **Link per reimpostare la password** con conferma ("l'utente vedrà un avviso al prossimo accesso"); link mostrato una volta.
- **Elimina** (zona pericolosa): finestra con spiegazione (7 giorni "in cancellazione", poi cancellazione definitiva, U-12), opzione "Invia all'utente un link allo ZIP dei suoi vault" (solo con SMTP; "il link arriva solo all'utente"), conferma digitando lo username.
- Azioni su sé stessi (blocco, eliminazione) non offerte.

### 3.3 Sistema (`/admin/system?tab=`)
- **Configurazione**: sezioni Registrazione (chiusa/aperta, U-04), Quote e limiti (quota predefinita, storico massimo, dimensione massima dei file), Email (host, porta, sicurezza, utente, password solo in scrittura, mittente, "accetta certificati non validi" con avviso) e **Invia email di prova** con esito o errore dettagliato. Ogni campo con `source: "env"` è disattivato e mostra "Impostato dall'ambiente"; ogni sezione ha il suo Salva.
- **Salute**: stato complessivo, versione e nome in codice, tempo di attività, controlli (database, storage, disco, job, email) con icona + testo, totali aggregati (utenti, vault, dispositivi, spazio, dispositivi per stato).
- **Registro** (audit): elenco cronologico (quando, chi, azione localizzata, su cosa), 20 per pagina.

## 4. MSW
Utenti di prova come in 4a più dati admin (quote, uso, conteggi, stati), configurazione con alcuni campi da ambiente (`maxFileBytes` e SMTP host da ambiente), salute con un controllo in avviso (disco al 85%), audit di 30 voci. Il pannello di sviluppo ha "SMTP sì/no" (già presente) che influenza `smtpConfigured` e la consegna via email; "Email di prova fallisce" come simulazione.

## 5. Test
Contratto; handler (ogni errore: `smtp_not_configured`, `last_admin`, `config_locked`, `confirm_mismatch`, `forbidden` su sé stessi); pagine: elenco (dati aggregati, nessun nome di vault), creazione con link mostrato una volta / invito disattivato senza SMTP, quota (illimitata, riduzione con avviso), ruolo, blocco/sblocco con conferma, link di reset, eliminazione col nome esatto e ZIP solo con SMTP, configurazione (campi da ambiente bloccati, salvataggio, email di prova ok/errore), salute, audit con paginazione; nessuna voce admin per utenti normali (già coperto).

## 6. Consegna
Branch `ui-web-admin`; piano; esecuzione a blocchi; revisione finale con un subagente; PR; prova del committente. Documentazione: `docs/ui/design-system.md` §11, HANDOVER (chiusura della fase UI), changeset.
