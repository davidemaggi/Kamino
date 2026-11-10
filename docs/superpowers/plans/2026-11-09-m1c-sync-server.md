# M1c — Server di sync — piano di implementazione

> **For agentic workers:** standard del progetto (`CLAUDE.md`): superpowers:executing-plans nella sessione corrente, a blocchi. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** il server parla il protocollo di sync (03 §4–6, §12): collegamento dei dispositivi, vault cifrati, upload a chunk, download con Range, commit con l'arbitro di `sync-core`, journal, snapshot, ack/status; storage fs e S3; più `GET /vaults` e `/vaults/summary` per la web app.

**Architecture:** moduli in `apps/server/src/`: `vaults/` (crypto del vault, iscrizione, elenco), `devices/` (auth Bearer), `blobs/` (BlobStore fs/S3, staging, upload, download), `sync/` (commit con vista pre-caricata per `decide`, changes, snapshot). Rotte sottili in `routes/`.

**Spec:** `docs/superpowers/specs/2026-11-09-m1c-sync-server-design.md` (C1–C10).

**Blocchi:** (A) Task 1–2 contratto e schema; (B) Task 3 storage; (C) Task 4 vault e dispositivi; (D) Task 5 upload/download; (E) Task 6–7 commit, journal, snapshot, ack, oracolo; (F) Task 8 rotte web; (G) Task 9 documenti e verifica.

## Global Constraints

- Ogni query sui dati di sync filtra per `vault_id` (gli ID di file, versioni e op sono generati dai client: chiavi primarie composte `(vault_id, id)`).
- Path, nomi di vault, hash dei contenuti: solo cifrati nel DB (AAD tabella ‖ colonna ‖ riga). Mai nei log.
- Il contenuto in chiaro non tocca mai il disco (staging già cifrato).
- Commit dei messaggi controllati con commitlint **prima** di committare.
- `pnpm format:check` prima di ogni push.

## Review Focus

1. Isolamento: un dispositivo non vede né tocca vault altrui; ID client mai usati senza `vault_id`. → Task 2, 4–7.
2. Arbitro: stessi esiti di `MemoryStore` (oracolo); transazione per op con la riga del vault bloccata. → Task 6–7.
3. Upload: segmenti cifrati all'arrivo, `hash_mismatch` scarta la sessione, nessun chiaro su disco; Range in streaming. → Task 5.

---

### Task 1: Contratto

**Files:** Create `packages/protocol/src/devices-auth.ts`, test in `packages/protocol/src/devices-auth.test.ts`; Modify `packages/protocol/src/index.ts`.

- [ ] `packages/protocol/src/devices-auth.ts`:

```ts
import { z } from "zod";
import { ErrorCode } from "./errors.js";
import { ContentHash } from "./sync.js";

export const DevicePlatform = z.enum(["windows", "macos", "linux", "ios", "android", "unknown"]);
export type DevicePlatform = z.infer<typeof DevicePlatform>;

/** Password and (when enabled) TOTP in one request, as the plugin's ConnectionService does. */
export const DeviceLoginRequest = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1),
  totp: z.string().regex(/^\d{6}$/).optional(),
});
export type DeviceLoginRequest = z.infer<typeof DeviceLoginRequest>;
export const DeviceLoginResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), enrollToken: z.string(), expiresAt: z.string() }),
  z.object({ status: z.literal("totp_required") }),
]);
export type DeviceLoginResponse = z.infer<typeof DeviceLoginResponse>;

export const EnrollVault = z.object({
  id: z.string(),
  name: z.string(),
  fileCount: z.number().int().min(0),
  deviceCount: z.number().int().min(0),
});
export type EnrollVault = z.infer<typeof EnrollVault>;
export const EnrollVaultList = z.object({ vaults: z.array(EnrollVault) });
export const CreateVaultRequest = z.object({ name: z.string().trim().min(1).max(100) });
export const LinkDeviceRequest = z.object({
  name: z.string().trim().min(1).max(100),
  platform: DevicePlatform,
  pluginVersion: z.string().max(32),
  protocolVersion: z.number().int().min(1),
});
export type LinkDeviceRequest = z.infer<typeof LinkDeviceRequest>;
export const LinkDeviceResponse = z.object({
  deviceId: z.string(),
  deviceToken: z.string(),
  vault: z.object({ id: z.string(), name: z.string() }),
});
export type LinkDeviceResponse = z.infer<typeof LinkDeviceResponse>;
export const DeviceRename = z.object({ name: z.string().trim().min(1).max(100) });

export const BlobsCheckRequest = z.object({ hashes: z.array(ContentHash).max(1000) });
export const BlobsCheckResponse = z.object({ missing: z.array(ContentHash) });
export const UploadCreateRequest = z.object({ contentHash: ContentHash, size: z.number().int().min(0) });
export const UploadSession = z.object({ uploadId: z.string(), chunkSize: z.number().int().min(1), expiresAt: z.string() });
export type UploadSession = z.infer<typeof UploadSession>;
export const UploadStatus = z.object({ received: z.array(z.number().int().min(0)), expiresAt: z.string() });
export const UploadComplete = z.object({ contentHash: ContentHash, size: z.number().int().min(0) });

export const AckRequest = z.object({ seq: z.number().int().min(0) });
export const DeviceStatusReport = z.object({
  pendingOps: z.number().int().min(0),
  pendingBytes: z.number().int().min(0),
  deferredFiles: z.number().int().min(0),
  lastErrorCode: ErrorCode.optional(),
});
export type DeviceStatusReport = z.infer<typeof DeviceStatusReport>;
```

Test minimo: login con e senza TOTP, `LinkDeviceRequest` con piattaforma sconosciuta rifiutata, `BlobsCheckRequest` oltre 1000 rifiutato. `index.ts`: `export * from "./devices-auth.js";`. Commit `feat(protocol): add device enrollment and transfer contracts`.

---

### Task 2: Schema e configurazione

**Files:** Modify `apps/server/src/db/schema.ts` (tabelle), `apps/server/src/config/{schema,load}.ts` (storage, S3, limiti), `docker/Dockerfile` (`/data`), `docker/compose.*.yml` (volume `kamino-data:/data`), `apps/server/package.json` (`@kamino/sync-core`, `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`; dev `@testcontainers/minio`); genera la migrazione `0002`.

- [ ] Schema — aggiungere a `apps/server/src/db/schema.ts` (`tokenKind` guadagna `"device_enrollment"`; importare `boolean`, `integer`, `primaryKey`, `uniqueIndex` da `drizzle-orm/pg-core`):

