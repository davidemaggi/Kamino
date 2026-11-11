# M4+M5+M6 — Rotte del server dietro le schermate già fatte

> Stato: **approvata** · Data: 2026-11-11 · Branch: `m456-server-routes` (poi un branch per PR, vedi §6)
> Spec **leggera** (accelerazione 2 del committente, 2026-11-11): parti a basso rischio, rigore pieno solo dove si toccano dati (cancellazione, ZIP, quote).
> Riferimenti: [01 — requisiti](../../01-requirements.md) U-*, V-03, V-04, W-01, E-01…E-04, Q-*; [03 — protocollo](../../03-sync-protocol.md) §10; [04 — threat model](../../04-security-threat-model.md) T-02, T-03, T-17, §7, §9; [06 — roadmap](../../06-roadmap.md) M4–M6; contratto `@kamino/protocol` (`vaults.ts`, `history.ts`, `conflicts.ts`, `admin.ts`, `devices-auth.ts`).

## 1. Decisioni

| # | Decisione |
|---|---|
| F1 | **Perimetro:** il server implementa le rotte del contratto `@kamino/protocol` che oggi esistono solo in MSW (web) e nel `FakeServer` (plugin): area utente, admin, quote, email, pairing. MSW si spegne per le rotte coperte; la modalità ibrida della web app manda al server vero tutto ciò che esiste. |
| F2 | **Storico, cestino e conflitti in sola lettura** (scelta del committente). Elenchi e dettagli sì; `POST /versions/:id/restore`, `/trash/:fileId/restore`, `/conflicts/:id/resolve`, `/conflicts/resolve-all` → `501 not_implemented` sul server e "in arrivo" in UI. Restano a M3, dove si possono perdere dati. |
| F3 | **Consegna:** una spec e un piano, **tre PR in sequenza** (P1 area utente, P2 admin/quote/email, P3 pairing), ognuna con la sua revisione finale con un subagente. |
| F4 | **ZIP in streaming** con `yazl`: generato al volo dai blob decifrati, senza file temporanei; `?at=<ISO>` ricostruisce il vault "com'era alla data X" dalle `file_versions` entro la finestra dello storico (oltre → `400 out_of_retention`). Solo il proprietario. |
| F5 | **Cancellazione di un vault** (V-03): conferma con il nome; DEK distrutta subito nella stessa transazione (crypto-shredding), dispositivi del vault revocati e socket chiusi; blob eliminati da un job pg-boss. |
| F6 | **Cancellazione di un utente** (U-12, 04 §7): stato `deleting`, sessioni e token rifiutati; se richiesto e con SMTP, job `export-zip` → ZIP cifrato con una chiave effimera derivata da `k_system` e legata al token del link, servito da `GET /exports/:token`, link **solo all'email dell'utente** e mai nei log né davanti all'admin; dopo 7 giorni (o subito senza export) job `user-deletion-finalize`: distrugge ZIP e DEK, revoca i dispositivi, elimina i blob. |
| F7 | **Configurazione di sistema** (E-03): nuova tabella `system_config` (chiave → valore JSON); precedenza ambiente → UI → default; un campo impostato dall'ambiente → `409 config_locked`; password SMTP cifrata con `k_system` e mai restituita (`passwordSet`). Modifiche nell'audit log (valore vecchio/nuovo solo per i campi non segreti). |
| F8 | **Email:** `nodemailer`; template it/en in `apps/server/src/email/templates`; lingua = `users.locale`; **outbox** in DB (`email_outbox`) inviata da un job pg-boss con retry e backoff; `smtp-test` sincrono con errore tecnico (mai la password). Senza SMTP le funzioni che lo richiedono rispondono `409 smtp_not_configured` e la UI le disattiva con spiegazione (E-01). Il contenuto delle email (link compresi) non va mai nei log. |
| F9 | **Quote** (Q-*): uso = somma dei blob distinti dell'utente; limite = quota dell'utente → default di sistema → nessuno. Controllo su `blobs/check` e all'apertura dell'upload → `413 quota_exceeded`; il plugin mostra già "spazio esaurito". Le esenzioni di Q-03 (cancellazioni, rinomine e op senza nuovi byte passano sempre) valgono per costruzione: il controllo è solo sui byte nuovi. |
| F10 | **Admin senza contenuti** (T-02): il modulo `admin` legge solo aggregati e non importa servizi che decifrano; un **test di architettura** lo verifica sugli import. Blocco di un utente → `Hub.closeUser` (punto rinviato da M2a). |
| F11 | **Pairing** (03 §10): token monouso da 256 bit (solo l'hash nel DB, 10 minuti per l'intero flusso), codice di verifica di 4 caratteri senza ambiguità, `claimSecret` per il polling del nuovo dispositivo. Nuovo messaggio WebSocket `pairing_request` all'origine (aggiunta compatibile: `PROTOCOL_VERSION` resta 1); la web app fa polling su `GET /pairings/:id`. Invio del link via email se c'è SMTP. Nel plugin `startPairing`/`claim` veri al posto di "in arrivo", con l'avviso quando il vault di destinazione non è vuoto. |
| F12 | Solo **aggiunte** al modello dati (`system_config`, `email_outbox`, `pairings`, `exports`): nessuna migrazione distruttiva. `users.locale` e `users.deletion_scheduled_at` esistono già. |

## 2. Rotte

### P1 — Area utente (sessione web, proprietà controllata, nessun bypass per l'admin)

