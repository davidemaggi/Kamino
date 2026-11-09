# M1b — Crittografia e autenticazione web

> Stato: **in revisione** · Data: 2026-11-09 · Branch: `m1b-crypto-auth`
> M1 è divisa in M1a (sync-core, fatta), **M1b** (questa), M1c (vault, file, blob, commit; device-login e token dei dispositivi), M1d (motore del plugin).
> Riferimenti: [04 — sicurezza](../../04-security-threat-model.md) §5, §8, §9; [05 — modello dati](../../05-data-model.md) §1, §3; contratto `auth`/`account` della [spec 4a](2026-11-08-ui-web-shell-account-design.md) §3; ruling R16 (HANDOVER).

## 1. Decisioni

| # | Decisione |
|---|---|
| B1 | Perimetro: crittografia completa come modulo testato + autenticazione web vera (setup, login, TOTP, sessioni, account, registro di sicurezza). **Device-login e token dei dispositivi passano a M1c** con i vault (un dispositivo appartiene a un vault). |
| B2 | Argon2id con `@node-rs/argon2` (binari precompilati per Linux glibc/musl, macOS, Windows, arm64: nessuna toolchain C nell'immagine); parametri minimi OWASP: `m = 19 MiB`, `t = 2`, `p = 1`. |
| B3 | AEAD a segmenti (STREAM su AES-256-GCM) scritto su `node:crypto`, con vettori di test fissi e test di manomissione (04 §5 consente di scriverlo). |
| B4 | Costanti crittografiche di separazione dei domini **fisse**, mai derivate da `@kamino/brand` (come `KEK_ID_DOMAIN`): rinominare il prodotto non deve cambiare chiavi né formati. |
| B5 | Email: recupero password e inviti accettano già i token, ma **l'invio di email arriva con M5** (SMTP). Finché SMTP non c'è, `POST /auth/forgot` risponde `{ smtp: false }` e i link si generano da CLI: `kamino users reset-link <username>` e `kamino users invite <username> <email>` (anche per chi resta chiuso fuori). |
| B6 | Web app in sviluppo: due modalità. **Finta** (predefinita, nessun server: MSW per tutto, com'è oggi) e **ibrida** (`VITE_KAMINO_API=hybrid`: le rotte `auth`/`account`/`setup`/`me`/`invites` vanno al server vero tramite il proxy di Vite, il resto a MSW). In produzione MSW non c'è (già garantito). |
| B7 | R16 nel runner delle migrazioni: prima la migrazione `key_check`, poi la verifica della master key, poi tutte le altre, sotto lo stesso lock; l'errore originale non viene mai mascherato da quello di unlock. |
| B8 | Sessione web in cookie `HttpOnly`, `SameSite=Lax`, `Secure` quando `KAMINO_PUBLIC_URL` è HTTPS; anti-CSRF: ogni richiesta che scrive deve avere `X-Requested-With` (il client lo manda già), altrimenti `403`. |

## 2. Crittografia (`apps/server/src/crypto/`)

Gerarchia di 04 §5.1, tutta su `node:crypto`:

- **KEK** = master key (esiste). **`k_system`** = HKDF(KEK, info `kamino/v1/system`): cifra i segreti di sistema (segreti TOTP; password SMTP in M5).
- **DEK** del vault: 32 byte casuali, cifrata ("wrap") con la KEK in AES-256-GCM, AAD = `vaultId ‖ kekId`; formato `v1 ‖ nonce(12) ‖ ciphertext ‖ tag`. Funzioni: `wrapDek`, `unwrapDek`.
- **Sottochiavi** HKDF-SHA-256 dalla DEK, info `kamino/v1/content`, `…/meta`, `…/pathmac`, `…/blobid`.
- **Campi cifrati** (`encryptField` / `decryptField`): AES-256-GCM, nonce casuale a 96 bit, AAD = `tabella ‖ colonna ‖ idRiga`; formato `v1 ‖ nonce ‖ ciphertext ‖ tag`. Un valore spostato su un'altra riga o colonna non si decifra.
- **HMAC deterministici**: `pathMac(k_pathmac, collisionKey)`, `blobId(k_blobid, contentHash)` (32 byte, hex).
- **Blob** (`encryptStream` / `decryptStream`, `decryptRange`): intestazione `v1 ‖ salt(32) ‖ segmentSize`; chiave per blob = HKDF(k_content, salt, info `kamino/v1/blob`); segmenti di `segmentSize` (4 MiB, configurabile per i test); nonce (12 byte) = contatore di segmento (8 byte big-endian) ‖ 3 byte a zero ‖ 1 byte di flag (`0x01` sull'ultimo segmento, `0x00` sugli altri); AAD = `vaultId ‖ blobId`. Rileva troncamento (manca il segmento finale), riordino, segmenti duplicati o alterati. `decryptRange(offset, length)` decifra solo i segmenti necessari.
- I moduli che decifrano non vengono mai importati dal modulo `admin` (regola di CLAUDE.md, verificata da un test che controlla gli import).

M1b non salva ancora vault né blob (M1c): il modulo è completo e testato, e `k_system` è già usato per i segreti TOTP.

## 3. Database (seconda migrazione)

Tabelle di 05 §1: `users`, `recovery_codes`, `web_sessions`, `security_events`, `one_time_tokens`, più `audit_log` (05 §7) per gli eventi di sistema già presenti in M1b (setup, reset 2FA da CLI, link generati da CLI). Colonne come nel documento, con queste precisazioni:

- `users.totp_secret` cifrato con `k_system` (AAD `users ‖ totp_secret ‖ id`); `totp_last_step` per l'anti-replay.
- `web_sessions.token_hash` = SHA-256 del token (il token ha 256 bit casuali: un hash veloce basta); `last_seen_at` aggiornato al massimo una volta al minuto.
- `one_time_tokens`: token di 256 bit, hash SHA-256, monouso, con scadenza (setup: finché non c'è un utente; reset: 1 ora; invito/attivazione: 7 giorni).
- `recovery_codes.code_hash` con Argon2id (sono pochi e brevi: hash lento).

## 4. Rotte (contratto della spec 4a §3, implementato davvero)

`/setup/status`, `/setup`, `/auth/login`, `/auth/totp`, `/auth/logout`, `/me`, `/auth/forgot`, `/auth/reset`, `/invites/:token`, `/invites/:token/accept`, `/account/profile`, `/account/password`, `/account/totp/{setup,confirm,disable,recovery-codes}`, `/account/sessions` (+ `DELETE` singola e tutte tranne la corrente), `/account/security-log`.

Regole (04 §8, spec 4a):

- **Setup**: possibile solo senza utenti; il token di setup viene creato all'avvio e **stampato una volta nei log** (unica eccezione voluta alla regola "mai token nei log", già decisa in 04); il primo utente è admin con TOTP obbligatorio da configurare (`totpSetupRequired`).
- **Login**: password con Argon2id (tempo costante anche per utenti inesistenti: si verifica contro un hash fittizio); utente bloccato → `user_blocked`; con TOTP → `totp_required` + `challengeId` (in memoria, 5 minuti, monouso); TOTP RFC 6238 (SHA-1, 30 s, 6 cifre, finestra ±1, anti-replay con `totp_last_step`) oppure codice di recupero (consumato).
- **Password**: minimo 12 caratteri e non nella lista di password comuni (le 10.000 più frequenti, offline nel repo) → `password_weak`. Cambio password: revoca tutte le altre sessioni, azzera l'avviso di reset dell'admin.
- **Sessioni**: scadenza per inattività (14 giorni) e assoluta (90); elenco con client (dallo user agent) e prefisso IP (`a.b.c.x`), revoca singola o di tutte le altre.
- **Admin**: TOTP non disattivabile (`totp_mandatory`).
- **Registro di sicurezza** (`security_events`): login, login fallito, password cambiata, TOTP attivato/disattivato, codici rigenerati, sessione revocata, reset da admin/CLI; paginato (20).
- **Rate limiting** in memoria (istanza singola) su login, totp, forgot, reset, setup, accettazione inviti → `rate_limited` con `Retry-After`.
- **Errori** sempre `{ error: { code, message, retryable } }` con i codici del catalogo; mai path, token o password nei log (redazione già presente in pino; test che lo verificano).

## 5. CLI

- `kamino users reset-link <username>`: crea un token di reset, stampa il link (l'utente vedrà l'avviso U-09).
- `kamino users invite <username> <email>`: crea l'utente in attesa e stampa il link di attivazione.
- `kamino users reset-2fa <username>`: azzera il TOTP (per un admin chiuso fuori); voce nell'audit log e nel registro dell'utente.

## 6. Web app

- Modalità ibrida (B6): `startMocks` registra gli handler MSW solo per le rotte non ancora implementate dal server; le altre passano al proxy.
- Nessuna modifica alle schermate: il contratto è lo stesso. Eventuali differenze emerse col server vero si correggono nel contratto (protocol), mai con casi speciali nella UI.

## 7. Test

- **Crypto**: vettori fissi (wrap, campi, HKDF, HMAC, STREAM), proprietà fast-check (cifra/decifra = identità per ogni dimensione e `segmentSize`; qualunque byte alterato, segmento rimosso/duplicato/riordinato o troncamento → errore; `decryptRange` = slice del chiaro), AAD sbagliata → errore.
- **TOTP**: vettori di RFC 6238 (appendice B), finestra, anti-replay.
- **Rotte**: test di integrazione con Postgres (testcontainers), uno per regola di §4 (setup una volta sola, login con/senza TOTP, codici di recupero monouso, utente bloccato, password debole, revoca sessioni al cambio password, admin senza disattivazione TOTP, CSRF, rate limit, scadenze, nessun segreto nei log).
- **R16**: chiave sbagliata → nessuna migrazione applicativa eseguita; il test "tripwire" diventa un test del nuovo ordine.
- **Web**: i test esistenti restano su MSW; un test di contratto verifica che le risposte del server vero passino gli schemi zod di `@kamino/protocol`.

## 8. Consegna

Branch `m1b-crypto-auth`; piano a blocchi: (A) crypto; (B) DB, R16, utenti e sessioni; (C) rotte auth/account, TOTP, rate limit; (D) CLI e web ibrida; (E) documenti, verifica, revisione, PR. Changeset per server e web.