```ts
export const vaultStatus = pgEnum("vault_status", ["active", "deleted"]);
export const devicePlatform = pgEnum("device_platform", ["windows", "macos", "linux", "ios", "android", "unknown"]);

export const vaults = pgTable("vaults", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** Encrypted with the vault's k_meta, AAD vaults ‖ name ‖ id. */
  nameEnc: bytea("name_enc").notNull(),
  dekWrapped: bytea("dek_wrapped").notNull(),
  kekId: text("kek_id").notNull(),
  dekVersion: integer("dek_version").notNull().default(1),
  headSeq: bigint("head_seq", { mode: "number" }).notNull().default(0),
  retentionDays: integer("retention_days").notNull().default(30),
  status: vaultStatus("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  vaultId: uuid("vault_id").notNull().references(() => vaults.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  platform: devicePlatform("platform").notNull(),
  pluginVersion: text("plugin_version").notNull(),
  protocolVersion: integer("protocol_version").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  isOrigin: boolean("is_origin").notNull().default(false),
  cursorSeq: bigint("cursor_seq", { mode: "number" }).notNull().default(0),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastAckAt: timestamp("last_ack_at", { withTimezone: true }),
  pendingOps: integer("pending_ops").notNull().default(0),
  pendingBytes: bigint("pending_bytes", { mode: "number" }).notNull().default(0),
  deferredFiles: integer("deferred_files").notNull().default(0),
  lastErrorCode: text("last_error_code"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  lastIp: text("last_ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const files = pgTable(
  "files",
  {
    vaultId: uuid("vault_id").notNull().references(() => vaults.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    kind: text("kind").notNull(),
    pathEnc: bytea("path_enc").notNull(),
    pathMac: bytea("path_mac").notNull(),
    headVersionId: text("head_version_id"),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    mtime: bigint("mtime", { mode: "number" }).notNull().default(0),
    deleted: boolean("deleted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.vaultId, t.id] }),
    uniqueIndex("files_live_path").on(t.vaultId, t.pathMac).where(sql`not ${t.deleted}`),
  ],
);

export const fileVersions = pgTable(
  "file_versions",
  {
    vaultId: uuid("vault_id").notNull().references(() => vaults.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    fileId: text("file_id").notNull(),
    contentHashEnc: bytea("content_hash_enc").notNull(),
    blobId: text("blob_id").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    mtime: bigint("mtime", { mode: "number" }).notNull(),
    deviceId: uuid("device_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.id] })],
);

export const journal = pgTable(
  "journal",
  {
    vaultId: uuid("vault_id").notNull().references(() => vaults.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    fileId: text("file_id").notNull(),
    kind: text("kind").notNull(),
    opId: text("op_id"),
    versionId: text("version_id"),
    /** AAD journal ‖ path ‖ vaultId:seq. */
    pathEnc: bytea("path_enc").notNull(),
    contentHashEnc: bytea("content_hash_enc"),
    size: bigint("size", { mode: "number" }),
    mtime: bigint("mtime", { mode: "number" }),
    conflictId: text("conflict_id"),
    deviceId: uuid("device_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.seq] })],
);

export const appliedOps = pgTable(
  "applied_ops",
  {
    vaultId: uuid("vault_id").notNull().references(() => vaults.id, { onDelete: "cascade" }),
    opId: text("op_id").notNull(),
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.opId] })],
);

export const blobs = pgTable(
  "blobs",
  {
    vaultId: uuid("vault_id").notNull().references(() => vaults.id, { onDelete: "cascade" }),
    blobId: text("blob_id").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    storedSize: bigint("stored_size", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.blobId] })],
);

export const uploadSessions = pgTable("upload_sessions", {
  id: uuid("id").primaryKey(),
  vaultId: uuid("vault_id").notNull().references(() => vaults.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").notNull(),
  /** AAD upload_sessions ‖ content_hash ‖ id. */
  contentHashEnc: bytea("content_hash_enc").notNull(),
  blobId: text("blob_id").notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  chunkSize: integer("chunk_size").notNull(),
  salt: bytea("salt").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conflicts = pgTable(
  "conflicts",
  {
    vaultId: uuid("vault_id").notNull().references(() => vaults.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    fileId: text("file_id").notNull(),
    kind: text("kind").notNull(),
    baseVersionId: text("base_version_id"),
    headVersionId: text("head_version_id").notNull(),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.id] })],
);

export const conflictCandidates = pgTable(
  "conflict_candidates",
  {
    vaultId: uuid("vault_id").notNull().references(() => vaults.id, { onDelete: "cascade" }),
    conflictId: text("conflict_id").notNull(),
    versionId: text("version_id").notNull(),
    deviceId: uuid("device_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.vaultId, t.conflictId, t.versionId] })],
);
```

- [ ] Config — `Config` guadagna:

```ts
  storage:
    | { kind: "fs"; dir: string }
    | { kind: "s3"; endpoint?: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean };
  stagingDir: string;
  maxFileBytes: number;
```

lette da `KAMINO_STORAGE` (`fs` default | `s3`), `KAMINO_STORAGE_DIR` (default `/data/blobs`), `KAMINO_STAGING_DIR` (default `/data/staging`), `KAMINO_MAX_FILE_BYTES` (default 524 288 000), e per S3 `KAMINO_S3_BUCKET` (obbligatorio con `s3`), `KAMINO_S3_REGION` (default `us-east-1`), `KAMINO_S3_ENDPOINT` (opzionale, MinIO), `KAMINO_S3_ACCESS_KEY_ID`, `KAMINO_S3_SECRET_ACCESS_KEY` (segreto, anche `_FILE`, con `readSecret`), `KAMINO_S3_FORCE_PATH_STYLE` (`true`/`false`, default `false`). Le fonti in `sources`. I letterali `Config` dei test ricevono `storage: { kind: "fs", dir: … }`, `stagingDir`, `maxFileBytes`. Test di `load.test.ts`: default fs, s3 senza bucket → errore, segreto S3 da file.

- [ ] Docker: nel runtime `RUN mkdir -p /data && chown node:node /data` prima di `USER node`; nei tre compose `volumes: [kamino-data:/data]` per il servizio `kamino` e `kamino-data:` tra i volumi.

Migrazione `pnpm --filter @kamino/server db:generate` (→ `0002_*`), test/typecheck/lint, commit `feat(server): add the sync schema and storage configuration`.

---

### Task 3: Storage

**Files:** Create `apps/server/src/blobs/{store,fs-store,s3-store}.ts`, `apps/server/test/blob-store.test.ts`; Modify `apps/server/src/crypto/stream.ts` (export `decryptSegment`).

- [ ] `apps/server/src/blobs/store.ts`:

```ts
import type { Config } from "../config/schema.js";
import { FsBlobStore } from "./fs-store.js";
import { S3BlobStore } from "./s3-store.js";

/** Encrypted blobs by key ("vaultId/blobId"). `put` is durable when it resolves. */
export interface BlobStore {
  put(key: string, parts: AsyncIterable<Uint8Array>): Promise<void>;
  /** Bytes [start, endExclusive). */
  getRange(key: string, start: number, endExclusive: number): AsyncIterable<Uint8Array>;
  size(key: string): Promise<number | null>;
  delete(key: string): Promise<void>;
}

export function createBlobStore(storage: Config["storage"]): BlobStore {
  return storage.kind === "fs" ? new FsBlobStore(storage.dir) : new S3BlobStore(storage);
}

export async function collect(parts: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const p of parts) out.push(Buffer.from(p));
  return Buffer.concat(out);
}
```

- [ ] `apps/server/src/blobs/fs-store.ts`:

```ts
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BlobStore } from "./store.js";

/** Write to a temp file, fsync, rename, fsync the directory: durable and atomic. */
export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    if (!/^[0-9a-f-]+\/[0-9a-f]+$/.test(key)) throw new Error("invalid blob key");
    return join(this.root, key);
  }

  async put(key: string, parts: AsyncIterable<Uint8Array>): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    const fh = await open(tmp, "w");
    try {
      for await (const p of parts) await fh.write(p);
      await fh.sync();
    } catch (e) {
      await fh.close();
      await rm(tmp, { force: true });
      throw e;
    }
    await fh.close();
    await rename(tmp, target);
    const dir = await open(dirname(target), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }

  async *getRange(key: string, start: number, endExclusive: number): AsyncIterable<Uint8Array> {
    if (endExclusive <= start) return;
    yield* createReadStream(this.path(key), { start, end: endExclusive - 1 }) as AsyncIterable<Uint8Array>;
  }

  async size(key: string): Promise<number | null> {
    try {
      return (await stat(this.path(key))).size;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
```

- [ ] `apps/server/src/blobs/s3-store.ts`:

```ts
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";
import type { Config } from "../config/schema.js";
import type { BlobStore } from "./store.js";

type S3Config = Extract<Config["storage"], { kind: "s3" }>;

/** S3 / MinIO: multipart upload (durable when it resolves), ranged GETs. */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: S3Config) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      region: cfg.region,
      ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async put(key: string, parts: AsyncIterable<Uint8Array>): Promise<void> {
    await new Upload({ client: this.client, params: { Bucket: this.bucket, Key: key, Body: Readable.from(parts) } }).done();
  }

  async *getRange(key: string, start: number, endExclusive: number): AsyncIterable<Uint8Array> {
    if (endExclusive <= start) return;
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${start}-${endExclusive - 1}` }));
    yield* res.Body as unknown as AsyncIterable<Uint8Array>;
  }

  async size(key: string): Promise<number | null> {
    try {
      return (await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))).ContentLength ?? null;
    } catch (e) {
      if ((e as { name?: string }).name === "NotFound") return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
```

- [ ] Test di contratto — `apps/server/test/blob-store.test.ts`:

```ts
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FsBlobStore } from "../src/blobs/fs-store.js";
import { S3BlobStore } from "../src/blobs/s3-store.js";
import { collect, type BlobStore } from "../src/blobs/store.js";
import { dockerUnavailable } from "./helpers/postgres.js";

async function* chunks(...parts: string[]) {
  for (const p of parts) yield Buffer.from(p);
}
const KEY = "0190a1b2-0000-7000-8000-000000000001/abcdef0123";

function contract(name: string, make: () => BlobStore) {
  describe(name, () => {
    it("put, size, ranges, overwrite, delete", async () => {
      const s = make();
      expect(await s.size(KEY)).toBeNull();
      await s.put(KEY, chunks("hello ", "world"));
      expect(await s.size(KEY)).toBe(11);
      expect((await collect(s.getRange(KEY, 0, 11))).toString()).toBe("hello world");
      expect((await collect(s.getRange(KEY, 3, 8))).toString()).toBe("lo wo");
      expect((await collect(s.getRange(KEY, 4, 4))).length).toBe(0);
      await s.put(KEY, chunks("again"));
      expect((await collect(s.getRange(KEY, 0, 5))).toString()).toBe("again");
      await s.delete(KEY);
      expect(await s.size(KEY)).toBeNull();
    });
  });
}