| Rotta | Note |
|---|---|
| `GET /vaults/:id` · `PATCH /vaults/:id` · `DELETE /vaults/:id` | `Vault`; `VaultPatch` (rinomina); `VaultDelete` (`confirmName`, F5) |
| `GET /vaults/:id/files?q=` | ricerca sui path decifrati in memoria, risultati limitati (`FileList`) |
| `GET /files/:id/versions` · `GET /versions/:id` | `FileVersions`; `VersionContent` (testo fino a un limite, altrimenti metadati binari) |
| `GET /vaults/:id/trash` | `TrashList` |
| `GET /conflicts` · `GET /conflicts/:id` | `ConflictList`, `ConflictDetail` |
| `GET /vaults/:id/zip?at=` | F4, `Content-Disposition` con nome ASCII sicuro, mai il nome del vault nei log |
| `GET /vaults` · `/vaults/summary` | in più l'uso della quota (`Quota`) |
| restore/resolve | `501 not_implemented` (F2) |

### P2 — Admin, quote, email (sessione web con ruolo admin e TOTP attivo)

| Rotta | Note |
|---|---|
| `GET /admin/users` · `POST /admin/users` · `GET`/`PATCH`/`DELETE /admin/users/:id` | `AdminUser` solo aggregati; `CreateUserRequest` (`delivery: email\|link`); `UpdateUserRequest` (ruolo, quota; `409 last_admin`); `DeleteUserRequest` (F6) |
| `POST /admin/users/:id/block` · `/unblock` · `/reset-link` | blocco → `Hub.closeUser`; reset visibile all'utente (`admin_reset_at`, registro di sicurezza) e nell'audit |
| `GET`/`PATCH /admin/config` · `POST /admin/config/smtp-test` | F7, F8 |
| `GET /admin/health` | `SystemHealth`: controlli database, storage, disco, job, SMTP; totali aggregati |
| `GET /admin/audit?page=` | append-only, mai contenuti o path |
| `POST /auth/forgot` | con SMTP: email di reset (risposta identica che l'utente esista o no) |
| `GET /exports/:token` | ZIP dell'utente in cancellazione (F6) |

### P3 — Pairing

| Rotta | Auth | Note |
|---|---|---|
| `POST /vaults/:id/pairings` | sessione web o dispositivo del vault | `PairingOffer`; `?email=1` invia il link all'utente |
| `GET /pairings/:id` · `POST …/approve` · `/deny` · `/cancel` | origine | `PairingState`; `409 pairing_closed` su un flusso chiuso |
| `POST /pairings/claim` | nessuna (il token è la prova) | `{ claimId, claimSecret, verificationCode }`; secondo claim → `409 pairing_already_claimed` e l'origine lo vede |
| `GET /pairings/claims/:claimId` | `Authorization: Claim <claimSecret>` | `pending \| denied \| expired \| approved { deviceToken, vaultId }`; il token del dispositivo si consegna una volta sola |

Rate limit su `claim` e sul polling, come per il login.

## 3. Modello dati (quinta migrazione e seguenti, una per PR)

- P1: nessuna tabella nuova (eventuale indice per la ricerca per `vault_id`).
- P2: `system_config (key text pk, value jsonb, secret_enc bytea null, updated_at)`; `email_outbox (id, to_enc, template, locale, params_enc, attempts, next_at, sent_at, last_error_code)` con destinatario e parametri cifrati con `k_system`; `exports (id, user_id, token_hash, key_check, blob_key, expires_at, destroyed_at)`.
- P3: `pairings (id, vault_id, user_id, origin, token_hash, code, claim_id, claim_secret_hash, request jsonb, status, device_id null, expires_at)`.

## 4. Errori

Nuovi codici nel catalogo (`errors.ts`), se mancano: `not_implemented`, `out_of_retention`, `quota_exceeded`, `config_locked`, `smtp_not_configured`, `last_admin`, `export_expired`. Tutti con testo it/en nella UI. Mai nei log: path, nomi di vault e file, contenuti, token, link, indirizzi email nei job.

## 5. Test

- **Integrazione** su Postgres reale per ogni rotta: proprietà e isolamento tra utenti (404 sul vault di un altro, non 403); un admin non vede i contenuti altrui (T-02) né dalle rotte utente né da quelle admin; test di architettura sugli import del modulo `admin`.
- **ZIP:** decompresso e confrontato con lo snapshot del server; `at=` confrontato con lo stato ricostruito dal journal; memoria limitata su un vault con un file grande (streaming).
- **Cancellazioni:** dopo la cancellazione del vault o la finalizzazione dell'utente la DEK non c'è più, i blob spariscono dopo il job, i token dei dispositivi sono rifiutati; l'export non è leggibile senza il token del link.
- **Email:** trasporto finto in memoria; outbox con retry; nessun link nei log (cattura dei log nel test).
- **Quote:** upload oltre la quota rifiutato; cancellazioni e rinomine sempre accettate a quota piena.
- **Pairing:** flusso completo con approvazione, rifiuto, scadenza, doppio claim, `pairing_request` sul WebSocket; il plugin collegato via pairing sincronizza con il motore vero.
- **Playwright** (web, modalità ibrida contro il server in testcontainers): login, dettaglio vault, dispositivi, ZIP, admin utenti e configurazione, pairing dal web.

## 6. Consegna

Tre PR in sequenza, ognuna da `main` dopo il merge della precedente: **P1** `m4-user-area`, **P2** `m5-admin-email`, **P3** `m6-pairing` (il branch `m456-server-routes` porta spec e piano e diventa P1). Ognuna: esecuzione del suo blocco del piano senza checkpoint, verifica completa, una revisione finale con un subagente, changeset (`@kamino/server` minor, `@kamino/web` e `@kamino/plugin` patch o minor se cambiano), aggiornamento dell'HANDOVER.

## 7. Fuori perimetro

Ripristino di versioni e cestino, risoluzione dei conflitti, retention e GC dei blob (M3); rotazione delle chiavi, backup, CSP e test di autorizzazione completi (M7); registrazione aperta oltre al flag di configurazione già nel contratto.
