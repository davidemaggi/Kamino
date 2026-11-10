# M2a — Tempo reale sul server: WebSocket, fan-out, compattazione, dispositivi, impostazioni

> Stato: **approvata** · Data: 2026-11-10 · Branch: `m2a-realtime`
> M2 è divisa in **M2a** (questa, solo server) e **M2b** (parte plugin, dopo M1d).
> Riferimenti: [03 — protocollo](../../03-sync-protocol.md) §6.3, §7, §11, §12, §14; [02 — architettura](../../02-architecture.md) §110 (fan-out); ADR [0008](../../adr/0008-pg-boss.md), [0017](../../adr/0017-http-per-scritture-ws-per-push.md); requisiti D-06, S-06, S-10…S-13; spec M1c (C1–C10).

## 1. Decisioni

| # | Decisione |
|---|---|
| D1 | Perimetro: solo server. Restano a **M2b** (dopo M1d): applicazione delle voci nel plugin, soppressione dell'eco, modalità Live/Periodica/Manuale, riconciliazione con contenuto locale (D-07), allegati solo in Wi-Fi. |
| D2 | **WebSocket** su `/api/v1/ws` con `@fastify/websocket`, messaggi di 03 §7. Primo messaggio `hello` con il token del dispositivo entro 5 s (mai nell'URL); `welcome` con `head`, `deviceId` e protocollo negoziato; catch-up con `changes` a pagine di 500 dal cursore dichiarato; `ack` e `status` con le regole della REST; `ping`/`pong` ogni 30 s, connessione morta dopo 2 battiti mancati; `device_revoked` (e chiusura) a tutti i socket del dispositivo revocato; `error user_blocked` e chiusura per un utente bloccato. |
| D3 | **Fan-out** come 02 §110: `NOTIFY kamino_vault, '<vaultId>:<seq>'` nella stessa transazione del commit (parte solo se il commit va a buon fine); una connessione dedicata in `LISTEN` e un hub in memoria per vault. Ogni socket legge dal journal le voci dopo il proprio cursore inviato, **una pagina alla volta** (contropressione), e più notifiche ravvicinate diventano una sola lettura. Alla caduta della connessione `LISTEN`: riconnessione con backoff e risveglio di tutti i socket. |
| D4 | **Compattazione del journal** (03 §6.3): si eliminano le voci fino a `min(cursori dei dispositivi attivi, voci più vecchie della retention dello storico)`; i dispositivi revocati o inattivi da più di 90 giorni non trattengono il journal. `vaults.journal_floor` = ultimo `seq` eliminato; un cursore `< journal_floor` riceve `cursor_too_old` (REST `changes`: `410`; WebSocket: `error` e chiusura). |
| D5 | **pg-boss** (ADR 0008) introdotto ora, nel nuovo modulo `jobs`: compattazione giornaliera e pulizia degli upload (sostituisce il `setInterval` di M1c). Lo schema `pgboss` si crea dopo la verifica della master key, come le altre migrazioni. |
| D6 | **Dispositivi**. Rotte web sul contratto esistente (`Device`, `DevicePatch`): `GET /devices`, `GET /devices/:id`, `PATCH /devices/:id`, `POST /devices/:id/revoke`; proprietà controllata, nessun bypass per l'admin. Rotte del plugin: `GET /device` (sé stesso) e `GET /vault/devices` (i dispositivi del suo vault). Il livello per dispositivo (S-06, D-06) e quello del vault usano **una sola funzione** (decisione > attenzione > in corso > al sicuro). La modalità ibrida della web app manda al server vero anche queste rotte. |
| D7 | **Impostazioni** (S-10…S-13): categorie della cartella di configurazione ed esclusioni come default del vault (`vaults.settings_enc`) e override del dispositivo (`devices.settings_override_enc`, `null` = segue il default), cifrati con `k_meta`. Rotte del plugin: `GET`/`PUT /vault/settings`, `GET`/`PUT /device/settings`. Una modifica del default produce la voce di journal `vault_settings_changed` e quindi arriva via WebSocket e `changes`. Le impostazioni dalla web app arrivano con M4 (il contratto web non le ha). `sync-core` si allinea a S-10: **per default nessuna categoria** della cartella di configurazione. |
| D8 | `PROTOCOL_VERSION` resta **1**: solo aggiunte compatibili (nuovi messaggi, nuove rotte, nuovo tipo di voce già nell'enum). |

## 2. Contratto (`@kamino/protocol`)

Nuovo `ws.ts`:

| Direzione | Messaggio | Contenuto |
|---|---|---|
| C → S | `hello` | `{ deviceToken, protocol: { min, max }, cursor, pluginVersion, platform }` |
| S → C | `welcome` | `{ protocol, head, deviceId, serverVersion, codename }` |
| S → C | `changes` | `{ entries: JournalEntry[], head, hasMore }` |
| C → S | `ack` | `{ seq }` |
| C → S | `status` | come `DeviceStatusReport` |
| S → C | `device_revoked` | `{}` |
| S → C | `vault_settings_changed` | `{ settings }` |
| S → C | `error` | `{ code, message }`, poi chiusura |
| entrambi | `ping` / `pong` | `{}` |

`ClientMessage` e `ServerMessage` come unioni discriminate su `type`. I messaggi non validi → `error invalid_request` e chiusura.

Nuovo in `devices-auth.ts` / `sync.ts`:

| Rotta | Auth | Richiesta → Risposta |
|---|---|---|
| `GET /devices` · `GET /devices/:id` | sessione web | `DeviceList` · `Device` |
| `PATCH /devices/:id` · `POST /devices/:id/revoke` | sessione web | `DevicePatch` → `Device` · `204` |
| `GET /device` | dispositivo | `Device` |
| `GET /vault/devices` | dispositivo | `DeviceList` (solo il suo vault) |
| `GET` / `PUT /vault/settings` | dispositivo | `SyncSettings` |
| `GET` / `PUT /device/settings` | dispositivo | `{ override: SyncSettings \| null, effective: SyncSettings }` |
| `GET /vaults/:id/changes` | dispositivo | come M1c, più `410 cursor_too_old` |

`SyncSettings = { config: Record<ConfigCategory, boolean>, patterns: string[] }` (massimo 200 pattern da 500 caratteri), lo stesso tipo di `sync-core`.

## 3. Modello dati (quarta migrazione)

- `vaults.journal_floor bigint not null default 0`, `vaults.settings_enc bytea null` (null = default di S-10).
- `devices.settings_override_enc bytea null`.
- La voce `vault_settings_changed` nel journal usa `fileId` e `path` riservati (`_vault`, costante `VAULT_EVENT_ID` in `@kamino/protocol`) e `ignorable: true`: lo schema della voce non cambia e il reducer di `sync-core` la tratta già come voce senza effetti sui file. Il client rilegge le impostazioni con `GET /vault/settings` (o le riceve nel messaggio WebSocket).
- Schema `pgboss` gestito da pg-boss all'avvio, dopo la verifica della chiave.

## 4. Componenti

```
apps/server/src/realtime/
  hub.ts        connessioni per vault, risveglio, coalescenza
  listener.ts   connessione LISTEN dedicata, riconnessione con backoff
  socket.ts     macchina a stati di un socket: hello → welcome → catch-up → live
apps/server/src/jobs/
  boss.ts       avvio/arresto di pg-boss, registrazione dei job
  compact.ts    compattazione del journal
apps/server/src/devices/
  level.ts      livello per dispositivo e per vault (unica funzione)
  service.ts    elenco, rinomina, revoca (+ chiusura dei socket via hub)
apps/server/src/vaults/settings.ts   default del vault e override, cifrati
```

Il commit (`SyncService`) chiama `pg_notify` nella transazione; l'hub non conosce la crittografia: per leggere le voci usa `SyncService.changes`.

## 5. Errori e limiti

- `hello` assente o tardivo → chiusura `4401`; token non valido o revocato → `error unauthorized` / `device_revoked`; protocollo non supportato → `error protocol_unsupported`.
- Messaggi oltre 64 KB → chiusura. Massimo 5 socket aperti per dispositivo (i più vecchi si chiudono).
- Mai nei log: token, path, contenuti; solo codici e id.

## 6. Test

- WebSocket: `hello` tardivo o non valido, protocollo sbagliato, catch-up a pagine, push dal vivo tra due client, `ack`/`status`, revoca, utente bloccato, heartbeat (con orologio finto).
- Fan-out con **due istanze del server** sullo stesso Postgres (N-08) e caduta della connessione `LISTEN`.
- Compattazione: cosa viene eliminato e cosa no (cursori attivi, dispositivi inattivi, retention), `cursor_too_old` su REST e WebSocket.
- **Test multi-client di protocollo** (03 §14, metà server): N client di protocollo, ognuno ricostruisce lo stato del vault solo dalle voci ricevute (WebSocket o `changes`, snapshot dopo `cursor_too_old`); op casuali via REST con basi vecchie, commit ripetuti, connessioni che cadono e si riaprono dal proprio cursore, compattazioni nel mezzo. Alla fine: ogni client ha ricevuto ogni `seq` esattamente una volta dopo il suo ultimo snapshot e il suo stato coincide con lo snapshot del server. La convergenza con il reducer completo di `sync-core` su un file system finto arriva in M2b, insieme al motore di M1d.
- Dispositivi e impostazioni: schemi zod, isolamento tra utenti, override `null` che segue il default, `vault_settings_changed` nel journal e sul WebSocket.

## 7. Consegna

Branch `m2a-realtime`; piano a blocchi: (A) contratto (messaggi WS, impostazioni, rotte dei dispositivi); (B) WebSocket e hub con `LISTEN`/`NOTIFY`; (C) pg-boss, compattazione e `cursor_too_old`; (D) dispositivi e livelli; (E) impostazioni; (F) test multi-client; (G) documenti, revisione, PR. Changeset per server e web.