const dir = mkdtempSync(join(tmpdir(), "kamino-blobs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
contract("fs", () => new FsBlobStore(dir));

describe.skipIf(dockerUnavailable)("s3 (MinIO)", () => {
  let minio: StartedMinioContainer;
  let store: S3BlobStore;
  beforeAll(async () => {
    minio = await new MinioContainer("minio/minio:latest").start();
    const cfg = {
      kind: "s3" as const, endpoint: minio.getConnectionUrl(), bucket: "kamino", region: "us-east-1",
      accessKeyId: minio.getUsername(), secretAccessKey: minio.getPassword(), forcePathStyle: true,
    };
    await new S3Client({ region: cfg.region, endpoint: cfg.endpoint, forcePathStyle: true, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } })
      .send(new CreateBucketCommand({ Bucket: "kamino" }));
    store = new S3BlobStore(cfg);
  }, 120_000);
  afterAll(async () => minio?.stop());
  contract("s3", () => store);
});
```

(Se `MinioContainer` non espone `getUsername/getPassword`, usare le credenziali predefinite `minioadmin`/`minioadmin`.)

In `stream.ts` esportare `decryptSegment`. Run test/typecheck/lint; commit `feat(server): add filesystem and S3 blob stores`.

---

### Task 4: Vault e dispositivi

**Files:** Create `apps/server/src/vaults/{vault-crypto,service}.ts`, `apps/server/src/devices/auth.ts`, `apps/server/src/routes/enroll.ts`, `apps/server/test/helpers/sync.ts`, `apps/server/test/enroll.test.ts`; Modify `apps/server/src/auth/service.ts` (`checkCredentials` per il dispositivo), `apps/server/src/auth/http.ts` (CSRF non richiesto con `Authorization: Bearer`), `apps/server/src/app.ts` (registrazioni e dipendenze `blobStore`).

- [ ] `apps/server/src/vaults/vault-crypto.ts`:

```ts
import { collisionKey } from "@kamino/sync-core";
import { unwrapDek, vaultKeys, type VaultKeys } from "../crypto/dek.js";
import { decryptField, encryptField } from "../crypto/field.js";
import type { Kek } from "../crypto/keyring.js";
import { blobId, pathMac } from "../crypto/mac.js";

/** Everything a request needs to read and write one vault's encrypted rows. */
export class VaultCrypto {
  readonly keys: VaultKeys;
  constructor(readonly vaultId: string, kek: Kek, dekWrapped: Uint8Array) {
    this.keys = vaultKeys(unwrapDek(kek, vaultId, dekWrapped));
  }
  enc(table: string, column: string, rowId: string, value: string): Buffer {
    return encryptField(this.keys.meta, { table, column, rowId }, value);
  }
  dec(table: string, column: string, rowId: string, sealed: Uint8Array): string {
    return decryptField(this.keys.meta, { table, column, rowId }, sealed).toString("utf8");
  }
  pathMac(path: string): Buffer {
    return pathMac(this.keys.pathmac, collisionKey(path));
  }
  macOfKey(key: string): Buffer {
    return pathMac(this.keys.pathmac, key);
  }
  blobId(contentHash: string): string {
    return blobId(this.keys.blobid, contentHash);
  }
}
```

- [ ] `apps/server/src/vaults/service.ts`:

```ts
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { generateDek, wrapDek } from "../crypto/dek.js";
import type { Kek } from "../crypto/keyring.js";
import type { Db } from "../db/client.js";
import { devices, files, oneTimeTokens, vaults } from "../db/schema.js";
import { AuthError } from "../auth/service.js";
import { hashToken, randomToken, uuidv7 } from "../auth/tokens.js";
import { VaultCrypto } from "./vault-crypto.js";

export const ENROLL_TTL_MS = 10 * 60_000;
export type Vault = typeof vaults.$inferSelect;

export class VaultService {
  private readonly crypto = new Map<string, VaultCrypto>();

  constructor(
    private readonly db: Db,
    private readonly kek: Kek,
    private readonly now: () => number = Date.now,
  ) {}

  cryptoOf(v: Vault): VaultCrypto {
    let c = this.crypto.get(v.id);
    if (!c) {
      c = new VaultCrypto(v.id, this.kek, v.dekWrapped);
      this.crypto.set(v.id, c);
    }
    return c;
  }

  async byId(id: string): Promise<Vault | undefined> {
    return (await this.db.select().from(vaults).where(eq(vaults.id, id)))[0];
  }

  nameOf(v: Vault): string {
    return this.cryptoOf(v).dec("vaults", "name", v.id, v.nameEnc);
  }

  async create(ownerId: string, name: string): Promise<Vault> {
    const id = uuidv7();
    const dek = generateDek();
    const draft = { id, dekWrapped: wrapDek(this.kek, id, dek) } as Vault;
    const nameEnc = this.cryptoOf(draft).enc("vaults", "name", id, name);
    const [v] = await this.db.insert(vaults).values({ id, ownerId, nameEnc, dekWrapped: draft.dekWrapped, kekId: this.kek.id, createdAt: new Date(this.now()) }).returning();
    return v!;
  }

  async listForUser(ownerId: string): Promise<Vault[]> {
    return this.db.select().from(vaults).where(and(eq(vaults.ownerId, ownerId), eq(vaults.status, "active")));
  }

  async counts(vaultId: string): Promise<{ fileCount: number; deviceCount: number }> {
    const [f] = await this.db.select({ n: count() }).from(files).where(and(eq(files.vaultId, vaultId), eq(files.deleted, false), eq(files.kind, "file")));
    const [d] = await this.db.select({ n: count() }).from(devices).where(and(eq(devices.vaultId, vaultId), isNull(devices.revokedAt)));
    return { fileCount: f?.n ?? 0, deviceCount: d?.n ?? 0 };
  }

  // ---------- enrollment (C5) ----------

  async createEnrollToken(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken();
    const expiresAt = new Date(this.now() + ENROLL_TTL_MS);
    await this.db.insert(oneTimeTokens).values({ id: uuidv7(), kind: "device_enrollment", tokenHash: hashToken(token), userId, expiresAt });
    return { token, expiresAt };
  }

  /** The user behind a valid enrollment token (reusable for 10 minutes). */
  async enrollUser(token: string): Promise<string> {
    const row = (await this.db.select().from(oneTimeTokens).where(and(eq(oneTimeTokens.tokenHash, hashToken(token)), eq(oneTimeTokens.kind, "device_enrollment"))))[0];
    if (!row?.userId || row.expiresAt.getTime() <= this.now()) throw new AuthError("token_expired", 401);
    return row.userId;
  }

  async linkDevice(userId: string, vaultId: string, d: { name: string; platform: (typeof devices.$inferInsert)["platform"]; pluginVersion: string; protocolVersion: number }, ip: string | undefined) {
    const v = await this.byId(vaultId);
    if (!v || v.ownerId !== userId || v.status !== "active") throw new AuthError("not_found", 404);
    const token = randomToken();
    const id = uuidv7();
    await this.db.transaction(async (tx) => {
      const [existing] = await tx.select({ n: count() }).from(devices).where(eq(devices.vaultId, vaultId));
      await tx.insert(devices).values({
        id, userId, vaultId, ...d, tokenHash: hashToken(token), isOrigin: (existing?.n ?? 0) === 0,
        lastIp: ip ?? null, lastSeenAt: new Date(this.now()), createdAt: new Date(this.now()),
      });
    });
    return { deviceId: id, deviceToken: token, vault: { id: v.id, name: this.nameOf(v) } };
  }

  void = sql;
}
```

(L'ultima riga va tolta: serve solo a ricordare di non lasciare import inutilizzati; se `sql` non serve, toglierlo dall'import.)

- [ ] Credenziali del dispositivo — in `AuthService`:

```ts
  /** Device login (C5): password, then TOTP in the same request when enabled. */
  async checkDeviceCredentials(username: string, password: string, totp: string | undefined, ctx: Ctx): Promise<{ status: "ok"; user: User } | { status: "totp_required" }> {
    const r = await this.login(username, password, ctx);
    if (r.status === "ok") return r;
    this.challenges.delete(r.challengeId);
    if (totp === undefined) return { status: "totp_required" };
    const u = await this.byUsername(username);
    if (!u || !(await this.checkSecondFactor(u, totp))) throw new AuthError("totp_invalid", 401);
    await this.event(u.id, "device_linked", ctx);
    return { status: "ok", user: u };
  }
```

(`checkSecondFactor` diventa `private` accessibile a questo metodo: è nella stessa classe.)

- [ ] `apps/server/src/devices/auth.ts`:

```ts
import { PRODUCT_SLUG } from "@kamino/brand";
import { PROTOCOL_MIN_SUPPORTED, PROTOCOL_VERSION } from "@kamino/protocol";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { fail } from "../auth/http.js";
import { hashToken } from "../auth/tokens.js";
import type { Db } from "../db/client.js";
import { devices, users } from "../db/schema.js";

export const PROTOCOL_HEADER = `${PRODUCT_SLUG}-protocol`;
export type Device = typeof devices.$inferSelect;

declare module "fastify" {
  interface FastifyRequest {
    device: Device | null;
  }
}

/** Bearer device token → its device; revoked 401, blocked user 403, wrong protocol 426. */
export function deviceGuard(db: Db, now: () => number = Date.now) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const proto = Number(req.headers[PROTOCOL_HEADER]);
    if (!Number.isInteger(proto) || proto < PROTOCOL_MIN_SUPPORTED || proto > PROTOCOL_VERSION)
      return fail(reply, 426, "protocol_unsupported");
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!token) return fail(reply, 401, "unauthorized");
    const row = (await db.select({ d: devices, status: users.status }).from(devices).innerJoin(users, eq(users.id, devices.userId)).where(eq(devices.tokenHash, hashToken(token))))[0];
    if (!row) return fail(reply, 401, "unauthorized");
    if (row.d.revokedAt) return fail(reply, 401, "device_revoked");
    if (row.status !== "active") return fail(reply, 403, "user_blocked");
    const params = req.params as { vaultId?: string };
    if (params.vaultId !== undefined && params.vaultId !== row.d.vaultId) return fail(reply, 404, "not_found");
    req.device = row.d;
    if (!row.d.lastSeenAt || now() - row.d.lastSeenAt.getTime() > 60_000)
      await db.update(devices).set({ lastSeenAt: new Date(now()), lastIp: req.ip }).where(eq(devices.id, row.d.id));
  };
}
```

- [ ] `apps/server/src/routes/enroll.ts` (rotte `POST /devices/login`, `GET/POST /enroll/vaults`, `POST /enroll/vaults/:vaultId/devices`, `PATCH/DELETE /device`):

```ts
import { CreateVaultRequest, DeviceLoginRequest, DeviceRename, LinkDeviceRequest } from "@kamino/protocol";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ctxOf, fail } from "../auth/http.js";
import { RateLimiter } from "../auth/rate-limit.js";
import { keyOf, type AuthService } from "../auth/service.js";
import type { Db } from "../db/client.js";
import { devices } from "../db/schema.js";
import { deviceGuard } from "../devices/auth.js";
import type { VaultService } from "../vaults/service.js";
import { parse } from "./auth.js";

