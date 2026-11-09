# 05 — Modello dati

> Stato: **approvato** (2026-11-06). Postgres ≥ 16, schema gestito con Drizzle. Nomi in inglese, `snake_case`.
> Legenda: 🔒 = cifrato con chiave del vault (`k_meta`) · 🔑 = cifrato con `k_system` · #️⃣ = hash (mai reversibile).
> È un modello logico: tipi, indici e vincoli definitivi li fissa il builder, rispettando i vincoli marcati **[V]**.

## 1. Identità e accesso

### `users`
| Colonna | Tipo | Note |
|---|---|---|
| `id` | uuid PK | UUIDv7 |
| `username` | text | come scritto dall'utente |
| `username_key` | text unique | NFC + minuscolo: unicità senza l'estensione citext (M1b) |
| `email` | text | |
| `email_key` | text unique | come sopra |
| `email_verified_at` | timestamptz null | |
| `password_hash` | text #️⃣ null | Argon2id; null per un utente invitato che non ha ancora scelto la password |
| `role` | enum `user`, `admin` | |
| `status` | enum `invited`, `active`, `blocked`, `pending_deletion`, `deleted` | `invited`: creato da un invito, senza password |
| `locale` | text | `it`, `en` |
| `theme` | enum `light`, `dark`, `system` | |
| `totp_secret` | bytea 🔑 null | |
| `totp_enabled_at` | timestamptz null | |
| `totp_last_step` | bigint null | anti-replay |
| `admin_reset_at` | timestamptz null | reset avviato da admin o CLI, mostrato all'utente finché non cambia la password (U-09) |
| `deletion_scheduled_at` | timestamptz null | fine dei 7 giorni |
| `created_at`, `updated_at` | timestamptz | |

### `recovery_codes` — `user_id`, `code_hash` #️⃣, `used_at`.
### `web_sessions` — `id`, `user_id`, `token_hash` #️⃣ unique, `created_at`, `last_seen_at`, `expires_at`, `ip`, `user_agent`, `revoked_at`.
### `security_events` — `id`, `user_id`, `type` (es. `login`, `device_linked`, `password_changed`, `admin_password_reset`, `email_changed_by_admin`, `totp_changed`), `ip`, `seen_at` null (per l'avviso al login), `created_at`. Visibile all'utente (U-16).

### `one_time_tokens`
Inviti, reset password, setup iniziale, link di export.
`id`, `kind` enum (`invite`, `activation`, `password_reset`, `setup`, `export_download`, `email_change`), `token_hash` #️⃣ unique, `user_id` null, `email` null, `payload` jsonb (non sensibile), `expires_at`, `used_at`, `created_by` null.

## 2. Quote

### `quotas` **[V] estendibile a nuovi tipi senza migrazioni distruttive**
| Colonna | Tipo | Note |
|---|---|---|
| `user_id` | uuid FK | PK composta con `kind` |
| `kind` | enum `storage_bytes` (estendibile: `device_count`, `vault_count`...) | |
| `limit_value` | bigint null | `null` = illimitata |
| `updated_by`, `updated_at` | | |

### `quota_usage`
`user_id`, `kind`, `used_value` bigint, `reserved_value` bigint (upload in corso), `reconciled_at`. Aggiornata in modo transazionale con i commit; ricalcolata dal job `quota-reconcile`.

## 3. Vault e chiavi

### `vaults`
| Colonna | Tipo | Note |
|---|---|---|
| `id` | uuid PK | |
| `owner_id` | uuid FK users | |
| `name` | bytea 🔒 | |
| `dek_wrapped` | bytea | DEK cifrata con la KEK |
| `kek_id` | text | fingerprint della KEK che la cifra |
| `dek_version` | int | per rotazioni future |
| `head_seq` | bigint | ultimo `seq` assegnato **[V] aggiornato nella stessa transazione della voce di journal** |
| `settings` | bytea 🔒 | default: categorie config dir, esclusioni, modalità sync, soglie |
| `history_retention_days` | int | 0–90, ≤ massimo di sistema |
| `status` | enum `active`, `deleted` | |
| `created_at`, `deleted_at` | | |

Con `dek_wrapped` distrutto (crypto-shredding) la riga può restare come tombstone fino al purge.

### `key_check` — `kek_id` PK, `check_value` bytea, `created_at`, `retired_at`. Verifica della KEK all'avvio.

## 4. Dispositivi e pairing

### `devices`
| Colonna | Tipo | Note |
|---|---|---|
| `id` | uuid PK | |
| `user_id`, `vault_id` | uuid FK | un dispositivo = un plugin in un vault |
| `name` | text | scelto dall'utente; non è contenuto del vault |
| `platform` | enum `windows`, `macos`, `linux`, `ios`, `android`, `unknown` | |
| `plugin_version`, `protocol_version` | text, int | |
| `token_hash` | bytea #️⃣ unique | |
| `is_origin` | bool | il "Jango" del vault |
| `cursor_seq` | bigint | **[V] solo crescente** |
| `last_seen_at`, `last_sync_at`, `last_ack_at` | timestamptz | |
| `pending_ops`, `pending_bytes`, `deferred_files` | int/bigint | ultimo `status` |
| `last_error_code`, `last_error_at` | text, timestamptz | solo codici, mai path |
| `settings_override` | bytea 🔒 null | |
| `last_ip` | inet | |
| `created_at`, `revoked_at` | | |

### `pairings`
`id`, `vault_id`, `created_by_device_id` null, `created_by_session_id` null, `token_hash` #️⃣, `status` enum (`pending`, `claimed`, `approved`, `denied`, `expired`), `claim_secret_hash` #️⃣ null, `verification_code` text null, `claimed_device_name`, `claimed_platform`, `issued_device_id` null, `expires_at`, `created_at`.

