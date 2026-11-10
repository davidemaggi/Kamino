# M1c — Server di sync: vault, dispositivi, blob, commit

> Stato: **implementata** · Data: 2026-11-09 · Branch: `m1c-sync-server`
> M1: M1a sync-core (fatta), M1b crypto + auth web (fatta), **M1c** (questa), M1d motore del plugin.
> Riferimenti: [03 — protocollo](../../03-sync-protocol.md) §1–6, §12; [04](../../04-security-threat-model.md) §5, §8; [05](../../05-data-model.md) §3–6; spec M1a (`sync-core`, Z1–Z13) e M1b (B1–B9); contratto del plugin `apps/plugin/src/connection/types.ts`.

## 1. Decisioni

| # | Decisione |
|---|---|
| C1 | Perimetro: collegamento dei dispositivi con credenziali (il QR resta in M6), token dei dispositivi, vault con DEK e campi cifrati, upload a chunk, download con `Range`, commit tramite l'arbitro di `sync-core`, journal, snapshot, `ack` e `status` via REST (il WebSocket è M2). Più il minimo della web app: `GET /vaults` e `GET /vaults/summary` veri. |
| C2 | Storage dei blob dietro un'interfaccia `BlobStore` con **due adattatori**, file system e **S3/MinIO**, e un unico test di contratto eseguito su entrambi. Il test S3 usa il gateway S3 di **SeaweedFS** in testcontainers, perché MinIO non pubblica più immagini pubbliche (2026); il server resta compatibile con qualunque S3, MinIO compreso. |
| C3 | L'arbitro resta sincrono e puro: il server **prepara in anticipo** i dati che leggerà; se `decide` chiede un dato non preparato (es. i path `Nota (1).md` di una resurrezione), l'adattatore lo carica e ripete la decisione. Tutto dentro una transazione con la riga del vault bloccata (`SELECT … FOR UPDATE`). `sync-core` non cambia. |
| C4 | **`MemoryStore` è l'oracolo** del server: per sequenze casuali di op (fast-check) server e `MemoryStore` danno gli stessi esiti e lo stesso stato. |
| C5 | Collegamento in tre passi, come il `ConnectionService` del plugin: `POST /devices/login` (password + TOTP opzionale nella stessa richiesta) → token di iscrizione di 10 minuti → elenco/creazione vault → `POST /enroll/vaults/:id/devices` → token del dispositivo (256 bit, solo l'hash nel DB, senza scadenza, revocabile). |
| C6 | I chunk vengono **cifrati all'arrivo** come segmenti dello STREAM di M1b (segmento = chunk, `chunkSize` = 4 MiB) in uno staging locale; `complete` verifica lo SHA-256 decifrando in streaming e promuove i segmenti a blob definitivo **senza ricifrare** (04 §5). Il contenuto in chiaro non tocca mai il disco. |
| C7 | Il download con `Range` legge e decifra solo i segmenti necessari, in streaming (mai il blob intero in memoria). |
| C8 | Path, nomi di vault e hash dei contenuti solo cifrati nel DB (`k_meta`, AAD tabella ‖ colonna ‖ riga); unicità con `path_mac = HMAC(k_pathmac, collisionKey)`. L'unico controllo che richiede i path in chiaro (cartella con discendenti vivi) li decifra in memoria: è raro e resta nel vault del proprietario. |
| C9 | Limiti: dimensione massima di un file da `KAMINO_MAX_FILE_BYTES` (default 500 MB) → `file_too_large`. **Le quote arrivano con M5** (nessun `quota_exceeded` in M1c). |
| C10 | Pulizia: sessioni di upload scadute (24 h) e il loro staging ripuliti da un timer interno; la garbage collection dei blob orfani arriva con lo storico (M3). |

## 2. Contratto (`@kamino/protocol`)

Nuovo `devices-auth.ts` e aggiunte a `sync.ts`:

| Rotta | Auth | Richiesta → Risposta |
|---|---|---|
| `POST /devices/login` | — | `{ username, password, totp? }` → `{ status: "ok", enrollToken, expiresAt }` \| `{ status: "totp_required" }`; errori `invalid_credentials`, `totp_invalid`, `user_blocked`, `rate_limited` |
| `GET /enroll/vaults` | iscrizione | → `{ vaults: { id, name, fileCount, deviceCount }[] }` |
| `POST /enroll/vaults` | iscrizione | `{ name }` → vault (il dispositivo che lo crea sarà l'origine, `is_origin`) |
| `POST /enroll/vaults/:id/devices` | iscrizione | `{ name, platform, pluginVersion, protocolVersion }` → `{ deviceId, deviceToken, vault: { id, name } }` |
| `PATCH /device` · `DELETE /device` | dispositivo | rinomina · scollega (revoca se stesso) |
| `POST /vaults/:id/blobs/check` | dispositivo | `{ hashes }` → `{ missing }` |
| `POST /vaults/:id/uploads` | dispositivo | `{ contentHash, size }` → `{ uploadId, chunkSize, expiresAt }` (`file_too_large`) |
| `PUT /vaults/:id/uploads/:uid/chunks/:i` | dispositivo | corpo binario → `{ received }` (idempotente, in qualunque ordine) |
| `GET /vaults/:id/uploads/:uid` | dispositivo | → `{ received, expiresAt }` |
| `POST /vaults/:id/uploads/:uid/complete` | dispositivo | → `{ contentHash, size }` (`hash_mismatch`: sessione scartata) |
| `GET /vaults/:id/blobs/:contentHash` | dispositivo | contenuto in chiaro, `Range` supportato |
| `POST /vaults/:id/commits` | dispositivo | `CommitRequest` → `CommitResponse` |
| `GET /vaults/:id/changes?after=&limit=` | dispositivo | `ChangesResponse` |
| `GET /vaults/:id/snapshot` | dispositivo | `Snapshot` |
| `POST /vaults/:id/ack` · `POST /vaults/:id/status` | dispositivo | `{ seq }` · `{ pendingOps, pendingBytes, deferredFiles, lastErrorCode? }` → `204` |
| `GET /vaults` · `GET /vaults/summary` | sessione web | `VaultList` · `VaultsSummary` (contratto esistente) |

Auth del dispositivo: `Authorization: Bearer <deviceToken>`; dispositivo revocato → `401 device_revoked`; utente bloccato → `403 user_blocked` (il token resta valido allo sblocco, 04 §8); vault diverso da quello del dispositivo → `404 not_found`. Le rotte con Bearer non richiedono l'intestazione anti-CSRF (non usano cookie). Header `Kamino-Protocol` controllato: versione non supportata → `426 protocol_unsupported`.

## 3. Modello dati (terza migrazione)

Tabelle di 05 §3–6: `vaults`, `devices`, `files`, `file_versions`, `journal`, `applied_ops`, `blobs`, `upload_sessions`, `conflicts`, `conflict_candidates`; il tipo di token `device_enrollment` in `one_time_tokens`. Precisazioni:

- `files.path_enc` (AAD `files ‖ path ‖ fileId`), `files.path_mac` con indice unico parziale `(vault_id, path_mac) WHERE NOT deleted`; `file_versions.content_hash_enc` e `blob_id`; `journal.path_enc` (AAD `journal ‖ path ‖ vaultId:seq`) e `content_hash_enc`.
- `vaults.head_seq` aggiornato nella stessa transazione della voce di journal; `applied_ops` registra solo esiti accettati o in conflitto (i rifiuti si possono ripetere, come in `sync-core`).
- `blobs (vault_id, blob_id)` con `size`, `stored_size`, `created_at`; il nome nello storage è `vaultId/blobId` (nessun dato in chiaro).

## 4. Storage

```ts
interface BlobStore {
  put(key: string, parts: AsyncIterable<Uint8Array>): Promise<void>; // durevole al ritorno
  getRange(key: string, start: number, endExclusive: number): AsyncIterable<Uint8Array>;
  size(key: string): Promise<number | null>;
  delete(key: string): Promise<void>;
}
```

- **fs**: `KAMINO_STORAGE_DIR` (default `/data/blobs`); scrittura su file temporaneo, `fsync`, `rename`, `fsync` della cartella.
- **s3**: `KAMINO_S3_ENDPOINT`, `KAMINO_S3_BUCKET`, `KAMINO_S3_REGION`, `KAMINO_S3_ACCESS_KEY_ID`, `KAMINO_S3_SECRET_ACCESS_KEY` (anche `_FILE`), `KAMINO_S3_FORCE_PATH_STYLE`; upload multipart, `GetObject` con `Range`. Scelta con `KAMINO_STORAGE=fs|s3`.
- Staging dei chunk sempre su disco locale (`KAMINO_STAGING_DIR`, default `/data/staging`), già cifrati.

## 5. Commit

`POST /commits` elabora le op in ordine, una transazione per op (03 §5: atomiche singolarmente): blocca la riga del vault, costruisce la vista per `decide` (C3), applica le mutazioni (righe di `files`, `file_versions`, `journal`, `conflicts`, `applied_ops`, `head_seq`) e risponde con l'esito. `blobPresent` controlla `blobs`; il `versionId` già usato è rifiutato (`invalid_request`), come in `sync-core`.

## 6. Test

- Contratto di `BlobStore` su fs e su S3 (SeaweedFS) (scrittura, lettura a intervalli, assenza, sovrascrittura, cancellazione).
- Upload: chunk fuori ordine e ripetuti, ripresa, `hash_mismatch`, `file_too_large`, scadenza; download con `Range` (intervalli che attraversano segmenti); il chiaro non compare mai nello staging né nello storage.
- **Oracolo** (C4): fast-check su sequenze di op contro server e `MemoryStore`, stessi esiti; più i casi di 03 §5.3 come test espliciti.
- Collegamento: login dispositivo con/senza TOTP, iscrizione scaduta, token revocato, utente bloccato, vault di un altro utente, header di protocollo.
- Un percorso completo: due dispositivi, upload, commit, `changes`, `snapshot`, download, conflitto.
- Web: `GET /vaults` e `/vaults/summary` passano gli schemi zod; in modalità ibrida vanno al server vero.

## 7. Consegna

Branch `m1c-sync-server`; piano a blocchi: (A) contratto e schema; (B) storage (fs, S3, staging, lettura a segmenti); (C) collegamento dispositivi e auth Bearer; (D) upload e download; (E) commit, journal, snapshot, ack/status, oracolo; (F) rotte web dei vault e modalità ibrida; (G) documenti, verifica, revisione, PR. Changeset per server e web.