export function enrollRoutes(db: Db, auth: AuthService, vaultsSvc: VaultService) {
  const limiter = new RateLimiter<"login">({ login: { max: 10, windowMs: 15 * 60_000 } });
  const limited = (key: string, reply: FastifyReply) => {
    const r = limiter.hit("login", key);
    if (r.ok) return false;
    void fail(reply, 429, "rate_limited", r.retryAfterSec);
    return true;
  };
  const enrollUser = async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    return vaultsSvc.enrollUser(h?.startsWith("Bearer ") ? h.slice(7) : "");
  };

  return async (app: FastifyInstance) => {
    app.decorateRequest("device", null);
    app.post("/devices/login", async (req, reply) => {
      if (limited(req.ip, reply)) return reply;
      const b = parse(DeviceLoginRequest, req, reply);
      if (!b) return reply;
      if (limited(`user:${keyOf(b.username)}`, reply)) return reply;
      const r = await auth.checkDeviceCredentials(b.username, b.password, b.totp, ctxOf(req));
      if (r.status === "totp_required") return r;
      const t = await vaultsSvc.createEnrollToken(r.user.id);
      return { status: "ok", enrollToken: t.token, expiresAt: t.expiresAt.toISOString() };
    });
    app.get("/enroll/vaults", async (req) => {
      const userId = await enrollUser(req);
      const list = await vaultsSvc.listForUser(userId);
      return { vaults: await Promise.all(list.map(async (v) => ({ id: v.id, name: vaultsSvc.nameOf(v), ...(await vaultsSvc.counts(v.id)) }))) };
    });
    app.post("/enroll/vaults", async (req, reply) => {
      const userId = await enrollUser(req);
      const b = parse(CreateVaultRequest, req, reply);
      if (!b) return reply;
      const v = await vaultsSvc.create(userId, b.name);
      return { id: v.id, name: b.name, fileCount: 0, deviceCount: 0 };
    });
    app.post<{ Params: { vaultId: string } }>("/enroll/vaults/:vaultId/devices", async (req, reply) => {
      const userId = await enrollUser(req);
      const b = parse(LinkDeviceRequest, req, reply);
      if (!b) return reply;
      return vaultsSvc.linkDevice(userId, req.params.vaultId, b, req.ip);
    });
    const guard = deviceGuard(db);
    app.patch("/device", { preHandler: guard }, async (req, reply) => {
      const b = parse(DeviceRename, req, reply);
      if (!b) return reply;
      await db.update(devices).set({ name: b.name }).where(eq(devices.id, req.device!.id));
      return reply.code(204).send();
    });
    app.delete("/device", { preHandler: guard }, async (req, reply) => {
      await db.update(devices).set({ revokedAt: new Date() }).where(eq(devices.id, req.device!.id));
      return reply.code(204).send();
    });
  };
}
```

`AuthError("token_expired")` sull'iscrizione arriva al gestore degli errori esistente. In `http.ts` il controllo CSRF salta le richieste con `authorization: Bearer …` (non usano cookie: un sito terzo non può impostare quell'intestazione senza preflight CORS). Il `decorateRequest("device", null)` va fatto una volta sola nell'app (spostarlo in `registerAuthHttp` se il plugin di rotte viene registrato più volte).

- [ ] Helper di test — `apps/server/test/helpers/sync.ts`: crea un utente (via `AuthService.invite` + `acceptInvite`), fa `POST /devices/login`, crea un vault, collega un dispositivo e restituisce `{ token, vaultId, deviceId, call(method, path, body?, headers?) }` che aggiunge `authorization` e l'intestazione di protocollo. Test `apps/server/test/enroll.test.ts`: login senza/con TOTP, `totp_invalid`, iscrizione scaduta (orologio +11 min → `token_expired`), vault di un altro utente → `not_found`, dispositivo revocato (`DELETE /device` poi qualunque rotta → `device_revoked`), utente bloccato → `user_blocked`, protocollo `99` → `426`, primo dispositivo `isOrigin`.

Commit `feat(server): device enrollment, vaults and device tokens`.

---

### Task 5: Upload e download

**Files:** Create `apps/server/src/blobs/uploads.ts`, `apps/server/src/routes/transfer.ts`, `apps/server/test/transfer.test.ts`.

- [ ] `apps/server/src/blobs/uploads.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, lt } from "drizzle-orm";
import { AuthError } from "../auth/service.js";
import { uuidv7 } from "../auth/tokens.js";
import { CryptoError } from "../crypto/aead.js";
import { blobKey, decryptSegment, encryptSegment, header, HEADER_BYTES, TAG_BYTES } from "../crypto/stream.js";
import type { Db } from "../db/client.js";
import { blobs, uploadSessions } from "../db/schema.js";
import type { VaultCrypto } from "../vaults/vault-crypto.js";
import type { BlobStore } from "./store.js";

export const CHUNK_SIZE = 4 * 1024 * 1024;
const SESSION_TTL_MS = 24 * 3_600_000;

export class TransferError extends Error {
  constructor(readonly code: "file_too_large" | "hash_mismatch" | "not_found" | "invalid_request", readonly status: number) {
    super(code);
  }
}

export const blobKeyOf = (vaultId: string, blobId: string) => `${vaultId}/${blobId}`;

export class UploadService {
  constructor(
    private readonly db: Db,
    private readonly store: BlobStore,
    private readonly stagingDir: string,
    private readonly maxFileBytes: number,
    private readonly now: () => number = Date.now,
    private readonly chunkSize = CHUNK_SIZE,
  ) {}

  private dir(id: string): string {
    return join(this.stagingDir, id);
  }

  async missing(vc: VaultCrypto, hashes: string[]): Promise<string[]> {
    if (hashes.length === 0) return [];
    const ids = new Map(hashes.map((h) => [vc.blobId(h), h]));
    const rows = await this.db.select({ blobId: blobs.blobId }).from(blobs).where(and(eq(blobs.vaultId, vc.vaultId), inArray(blobs.blobId, [...ids.keys()])));
    const present = new Set(rows.map((r) => r.blobId));
    return hashes.filter((h) => !present.has(vc.blobId(h)));
  }

  async create(vc: VaultCrypto, deviceId: string, contentHash: string, size: number) {
    if (size > this.maxFileBytes) throw new TransferError("file_too_large", 413);
    const id = uuidv7();
    const expiresAt = new Date(this.now() + SESSION_TTL_MS);
    await this.db.insert(uploadSessions).values({
      id, vaultId: vc.vaultId, deviceId, contentHashEnc: vc.enc("upload_sessions", "content_hash", id, contentHash),
      blobId: vc.blobId(contentHash), size, chunkSize: this.chunkSize, salt: randomBytes(32), expiresAt,
    });
    await mkdir(this.dir(id), { recursive: true });
    return { uploadId: id, chunkSize: this.chunkSize, expiresAt: expiresAt.toISOString() };
  }

  private async session(vc: VaultCrypto, id: string) {
    const s = (await this.db.select().from(uploadSessions).where(and(eq(uploadSessions.id, id), eq(uploadSessions.vaultId, vc.vaultId))))[0];
    if (!s || s.expiresAt.getTime() <= this.now()) throw new TransferError("not_found", 404);
    return s;
  }

  private static count(size: number, chunk: number): number {
    return Math.max(1, Math.ceil(size / chunk));
  }

  /** C6: the chunk is encrypted as STREAM segment `index` on arrival; plaintext never hits the disk. */
  async putChunk(vc: VaultCrypto, id: string, index: number, body: Buffer): Promise<number[]> {
    const s = await this.session(vc, id);
    const count = UploadService.count(s.size, s.chunkSize);
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new TransferError("invalid_request", 400);
    const expected = index === count - 1 ? s.size - (count - 1) * s.chunkSize : s.chunkSize;
    if (body.length !== expected) throw new TransferError("invalid_request", 400);
    const sealed = encryptSegment(blobKey(vc.keys.content, s.salt), { vaultId: vc.vaultId, blobId: s.blobId }, index, index === count - 1, body);
    const target = join(this.dir(id), String(index));
    await writeFile(`${target}.tmp`, sealed);
    await rename(`${target}.tmp`, target);
    return this.received(id);
  }