## 5. File, versioni, journal

### `files`
| Colonna | Tipo | Note |
|---|---|---|
| `id` | uuid PK | `fileId` generato dal client |
| `vault_id` | uuid FK | |
| `kind` | enum `file`, `folder` | |
| `path` | bytea 🔒 | path canonico NFC |
| `path_mac` | bytea | `HMAC(k_pathmac, collisionKey)` |
| `head_version_id` | uuid FK null | |
| `deleted_at` | timestamptz null | tombstone corrente |
| `created_at`, `updated_at` | | |

**[V]** indice unico parziale `(vault_id, path_mac) WHERE deleted_at IS NULL`.

### `file_versions`
| Colonna | Tipo | Note |
|---|---|---|
| `id` | uuid PK | `versionId` generato dal client |
| `file_id`, `vault_id` | uuid FK | |
| `base_version_id` | uuid null | la base dichiarata — **[V] sempre salvata** (abilita il merge a 3 vie futuro) |
| `kind` | enum `content`, `tombstone` | |
| `blob_id` | bytea FK blobs null | null per tombstone e cartelle |
| `content_hash` | bytea 🔒 null | SHA-256 del contenuto in chiaro, cifrato; restituito ai client in journal/snapshot |
| `size` | bigint | in chiaro |
| `mtime` | timestamptz null | dal client, solo informativo |
| `device_id` | uuid FK | |
| `seq` | bigint null | null per versioni candidate di conflitto non (ancora) correnti |
| `retained_until` | timestamptz null | calcolata da retention/cestino |
| `created_at` | timestamptz | |

### `journal` **[V] append-only**
| Colonna | Tipo | Note |
|---|---|---|
| `vault_id` | uuid | PK composta (`vault_id`, `seq`) |
| `seq` | bigint | |
| `type` | enum (vedi [03](03-sync-protocol.md) §6.1) | |
| `file_id` | uuid null | |
| `version_id` | uuid null | |
| `path` | bytea 🔒 null | path al momento della voce |
| `device_id` | uuid null | |
| `conflict_id` | uuid null | |
| `created_at` | timestamptz | |

### `applied_ops` — `vault_id`, `op_id` (PK composta), `result` jsonb, `created_at`. Idempotenza dei commit; pulizia dopo 30 giorni.

### `blobs`
| Colonna | Tipo | Note |
|---|---|---|
| `vault_id` | uuid | PK composta (`vault_id`, `id`) |
| `id` | bytea | `HMAC(k_blobid, contentHash)` |
| `storage_key` | text | posizione nello storage (non derivata dal path) |
| `size_plain`, `size_stored` | bigint | la quota usa `size_stored` |
| `created_at`, `last_referenced_at` | | per la GC |

### `upload_sessions`
`id`, `vault_id`, `device_id`, `blob_id`, `expected_size`, `chunk_size`, `received_chunks` (bitmap/array), `staging_key`, `reserved_bytes`, `expires_at`, `completed_at`.

## 6. Conflitti

### `conflicts`
`id`, `vault_id`, `file_id`, `kind` enum (`concurrent_edit`, `both_created`), `base_version_id` null, `head_version_id_at_open`, `status` enum (`open`, `resolved`), `resolution` enum null (`keep_head`, `keep_candidate`, `keep_local`, `keep_both`, `manual`), `resolved_version_id` null, `resolved_by_device_id` null, `resolved_by_session` bool, `opened_at`, `resolved_at`.

### `conflict_candidates` — `conflict_id`, `version_id`, `device_id`, `created_at`.

**[V]** le versioni referenziate da conflitti aperti non sono mai eliminate dalla retention.

## 7. Sistema

### `system_settings`
`key` PK, `value` jsonb (non segreti) o `secret_value` bytea 🔑, `updated_by`, `updated_at`. La precedenza "ambiente vince" è applicata da `config` a runtime; il DB contiene solo i valori impostati da UI.
Chiavi iniziali: `registration.open`, `quota.default_storage_bytes`, `files.max_size_bytes`, `history.max_retention_days`, `smtp.*`, `pairing.ttl_seconds`, `sync.stale_device_threshold_hours`.

### `audit_log` **[V] append-only**
`id`, `actor_user_id` null (null = CLI/sistema), `actor_kind` enum (`user`, `cli`, `system`), `action` text, `target_type`, `target_id`, `metadata` jsonb (mai contenuti o path), `ip`, `created_at`.

### `outbox_events` — `id`, `type` (es. `device.stale`, `quota.near_limit`, `conflict.aged`), `user_id`, `payload` jsonb, `created_at`, `processed_at`. Base per le notifiche future (E-06) e per le email.

### Schema `pgboss` — gestito da pg-boss.

## 8. Relazioni principali

```
users 1─* vaults 1─* files 1─* file_versions *─1 blobs
users 1─* devices *─1 vaults
vaults 1─* journal
vaults 1─* conflicts 1─* conflict_candidates
users 1─* quotas, quota_usage
vaults 1─* pairings
```

## 9. Stato locale del plugin (non nel DB del server)

| File | Contenuto |
|---|---|
| `data.json` | impostazioni (URL server, override, modalità), **token del dispositivo**, `deviceId`, `vaultId` |
| `index.json` | per file: `fileId`, `path`, `versionId` base, `contentHash`, `size`, `mtime`, stato (`synced`, `local_modified`, `conflict`, `deferred`, `unrepresentable`, `remote_not_applied`) |
| `outbox.json` | op in attesa, in ordine, con `opId` |
| `cursor` | ultimo `seq` applicato |

Scritture atomiche (file temporaneo + rename). Tutti in `<configDir>/plugins/<PLUGIN_ID>/`, sempre esclusa dal sync.