  async received(id: string): Promise<number[]> {
    const names = await readdir(this.dir(id)).catch(() => [] as string[]);
    return names.filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b);
  }

  async status(vc: VaultCrypto, id: string) {
    const s = await this.session(vc, id);
    return { received: await this.received(id), expiresAt: s.expiresAt.toISOString() };
  }

  /** Verifies SHA-256 by decrypting in order, then promotes the segments as the blob (no re-encryption). */
  async complete(vc: VaultCrypto, id: string): Promise<{ contentHash: string; size: number }> {
    const s = await this.session(vc, id);
    const contentHash = vc.dec("upload_sessions", "content_hash", id, s.contentHashEnc);
    const count = UploadService.count(s.size, s.chunkSize);
    const got = await this.received(id);
    if (got.length !== count) throw new TransferError("invalid_request", 409);
    const key = blobKey(vc.keys.content, s.salt);
    const ids = { vaultId: vc.vaultId, blobId: s.blobId };
    const sha = createHash("sha256");
    try {
      for (let i = 0; i < count; i++) sha.update(decryptSegment(key, ids, i, i === count - 1, await readFile(join(this.dir(id), String(i)))));
    } catch (e) {
      if (!(e instanceof CryptoError)) throw e;
      await this.discard(id);
      throw new TransferError("hash_mismatch", 422);
    }
    if (sha.digest("hex") !== contentHash) {
      await this.discard(id);
      throw new TransferError("hash_mismatch", 422);
    }
    const dir = this.dir(id);
    const hdr = header(s.salt, s.chunkSize);
    await this.store.put(blobKeyOf(vc.vaultId, s.blobId), (async function* () {
      yield hdr;
      for (let i = 0; i < count; i++) yield await readFile(join(dir, String(i)));
    })());
    const storedSize = HEADER_BYTES + s.size + count * TAG_BYTES;
    await this.db.insert(blobs).values({ vaultId: vc.vaultId, blobId: s.blobId, size: s.size, storedSize }).onConflictDoNothing();
    await this.discard(id);
    return { contentHash, size: s.size };
  }

  private async discard(id: string): Promise<void> {
    await this.db.delete(uploadSessions).where(eq(uploadSessions.id, id));
    await rm(this.dir(id), { recursive: true, force: true });
  }

  /** C10: expired sessions and their staging go away. */
  async sweep(): Promise<void> {
    const old = await this.db.select({ id: uploadSessions.id }).from(uploadSessions).where(lt(uploadSessions.expiresAt, new Date(this.now())));
    for (const s of old) await this.discard(s.id);
  }
}

/** Range download (C7): reads and decrypts only the segments covering [start, end). */
export async function* readPlain(store: BlobStore, vc: VaultCrypto, blobId: string, size: number, start: number, end: number): AsyncIterable<Buffer> {
  if (end <= start) return;
  const key = blobKeyOf(vc.vaultId, blobId);
  const head = Buffer.concat(await arrayOf(store.getRange(key, 0, HEADER_BYTES)));
  const segmentSize = head.readUInt32BE(33);
  const k = blobKey(vc.keys.content, head.subarray(1, 33));
  const count = Math.max(1, Math.ceil(size / segmentSize));
  const ids = { vaultId: vc.vaultId, blobId };
  for (let i = Math.floor(start / segmentSize); i <= Math.floor((end - 1) / segmentSize); i++) {
    const plainLen = i === count - 1 ? size - (count - 1) * segmentSize : segmentSize;
    const from = HEADER_BYTES + i * (segmentSize + TAG_BYTES);
    const sealed = Buffer.concat(await arrayOf(store.getRange(key, from, from + plainLen + TAG_BYTES)));
    const plain = decryptSegment(k, ids, i, i === count - 1, sealed);
    const segStart = i * segmentSize;
    yield plain.subarray(Math.max(0, start - segStart), Math.min(plain.length, end - segStart));
  }
}

async function arrayOf(it: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const p of it) out.push(Buffer.from(p));
  return out;
}
```

- [ ] `apps/server/src/routes/transfer.ts`: rotte `POST /vaults/:vaultId/blobs/check`, `POST …/uploads`, `PUT …/uploads/:uploadId/chunks/:index` (corpo binario: `app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: CHUNK_SIZE + 1024 }, …)`), `GET …/uploads/:uploadId`, `POST …/uploads/:uploadId/complete`, `GET …/blobs/:contentHash` (`Range: bytes=a-b` → `206` con `Content-Range`, altrimenti `200`; `Content-Length`; `Readable.from(readPlain(...))`). Tutte con `preHandler: deviceGuard(db)`; il `VaultCrypto` si ricava dal vault del dispositivo (`vaultsSvc.cryptoOf(await vaultsSvc.byId(req.device.vaultId))`). `TransferError` → `fail(reply, err.status, err.code)` nel gestore degli errori (aggiungerlo a `http.ts` accanto ad `AuthError`).

- [ ] Test `apps/server/test/transfer.test.ts` (con `UploadService` a `chunkSize` piccolo, es. 8 byte, iniettato nell'app di test): upload di 30 byte in 4 chunk inviati in ordine 3,0,2,1 e uno ripetuto → `received` completo → `complete` → `blobs/check` non lo elenca più; `hash_mismatch` con un hash sbagliato (sessione sparita); chunk di lunghezza sbagliata → 400; `file_too_large`; download intero e con `Range: bytes=5-20` (attraversa 3 segmenti) → stessi byte; **nessun file dello staging o dello storage contiene il chiaro** (cercare la stringa dentro i file); sessione scaduta → `sweep` la cancella.

Commit `feat(server): chunked uploads encrypted on arrival and ranged downloads`.

---

### Task 6: Commit con l'arbitro

**Files:** Create `apps/server/src/sync/{view,commit}.ts`; Modify `apps/server/src/routes/transfer.ts` → `apps/server/src/routes/sync.ts` per `commits`, `changes`, `snapshot`, `ack`, `status`.

- [ ] `apps/server/src/sync/view.ts`:

```ts
import type { FinalResult } from "@kamino/protocol";
import type { ArbiterView, FileRecord, OpenConflict } from "@kamino/sync-core";

export type Need =
  | { kind: "recorded"; opId: string }
  | { kind: "file"; fileId: string }
  | { kind: "liveAt"; key: string }
  | { kind: "conflict"; fileId: string }
  | { kind: "descendants"; path: string }
  | { kind: "version"; versionId: string }
  | { kind: "blob"; hash: string };

/** Thrown by the view when decide() reads something not loaded yet (C3). */
export class NeedData extends Error {
  constructor(readonly need: Need) {
    super("need data");
  }
}

/** A synchronous ArbiterView over data loaded from the DB; misses ask for more. */
export class PrefetchedView implements ArbiterView {
  readonly recordedMap = new Map<string, FinalResult | null>();
  readonly files = new Map<string, FileRecord | null>();
  readonly live = new Map<string, FileRecord | null>();
  readonly conflicts = new Map<string, OpenConflict | null>();
  readonly descendants = new Map<string, boolean>();
  readonly versions = new Map<string, boolean>();
  readonly blobs = new Map<string, boolean>();

  private get<K, V>(m: Map<K, V>, k: K, need: Need): V {
    if (!m.has(k)) throw new NeedData(need);
    return m.get(k) as V;
  }
  recorded(opId: string) {
    return this.get(this.recordedMap, opId, { kind: "recorded", opId }) ?? undefined;
  }
  file(fileId: string) {
    return this.get(this.files, fileId, { kind: "file", fileId }) ?? undefined;
  }
  liveAt(key: string) {
    return this.get(this.live, key, { kind: "liveAt", key }) ?? undefined;
  }
  openConflict(fileId: string) {
    return this.get(this.conflicts, fileId, { kind: "conflict", fileId }) ?? undefined;
  }
  hasLiveDescendants(path: string) {
    return this.get(this.descendants, path, { kind: "descendants", path });
  }
  versionExists(versionId: string) {
    return this.get(this.versions, versionId, { kind: "version", versionId });
  }
  blobPresent(hash: string) {
    return this.get(this.blobs, hash, { kind: "blob", hash });
  }
}
```

- [ ] `apps/server/src/sync/commit.ts`:

```ts
import type { FinalResult, JournalEntry, Op, OpResult, Snapshot } from "@kamino/protocol";
import { collisionKey, decide, type Decision, type FileRecord, type Mutation } from "@kamino/sync-core";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { uuidv7 } from "../auth/tokens.js";
import type { Db } from "../db/client.js";
import { appliedOps, blobs, conflictCandidates, conflicts, devices, files, fileVersions, journal, vaults } from "../db/schema.js";
import type { VaultCrypto } from "../vaults/vault-crypto.js";
import { NeedData, PrefetchedView, type Need } from "./view.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class SyncService {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  /** 03 §5: ops in order, each atomic on its own, vault row locked. */
  async commit(vc: VaultCrypto, deviceId: string, ops: Op[]): Promise<{ results: OpResult[]; head: number }> {
    const results: OpResult[] = [];
    for (const op of ops) results.push(await this.db.transaction((tx) => this.applyOne(tx, vc, deviceId, op)));
    const [v] = await this.db.select({ head: vaults.headSeq }).from(vaults).where(eq(vaults.id, vc.vaultId));
    await this.db.update(devices).set({ lastSyncAt: new Date(this.now()) }).where(eq(devices.id, deviceId));
    return { results, head: v?.head ?? 0 };
  }

  private async applyOne(tx: Tx, vc: VaultCrypto, deviceId: string, op: Op): Promise<OpResult> {
    const [locked] = await tx.select({ head: vaults.headSeq }).from(vaults).where(eq(vaults.id, vc.vaultId)).for("update");
    let head = locked!.head;
    const view = new PrefetchedView();
    let decision: Decision;
    for (let guard = 0; ; guard++) {
      try {
        decision = decide(view, op, { newId: uuidv7 });
        break;
      } catch (e) {
        if (!(e instanceof NeedData) || guard > 200) throw e;
        await this.load(tx, vc, view, e.need);
      }
    }
    let seq = head;
    for (const m of decision.mutations) {
      if (m.type === "journal") {
        seq = ++head;
        await this.insertJournal(tx, vc, deviceId, op.opId, seq, m.entry);
      } else await this.mutate(tx, vc, deviceId, m);
    }
    if (head !== locked!.head) await tx.update(vaults).set({ headSeq: head }).where(eq(vaults.id, vc.vaultId));
    const r = decision.result;
    if (r.status === "accepted") {
      const result: FinalResult = { ...r, seq };
      await tx.insert(appliedOps).values({ vaultId: vc.vaultId, opId: op.opId, result });
      return result;
    }
    if (r.status === "conflict") await tx.insert(appliedOps).values({ vaultId: vc.vaultId, opId: op.opId, result: r });
    return r;
  }

  private async fileRecord(tx: Tx, vc: VaultCrypto, row: typeof files.$inferSelect): Promise<FileRecord> {
    let headHash: string | null = null;
    if (row.headVersionId) {
      const [v] = await tx.select().from(fileVersions).where(and(eq(fileVersions.vaultId, vc.vaultId), eq(fileVersions.id, row.headVersionId)));
      if (v) headHash = vc.dec("file_versions", "content_hash", `${vc.vaultId}:${v.id}`, v.contentHashEnc);
    }
    return {
      fileId: row.id, kind: row.kind as "file" | "folder", path: vc.dec("files", "path", `${vc.vaultId}:${row.id}`, row.pathEnc),
      headVersionId: row.headVersionId, headHash, size: row.size, mtime: row.mtime, deleted: row.deleted,
    };
  }

  private async load(tx: Tx, vc: VaultCrypto, view: PrefetchedView, need: Need): Promise<void> {
    const v = vc.vaultId;
    switch (need.kind) {
      case "recorded": {
        const [r] = await tx.select().from(appliedOps).where(and(eq(appliedOps.vaultId, v), eq(appliedOps.opId, need.opId)));
        view.recordedMap.set(need.opId, (r?.result as FinalResult | undefined) ?? null);
        return;
      }
      case "file": {
        const [r] = await tx.select().from(files).where(and(eq(files.vaultId, v), eq(files.id, need.fileId)));
        view.files.set(need.fileId, r ? await this.fileRecord(tx, vc, r) : null);
        return;
      }
      case "liveAt": {
        const [r] = await tx.select().from(files).where(and(eq(files.vaultId, v), eq(files.pathMac, vc.macOfKey(need.key)), eq(files.deleted, false)));
        view.live.set(need.key, r ? await this.fileRecord(tx, vc, r) : null);
        return;
      }
      case "conflict": {
        const [c] = await tx.select().from(conflicts).where(and(eq(conflicts.vaultId, v), eq(conflicts.fileId, need.fileId), eq(conflicts.status, "open")));
        if (!c) {
          view.conflicts.set(need.fileId, null);
          return;
        }
        const cands = await tx.select().from(conflictCandidates).where(and(eq(conflictCandidates.vaultId, v), eq(conflictCandidates.conflictId, c.id)));
        view.conflicts.set(need.fileId, { conflictId: c.id, fileId: c.fileId, candidates: cands.map((x) => x.versionId) });
        return;
      }
      case "descendants": {
        // C8: paths are encrypted, so the prefix check decrypts the vault's live paths in memory.
        const prefix = `${collisionKey(need.path)}/`;
        const rows = await tx.select().from(files).where(and(eq(files.vaultId, v), eq(files.deleted, false)));
        view.descendants.set(need.path, rows.some((r) => collisionKey(vc.dec("files", "path", `${v}:${r.id}`, r.pathEnc)).startsWith(prefix)));
        return;
      }
      case "version": {
        const [r] = await tx.select({ id: fileVersions.id }).from(fileVersions).where(and(eq(fileVersions.vaultId, v), eq(fileVersions.id, need.versionId)));
        view.versions.set(need.versionId, !!r);
        return;
      }
      case "blob": {
        const [r] = await tx.select({ id: blobs.blobId }).from(blobs).where(and(eq(blobs.vaultId, v), eq(blobs.blobId, vc.blobId(need.hash))));
        view.blobs.set(need.hash, !!r);
        return;
      }
    }
  }

  private async mutate(tx: Tx, vc: VaultCrypto, deviceId: string, m: Exclude<Mutation, { type: "journal" }>): Promise<void> {
    const v = vc.vaultId;
    const fileWhere = (id: string) => and(eq(files.vaultId, v), eq(files.id, id));
    switch (m.type) {
      case "createFile":
        await tx.insert(files).values({
          vaultId: v, id: m.file.fileId, kind: m.file.kind, pathEnc: vc.enc("files", "path", `${v}:${m.file.fileId}`, m.file.path),
          pathMac: vc.pathMac(m.file.path), headVersionId: m.file.headVersionId, size: m.file.size, mtime: m.file.mtime, deleted: false,
        });
        return;
      case "version":
        await tx.insert(fileVersions).values({
          vaultId: v, id: m.versionId, fileId: m.fileId, contentHashEnc: vc.enc("file_versions", "content_hash", `${v}:${m.versionId}`, m.hash),
          blobId: vc.blobId(m.hash), size: m.size, mtime: m.mtime, deviceId,
        });
        return;
      case "head":
        await tx.update(files).set({ headVersionId: m.versionId, size: m.size, mtime: m.mtime, deleted: false }).where(fileWhere(m.fileId));
        return;
      case "path":
        await tx.update(files).set({ pathEnc: vc.enc("files", "path", `${v}:${m.fileId}`, m.path), pathMac: vc.pathMac(m.path) }).where(fileWhere(m.fileId));
        return;
      case "tombstone":
        await tx.update(files).set({ deleted: true }).where(fileWhere(m.fileId));
        return;
      case "undelete":
        await tx.update(files).set({ deleted: false }).where(fileWhere(m.fileId));
        return;
      case "openConflict":
        await tx.insert(conflicts).values({ vaultId: v, id: m.conflictId, fileId: m.fileId, kind: m.kind, baseVersionId: m.baseVersionId, headVersionId: m.headVersionId });
        await tx.insert(conflictCandidates).values({ vaultId: v, conflictId: m.conflictId, versionId: m.candidate, deviceId });
        return;
      case "addCandidate":
        await tx.insert(conflictCandidates).values({ vaultId: v, conflictId: m.conflictId, versionId: m.versionId, deviceId });
        return;
    }
  }

  private async insertJournal(tx: Tx, vc: VaultCrypto, deviceId: string, opId: string, seq: number, e: Extract<Mutation, { type: "journal" }>["entry"]): Promise<void> {
    const v = vc.vaultId;
    await tx.insert(journal).values({
      vaultId: v, seq, type: e.type, fileId: e.fileId, kind: e.kind, opId, versionId: e.versionId ?? null,
      pathEnc: vc.enc("journal", "path", `${v}:${seq}`, e.path),
      contentHashEnc: e.contentHash === undefined ? null : vc.enc("journal", "content_hash", `${v}:${seq}`, e.contentHash),
      size: e.size ?? null, mtime: e.mtime ?? null, conflictId: e.conflictId ?? null, deviceId, at: new Date(this.now()),
    });
  }

  async changes(vc: VaultCrypto, after: number, limit: number): Promise<{ entries: JournalEntry[]; head: number; hasMore: boolean }> {
    const v = vc.vaultId;
    const rows = await this.db.select().from(journal).where(and(eq(journal.vaultId, v), gt(journal.seq, after))).orderBy(asc(journal.seq)).limit(limit + 1);
    const [h] = await this.db.select({ head: vaults.headSeq }).from(vaults).where(eq(vaults.id, v));
    const entries = rows.slice(0, limit).map((r): JournalEntry => ({
      seq: r.seq, type: r.type, fileId: r.fileId, kind: r.kind as "file" | "folder", path: vc.dec("journal", "path", `${v}:${r.seq}`, r.pathEnc),
      deviceId: r.deviceId, at: r.at.toISOString(),
      ...(r.opId ? { opId: r.opId } : {}), ...(r.versionId ? { versionId: r.versionId } : {}),
      ...(r.contentHashEnc ? { contentHash: vc.dec("journal", "content_hash", `${v}:${r.seq}`, r.contentHashEnc) } : {}),
      ...(r.size !== null ? { size: r.size } : {}), ...(r.mtime !== null ? { mtime: r.mtime } : {}),
      ...(r.conflictId ? { conflictId: r.conflictId } : {}),
    }));
    return { entries, head: h?.head ?? 0, hasMore: rows.length > limit };
  }

  /** One consistent read: the state is exactly the one at `head` (03 §6.2). */
  async snapshot(vc: VaultCrypto): Promise<Snapshot> {
    return this.db.transaction(
      async (tx) => {
        const v = vc.vaultId;
        const [h] = await tx.select({ head: vaults.headSeq }).from(vaults).where(eq(vaults.id, v));
        const rows = await tx.select().from(files).where(and(eq(files.vaultId, v), eq(files.deleted, false)));
        const out: Snapshot["files"] = [];
        for (const r of rows) {
          const rec = await this.fileRecord(tx, vc, r);
          out.push({ fileId: rec.fileId, kind: rec.kind, path: rec.path, versionId: rec.headVersionId, contentHash: rec.headHash, size: rec.size, mtime: rec.mtime });
        }
        const open = await tx.select().from(conflicts).where(and(eq(conflicts.vaultId, v), eq(conflicts.status, "open")));
        return { head: h?.head ?? 0, files: out, openConflicts: open.map((c) => ({ conflictId: c.id, fileId: c.fileId })) };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async ack(deviceId: string, vaultId: string, seq: number): Promise<void> {
    await this.db.update(devices)
      .set({ cursorSeq: sql`greatest(${devices.cursorSeq}, least(${seq}, (select head_seq from vaults where id = ${vaultId})))`, lastAckAt: new Date(this.now()) })
      .where(eq(devices.id, deviceId));
  }
}
```

(Nota: `fileRecord` e le AAD usano `vaultId:id` come riga, perché gli ID dei file sono unici solo dentro il vault.)

- [ ] `apps/server/src/routes/sync.ts`: `POST /vaults/:vaultId/commits` (`CommitRequest`), `GET …/changes?after&limit` (limit 1–1000, default 500), `GET …/snapshot`, `POST …/ack` (`AckRequest`), `POST …/status` (`DeviceStatusReport` → aggiorna `pending_*`, `last_error_*`). Tutte con `deviceGuard`.

Commit insieme al Task 7.

---

### Task 7: Oracolo e percorso completo

**Files:** Create `apps/server/test/sync-oracle.test.ts`, `apps/server/test/sync-flow.test.ts`.

- [ ] Oracolo — stesso generatore di op di `packages/sync-core/src/store.test.ts` (path, ID e hash piccoli e in collisione); per ogni caso: un DB nuovo con un vault e un dispositivo, righe in `blobs` per gli hash del generatore (via `vc.blobId`), poi le stesse batch su `SyncService.commit` e su `MemoryStore.commit` (con `blobs` pieni). Confronto degli esiti normalizzando i `conflictId` per ordine di apparizione; confronto degli snapshot (path, versioni, hash, conflitti aperti) e di `head`. `numRuns: 25`, `timeout: 300_000`.
- [ ] Percorso completo: due dispositivi dello stesso utente sullo stesso vault; A carica e committa `a.md`; B legge `changes`, scarica il blob (contenuto uguale), modifica con base corretta → accettato; A modifica con base vecchia → `conflict`; `snapshot` di B mostra il conflitto aperto; `ack` di B porta il suo `cursor_seq` alla testa; un dispositivo di un altro utente non vede il vault (`404`).

Commit `feat(server): sync commits through the arbiter, journal, snapshot and ack`.

---

### Task 8: Rotte web dei vault

**Files:** Create `apps/server/src/routes/vaults.ts`, test in `apps/server/test/vaults-web.test.ts`; Modify `apps/web/src/mocks/browser.ts` (ibrida: `GET /vaults` e `/vaults/summary` al server).

- [ ] `GET /vaults` (sessione web) → `VaultList`: per ogni vault attivo dell'utente `{ id, name, fileCount, deviceCount, level, conflicts, usedBytes (somma delle dimensioni delle versioni correnti dei file vivi), historyBytes (somma delle altre versioni), trashBytes (versioni correnti dei file cancellati), retentionDays, maxRetentionDays: 90, historyFrom: createdAt }`, `quota: { usedBytes: somma, limitBytes: null }` (quote in M5). `GET /vaults/summary` → `{ vaults: [{ id, name, level, conflicts }] }`. Livello: conflitti aperti → `decision`; un dispositivo con `last_error_code` → `attention`; un dispositivo con `cursor_seq < head_seq` → `working`; altrimenti `safe`.
- [ ] Ibrida: in `browser.ts` escludere anche gli handler MSW di `GET */api/v1/vaults` e `GET */api/v1/vaults/summary` (filtrando per `info.method` e `info.path`).
- [ ] Test: le risposte passano gli schemi zod; un vault con un conflitto è `decision`; vault di altri utenti non compaiono.

Commit `feat(server): vault list and summary for the web app`.

---

### Task 9: Documenti e verifica

- [ ] `docs/self-hosting.md`: volume `/data`, `KAMINO_STORAGE` e variabili S3/MinIO, `KAMINO_MAX_FILE_BYTES`; `docs/05-data-model.md` §3–6 aggiornato alle colonne reali (chiavi composte, `path_mac`, `content_hash_enc`); `docs/03-sync-protocol.md` nota sulle rotte di iscrizione (C5) se diverse dal testo.
- [ ] HANDOVER: M1c completata sul branch, decisioni C1–C10, prossimo M1d (dopo gli spike) o M2.
- [ ] Changeset `"@kamino/server": minor`, `"@kamino/web": patch`.
- [ ] Verifica completa (build, typecheck, lint, test, format, Docker con volume), revisione finale (un subagente), PR.
