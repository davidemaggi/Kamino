# M1b — Crittografia e autenticazione web — piano di implementazione

> **For agentic workers:** standard del progetto (`CLAUDE.md`): superpowers:executing-plans nella sessione corrente, a blocchi. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** modulo crittografico completo (04 §5) e autenticazione web vera sul contratto `auth`/`account` (spec 4a §3), con R16 risolto.

**Architecture:** primitive pure in `apps/server/src/crypto/` e `apps/server/src/auth/` (testate senza DB); servizio `AuthService` su Drizzle; rotte Fastify sottili; sessione in cookie; web in modalità ibrida per lo sviluppo.

**Spec:** `docs/superpowers/specs/2026-11-09-m1b-crypto-auth-design.md` (decisioni B1–B8).

**Blocchi:** (A) Task 1 crypto; (B) Task 2–3 migrazioni/R16/schema e primitive di auth; (C) Task 4–6 servizio, rotte auth e account; (D) Task 7–8 CLI e web ibrida; (E) Task 9 documenti, verifica, revisione, PR.

## Global Constraints

- TypeScript strict; ESM (`.js` negli import); `node:crypto` per tutto tranne Argon2id (`@node-rs/argon2`).
- Costanti crittografiche fisse, mai da `@kamino/brand` (B4). Nome del cookie e valore anti-CSRF invece sì (`PRODUCT_SLUG`).
- Mai loggare token, password, segreti TOTP, codici di recupero, cookie (unica eccezione: il token di setup, una volta, all'avvio).
- Errori `{ error: { code, message, retryable } }` con codici del catalogo di `@kamino/protocol`.
- Test di integrazione con Postgres via testcontainers, saltati su Windows in CI (`dockerUnavailable`).
- `pnpm format:check` prima di ogni push.

## Review Focus

1. Formati crittografici: AAD corrette, nonce mai riusati con la stessa chiave, troncamento/riordino rilevati. → Task 1.
2. R16: nessuna migrazione applicativa con una chiave sbagliata. → Task 2.
3. Login: tempo costante per utenti inesistenti, anti-replay TOTP, codici di recupero monouso, sessioni revocate al cambio password, admin con TOTP obbligatorio. → Task 3–6.
4. CSRF e cookie (`HttpOnly`, `SameSite=Lax`, `Secure` con HTTPS). → Task 4.

---

### Task 1: Crittografia

**Files:** Create `apps/server/src/crypto/{kdf,aead,dek,field,mac,stream}.ts` e `apps/server/src/crypto/crypto.test.ts`.

- [ ] **Step 1: Test** — `apps/server/src/crypto/crypto.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { open, seal } from "./aead.js";
import { generateDek, systemKey, unwrapDek, vaultKeys, wrapDek } from "./dek.js";
import { decryptField, encryptField } from "./field.js";
import { hkdf, INFO } from "./kdf.js";
import { parseMasterKey } from "./keyring.js";
import { blobId, pathMac } from "./mac.js";
import { decryptBlob, decryptRange, encryptBlob, HEADER_BYTES, TAG_BYTES } from "./stream.js";

const kek = parseMasterKey(Buffer.alloc(32, 7).toString("base64"));
const key = Buffer.alloc(32, 9);
const ids = { vaultId: "v1", blobId: "b1" };

describe("crypto", () => {
  it("hkdf: fixed labels, distinct subkeys", () => {
    expect(hkdf(key, INFO.meta).toString("hex")).toMatchInlineSnapshot();
    const k = vaultKeys(key);
    expect(new Set([k.content, k.meta, k.pathmac, k.blobid].map((b) => b.toString("hex"))).size).toBe(4);
    expect(systemKey(kek).equals(hkdf(kek.key, INFO.system))).toBe(true);
  });

  it("aead: tampering and wrong AAD fail", () => {
    const s = seal(key, Buffer.from("hello"), Buffer.from("aad"));
    expect(open(key, s, Buffer.from("aad")).toString()).toBe("hello");
    expect(() => open(key, s, Buffer.from("other"))).toThrow();
    const t = Buffer.from(s);
    t[t.length - 1]! ^= 1;
    expect(() => open(key, t, Buffer.from("aad"))).toThrow();
  });

  it("DEK wrap is bound to vault and KEK", () => {
    const dek = generateDek();
    const w = wrapDek(kek, "vault-a", dek);
    expect(unwrapDek(kek, "vault-a", w).equals(dek)).toBe(true);
    expect(() => unwrapDek(kek, "vault-b", w)).toThrow();
    const other = parseMasterKey(Buffer.alloc(32, 8).toString("base64"));
    expect(() => unwrapDek(other, "vault-a", w)).toThrow();
  });

  it("fields are bound to table, column and row", () => {
    const ref = { table: "users", column: "totp_secret", rowId: "u1" };
    const s = encryptField(key, ref, "SECRET");
    expect(decryptField(key, ref, s).toString()).toBe("SECRET");
    expect(() => decryptField(key, { ...ref, rowId: "u2" }, s)).toThrow();
    expect(() => decryptField(key, { ...ref, column: "x" }, s)).toThrow();
    expect(encryptField(key, ref, "SECRET").equals(s)).toBe(false); // random nonce
  });

  it("deterministic MACs per key", () => {
    expect(pathMac(key, "a.md").equals(pathMac(key, "a.md"))).toBe(true);
    expect(pathMac(key, "a.md").equals(pathMac(Buffer.alloc(32, 1), "a.md"))).toBe(false);
    expect(blobId(key, "ab")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stream: fixed vector", () => {
    const blob = encryptBlob(Buffer.from("kamino"), key, ids, { segmentSize: 4, salt: Buffer.alloc(32, 1) });
    expect(blob.toString("hex")).toMatchInlineSnapshot();
  });

  it("stream: round trip and ranges for any size and segment size", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), fc.integer({ min: 1, max: 40 }), fc.nat(), fc.nat(), (data, seg, a, b) => {
        const content = Buffer.from(data);
        const blob = encryptBlob(content, key, ids, { segmentSize: seg });
        expect(decryptBlob(blob, key, ids).equals(content)).toBe(true);
        const offset = content.length === 0 ? 0 : a % content.length;
        const length = b % (content.length - offset + 1);
        expect(decryptRange(blob, key, ids, offset, length).equals(content.subarray(offset, offset + length))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("stream: any flipped byte, truncation, extension, reorder or wrong ids fail", () => {
    const content = Buffer.from("0123456789abcdefghij");
    const blob = encryptBlob(content, key, ids, { segmentSize: 6 });
    for (let i = 0; i < blob.length; i++) {
      const t = Buffer.from(blob);
      t[i]! ^= 0x80;
      expect(() => decryptBlob(t, key, ids), `byte ${i}`).toThrow();
    }
    const segLen = 6 + TAG_BYTES;
    expect(() => decryptBlob(blob.subarray(0, blob.length - 1), key, ids)).toThrow();
    expect(() => decryptBlob(blob.subarray(0, HEADER_BYTES + 3 * segLen), key, ids)).toThrow(); // last segment dropped
    expect(() => decryptBlob(Buffer.concat([blob, Buffer.alloc(1)]), key, ids)).toThrow();
    const swapped = Buffer.concat([
      blob.subarray(0, HEADER_BYTES),
      blob.subarray(HEADER_BYTES + segLen, HEADER_BYTES + 2 * segLen),
      blob.subarray(HEADER_BYTES, HEADER_BYTES + segLen),
      blob.subarray(HEADER_BYTES + 2 * segLen),
    ]);
    expect(() => decryptBlob(swapped, key, ids)).toThrow();
    expect(() => decryptBlob(blob, key, { ...ids, blobId: "b2" })).toThrow();
    expect(() => decryptBlob(blob, key, { ...ids, vaultId: "v2" })).toThrow();
  });
});
```

(I due `toMatchInlineSnapshot()` vuoti vengono riempiti da Vitest al primo run e poi committati: sono i vettori fissi di B3.)

- [ ] **Step 2: Implementazione**

`apps/server/src/crypto/kdf.ts`:

```ts
import { hkdfSync } from "node:crypto";

/** Fixed domain-separation labels (B4): never derived from @kamino/brand. */
export const INFO = {
  system: "kamino/v1/system",
  content: "kamino/v1/content",
  meta: "kamino/v1/meta",
  pathmac: "kamino/v1/pathmac",
  blobid: "kamino/v1/blobid",
  blob: "kamino/v1/blob",
} as const;

/** HKDF-SHA-256. */
export function hkdf(key: Uint8Array, info: string, salt: Uint8Array = new Uint8Array(0), length = 32): Buffer {
  return Buffer.from(hkdfSync("sha256", key, salt, info, length));
}
```

`apps/server/src/crypto/aead.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const FORMAT_V1 = 1;
const NONCE = 12;
const TAG = 16;

export class CryptoError extends Error {
  constructor(message = "decryption failed") {
    super(message);
    this.name = "CryptoError";
  }
}

/** AES-256-GCM with a random 96-bit nonce. Layout: version ‖ nonce ‖ ciphertext ‖ tag. */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  const nonce = randomBytes(NONCE);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([Buffer.from([FORMAT_V1]), nonce, ct, c.getAuthTag()]);
}

export function open(key: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Buffer {
  const b = Buffer.from(sealed);
  if (b.length < 1 + NONCE + TAG || b[0] !== FORMAT_V1) throw new CryptoError();
  try {
    const d = createDecipheriv("aes-256-gcm", key, b.subarray(1, 1 + NONCE));
    d.setAAD(aad);
    d.setAuthTag(b.subarray(b.length - TAG));
    return Buffer.concat([d.update(b.subarray(1 + NONCE, b.length - TAG)), d.final()]);
  } catch {
    throw new CryptoError();
  }
}

/** Unambiguous AAD from parts that never contain NUL. */
export function aadOf(...parts: string[]): Buffer {
  return Buffer.from(parts.join("\u0000"), "utf8");
}
```

`apps/server/src/crypto/dek.ts`:

```ts
import { randomBytes } from "node:crypto";
import { aadOf, open, seal } from "./aead.js";
import { hkdf, INFO } from "./kdf.js";
import type { Kek } from "./keyring.js";

export const DEK_BYTES = 32;

export interface VaultKeys {
  content: Buffer;
  meta: Buffer;
  pathmac: Buffer;
  blobid: Buffer;
}

export function generateDek(): Buffer {
  return randomBytes(DEK_BYTES);
}

/** 04 §5.1: AAD = vaultId ‖ kekId, so a wrapped DEK can't move to another vault or key. */
export function wrapDek(kek: Kek, vaultId: string, dek: Uint8Array): Buffer {
  return seal(kek.key, dek, aadOf(vaultId, kek.id));
}

export function unwrapDek(kek: Kek, vaultId: string, wrapped: Uint8Array): Buffer {
  return open(kek.key, wrapped, aadOf(vaultId, kek.id));
}

export function vaultKeys(dek: Uint8Array): VaultKeys {
  return {
    content: hkdf(dek, INFO.content),
    meta: hkdf(dek, INFO.meta),
    pathmac: hkdf(dek, INFO.pathmac),
    blobid: hkdf(dek, INFO.blobid),
  };
}

/** Key for system secrets (TOTP secrets, SMTP password). */
export function systemKey(kek: Kek): Buffer {
  return hkdf(kek.key, INFO.system);
}
```

`apps/server/src/crypto/field.ts`:

```ts
import { aadOf, open, seal } from "./aead.js";

/** Where an encrypted value lives: moving it to another row or column breaks decryption. */
export interface FieldRef {
  table: string;
  column: string;
  rowId: string;
}

export function encryptField(key: Uint8Array, ref: FieldRef, value: string | Uint8Array): Buffer {
  const plain = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return seal(key, plain, aadOf(ref.table, ref.column, ref.rowId));
}

export function decryptField(key: Uint8Array, ref: FieldRef, sealed: Uint8Array): Buffer {
  return open(key, sealed, aadOf(ref.table, ref.column, ref.rowId));
}
```

`apps/server/src/crypto/mac.ts`:

```ts
import { createHmac } from "node:crypto";

/** Unique-index key for a path inside one vault (04 §5.1). */
export function pathMac(key: Uint8Array, collisionKey: string): Buffer {
  return createHmac("sha256", key).update(collisionKey, "utf8").digest();
}

/** Blob id inside one vault: same content, same id (dedup); no correlation across vaults. */
export function blobId(key: Uint8Array, contentHash: string): string {
  return createHmac("sha256", key).update(contentHash, "utf8").digest("hex");
}
```

`apps/server/src/crypto/stream.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { aadOf, CryptoError, FORMAT_V1 } from "./aead.js";
import { hkdf, INFO } from "./kdf.js";

/** version (1) ‖ salt (32) ‖ segmentSize (4, big-endian). */
export const HEADER_BYTES = 37;
export const TAG_BYTES = 16;
export const DEFAULT_SEGMENT = 4 * 1024 * 1024;

export interface BlobIds {
  vaultId: string;
  blobId: string;
}

/** Nonce = segment counter (8 bytes BE) ‖ 3 zero bytes ‖ last-segment flag. */
function nonce(index: number, last: boolean): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(index), 0);
  n[11] = last ? 1 : 0;
  return n;
}

/** Per-blob key: a fresh salt per blob, so counters never repeat under one key. */
export function blobKey(contentKey: Uint8Array, salt: Uint8Array): Buffer {
  return hkdf(contentKey, INFO.blob, salt);
}

export function encryptSegment(key: Uint8Array, ids: BlobIds, index: number, last: boolean, data: Uint8Array): Buffer {
  const c = createCipheriv("aes-256-gcm", key, nonce(index, last));
  c.setAAD(aadOf(ids.vaultId, ids.blobId));
  return Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
}

function decryptSegment(key: Uint8Array, ids: BlobIds, index: number, last: boolean, sealed: Uint8Array): Buffer {
  const b = Buffer.from(sealed);
  if (b.length < TAG_BYTES) throw new CryptoError();
  try {
    const d = createDecipheriv("aes-256-gcm", key, nonce(index, last));
    d.setAAD(aadOf(ids.vaultId, ids.blobId));
    d.setAuthTag(b.subarray(b.length - TAG_BYTES));
    return Buffer.concat([d.update(b.subarray(0, b.length - TAG_BYTES)), d.final()]);
  } catch {
    throw new CryptoError();
  }
}

export function header(salt: Uint8Array, segmentSize: number): Buffer {
  const h = Buffer.alloc(HEADER_BYTES);
  h[0] = FORMAT_V1;
  Buffer.from(salt).copy(h, 1);
  h.writeUInt32BE(segmentSize, 33);
  return h;
}

/** Segmented AEAD (STREAM) of a whole buffer; M1c encrypts upload chunks with encryptSegment. */
export function encryptBlob(
  content: Uint8Array,
  contentKey: Uint8Array,
  ids: BlobIds,
  opts: { segmentSize?: number; salt?: Uint8Array } = {},
): Buffer {
  const segmentSize = opts.segmentSize ?? DEFAULT_SEGMENT;
  const salt = opts.salt ?? randomBytes(32);
  const key = blobKey(contentKey, salt);
  const count = Math.max(1, Math.ceil(content.length / segmentSize));
  const parts = [header(salt, segmentSize)];
  for (let i = 0; i < count; i++)
    parts.push(encryptSegment(key, ids, i, i === count - 1, content.subarray(i * segmentSize, (i + 1) * segmentSize)));
  return Buffer.concat(parts);
}

interface Layout {
  key: Buffer;
  segmentSize: number;
  count: number;
  /** Byte length of the plaintext. */
  size: number;
}

function layout(blob: Uint8Array, contentKey: Uint8Array): Layout {
  const b = Buffer.from(blob);
  if (b.length < HEADER_BYTES + TAG_BYTES || b[0] !== FORMAT_V1) throw new CryptoError();
  const segmentSize = b.readUInt32BE(33);
  if (segmentSize === 0) throw new CryptoError();
  const body = b.length - HEADER_BYTES;
  const full = segmentSize + TAG_BYTES;
  const count = Math.max(1, Math.ceil(body / full));
  const lastLen = body - (count - 1) * full;
  if (lastLen < TAG_BYTES || lastLen > full) throw new CryptoError();
  return { key: blobKey(contentKey, b.subarray(1, 33)), segmentSize, count, size: (count - 1) * segmentSize + lastLen - TAG_BYTES };
}

function segmentAt(blob: Uint8Array, l: Layout, ids: BlobIds, i: number): Buffer {
  const full = l.segmentSize + TAG_BYTES;
  const start = HEADER_BYTES + i * full;
  const end = i === l.count - 1 ? blob.length : start + full;
  return decryptSegment(l.key, ids, i, i === l.count - 1, blob.subarray(start, end));
}

/** Whole-blob decryption: detects truncation, extension, reordering and tampering. */
export function decryptBlob(blob: Uint8Array, contentKey: Uint8Array, ids: BlobIds): Buffer {
  const l = layout(blob, contentKey);
  const parts: Buffer[] = [];
  for (let i = 0; i < l.count; i++) parts.push(segmentAt(blob, l, ids, i));
  return Buffer.concat(parts);
}

/** HTTP Range support: decrypts (and authenticates) only the segments covering the range. */
export function decryptRange(blob: Uint8Array, contentKey: Uint8Array, ids: BlobIds, offset: number, length: number): Buffer {
  const l = layout(blob, contentKey);
  if (offset < 0 || length < 0 || offset + length > l.size) throw new CryptoError("range out of bounds");
  if (length === 0) return Buffer.alloc(0);
  const first = Math.floor(offset / l.segmentSize);
  const last = Math.floor((offset + length - 1) / l.segmentSize);
  const parts: Buffer[] = [];
  for (let i = first; i <= last; i++) parts.push(segmentAt(blob, l, ids, i));
  const joined = Buffer.concat(parts);
  const from = offset - first * l.segmentSize;
  return joined.subarray(from, from + length);
}
```

- [ ] **Step 3:** `pnpm --filter @kamino/server exec vitest run src/crypto` (i vettori inline vengono scritti al primo run: controllarli e committarli); typecheck; lint. Aggiungere `fast-check` alle devDependencies del server. Commit `feat(server): add the encryption module (DEK, fields, MACs, segmented AEAD)`.

---

### Task 2: Migrazioni, R16 e schema

**Files:** Modify `apps/server/src/db/migrate.ts`, `apps/server/src/db/schema.ts`, `apps/server/src/main.ts`, `apps/server/test/migrations-guard.test.ts` (→ test di ordine), `docs/05-data-model.md`; Create la migrazione con `pnpm --filter @kamino/server db:generate` (nome generato da drizzle-kit).

- [ ] **Step 1: Schema** — aggiungere a `apps/server/src/db/schema.ts`:

```ts
import { sql } from "drizzle-orm";
import { bigint, customType, index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const role = pgEnum("role", ["user", "admin"]);
/** `invited`: created by an invitation, no password yet. */
export const userStatus = pgEnum("user_status", ["invited", "active", "blocked", "pending_deletion", "deleted"]);
export const theme = pgEnum("theme", ["light", "dark", "system"]);
export const tokenKind = pgEnum("token_kind", ["invite", "activation", "password_reset", "setup", "export_download", "email_change"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  username: text("username").notNull(),
  /** NFC + case-folded: uniqueness without the citext extension. */
  usernameKey: text("username_key").notNull().unique(),
  email: text("email").notNull(),
  emailKey: text("email_key").notNull().unique(),
  passwordHash: text("password_hash"),
  role: role("role").notNull().default("user"),
  status: userStatus("status").notNull().default("active"),
  locale: text("locale").notNull().default("it"),
  theme: theme("theme").notNull().default("system"),
  /** Encrypted with k_system, AAD users ‖ totp_secret ‖ id. Set at setup, enabled at confirm. */
  totpSecret: bytea("totp_secret"),
  totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
  totpLastStep: bigint("totp_last_step", { mode: "number" }),
  /** U-09: a reset started by an admin, shown to the user until the password changes. */
  adminResetAt: timestamp("admin_reset_at", { withTimezone: true }),
  deletionScheduledAt: timestamp("deletion_scheduled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const recoveryCodes = pgTable("recovery_codes", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

export const webSessions = pgTable(
  "web_sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("web_sessions_user").on(t.userId)],
);

export const securityEvents = pgTable(
  "security_events",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    ip: text("ip"),
    client: text("client"),
    seenAt: timestamp("seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("security_events_user").on(t.userId, t.createdAt)],
);

export const oneTimeTokens = pgTable("one_time_tokens", {
  id: uuid("id").primaryKey(),
  kind: tokenKind("kind").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  email: text("email"),
  payload: jsonb("payload"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdBy: text("created_by"),
});

/** 04 §9: append-only, never contents or paths. */
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
});
```

(`bytea` esiste già nel file; l'import di `customType` resta.) Poi `pnpm --filter @kamino/server db:generate` → nuova migrazione `0001_*.sql`.

- [ ] **Step 2: R16** — `apps/server/src/db/migrate.ts` diventa:

```ts
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./client.js";

export const MIGRATION_LOCK_ID = 7_243_650_066n;

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

interface Journal {
  entries: Array<{ idx: number; tag: string; when: number }>;
  [k: string]: unknown;
}

/** A copy of the migrations folder with only the first migration (key_check). */
function bootstrapFolder(): string {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as Journal;
  const first = journal.entries[0];
  if (!first) throw new Error("no migrations");
  const dir = mkdtempSync(join(tmpdir(), "kamino-migrations-"));
  mkdirSync(join(dir, "meta"));
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: [first] }));
  copyFileSync(join(migrationsFolder, `${first.tag}.sql`), join(dir, `${first.tag}.sql`));
  return dir;
}

/**
 * R16: the key_check migration runs first, then `verify` (master key check), then every other
 * migration, all under one advisory lock. A wrong key stops before any application table exists.
 * The original error is never masked by a failing unlock.
 */
export async function runMigrations(db: Db, verify: () => Promise<void> = async () => undefined): Promise<void> {
  const conn = await db.$client.reserve();
  let failed = false;
  try {
    await conn`select pg_advisory_lock(${MIGRATION_LOCK_ID.toString()}::bigint)`;
    const bootstrap = bootstrapFolder();
    try {
      await migrate(db, { migrationsFolder: bootstrap });
    } finally {
      rmSync(bootstrap, { recursive: true, force: true });
    }
    await verify();
    await migrate(db, { migrationsFolder });
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    try {
      await conn`select pg_advisory_unlock(${MIGRATION_LOCK_ID.toString()}::bigint)`;
    } catch (unlockError) {
      if (!failed) throw unlockError;
    } finally {
      conn.release();
    }
  }
}
```

In `main.ts`: sostituire `await runMigrations(db); try { … ensureKeyCheck … }` con:

```ts
  try {
    await runMigrations(db, async () => {
      const result = await ensureKeyCheck(db, kek);
      logger.info({ kekId: kek.id, result }, "master key verified");
    });
  } catch (e) {
    if (e instanceof MasterKeyError) {
      logger.error(e.message);
      await db.$client.end({ timeout: 5 });
      process.exit(1);
    }
    throw e;
  }
```

e togliere il TODO. Il comando CLI `migrate` passa la stessa verifica (`verifyKeyCheck` se la tabella esiste già, altrimenti `ensureKeyCheck`): usare `ensureKeyCheck`, come il server.

- [ ] **Step 3: Test** — `apps/server/test/migrations-guard.test.ts` diventa `apps/server/test/migrations-order.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureKeyCheck } from "../src/crypto/key-check.js";
import { MasterKeyError, parseMasterKey } from "../src/crypto/keyring.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";

const keyA = parseMasterKey(Buffer.alloc(32, 1).toString("base64"));
const keyB = parseMasterKey(Buffer.alloc(32, 2).toString("base64"));

describe.skipIf(dockerUnavailable)("migrations order (R16)", () => {
  let pg: TestPostgres;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => pg?.stop());

  async function tables(db: ReturnType<typeof createDb>): Promise<string[]> {
    const rows = await db.$client<{ table_name: string }[]>`select table_name from information_schema.tables where table_schema = 'public'`;
    return rows.map((r) => r.table_name).sort();
  }

  it("verify runs after key_check exists and before application tables", async () => {
    const db = createDb(await pg.createDatabase("order_ok"));
    let seen: string[] = [];
    await runMigrations(db, async () => {
      seen = await tables(db);
      await ensureKeyCheck(db, keyA);
    });
    expect(seen).toEqual(["key_check"]);
    expect(await tables(db)).toContain("users");
    await db.$client.end();
  });

  it("a wrong key stops before any application migration", async () => {
    const db = createDb(await pg.createDatabase("order_wrong"));
    await runMigrations(db, async () => {
      await ensureKeyCheck(db, keyA);
    });
    const fresh = createDb(await pg.createDatabase("order_wrong2"));
    await runMigrations(fresh, async () => {
      await ensureKeyCheck(fresh, keyA);
    });
    // Simulate a database initialised with key A that is started with key B: drop users to see it is not recreated.
    await fresh.$client`drop table users cascade`;
    await expect(runMigrations(fresh, async () => {
      await ensureKeyCheck(fresh, keyB);
    })).rejects.toBeInstanceOf(MasterKeyError);
    expect(await tables(fresh)).not.toContain("users");
    await db.$client.end();
    await fresh.$client.end();
  });
});
```

(Il secondo caso verifica l'ordine con un DB in cui le tabelle applicative mancano: con la chiave sbagliata `migrate` non arriva a ricrearle. Se drizzle registra la migrazione 0001 come già applicata e non la riesegue, sostituire `drop table users` con un DB nuovo inizializzato *solo* con la migrazione 0000 e la key check di A, e verificare che con B `users` non compaia.)

Aggiornare `docs/05-data-model.md` §1: colonne `username_key`, `email_key`, stato `invited`, `admin_reset_at`. Run test/typecheck/lint del server; commit `feat(server): R16 migration order and the auth schema`.

---

### Task 3: Primitive di autenticazione

**Files:** Create `apps/server/src/auth/{password,common-passwords,totp,tokens,client-info,rate-limit}.ts` e `apps/server/src/auth/primitives.test.ts`; Modify `apps/server/package.json` (`@node-rs/argon2`, `@fastify/cookie`).

- [ ] **Step 1: Lista delle password comuni** — scaricare `https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials/10k-most-common.txt` (licenza MIT) e generare `apps/server/src/auth/common-passwords.ts`:

```ts
// The 10,000 most common passwords, from SecLists (MIT, https://github.com/danielmiessler/SecLists).
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(
  `123456
password
…`.split("\n"),
);
```

(Generato con uno script una tantum; il file è grande ma statico. Le voci sono in minuscolo.)

- [ ] **Step 2: Test** — `apps/server/src/auth/primitives.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describeClient, ipPrefix } from "./client-info.js";
import { hashPassword, isWeakPassword, verifyPassword } from "./password.js";
import { RateLimiter } from "./rate-limit.js";
import { hashToken, randomToken, uuidv7 } from "./tokens.js";
import { base32Decode, base32Encode, hotp, otpauthUrl, verifyTotp, totpCode } from "./totp.js";

describe("password", () => {
  it("argon2id round trip; unknown user still costs a verification", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(h, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(h, "wrong")).toBe(false);
    expect(await verifyPassword(null, "anything")).toBe(false);
  });
  it("weak: too short or common", () => {
    expect(isWeakPassword("short")).toBe(true);
    expect(isWeakPassword("password1234")).toBe(true);
    expect(isWeakPassword("Qp7#vT2!mZx9")).toBe(false);
  });
});

describe("totp (RFC 6238 appendix B, SHA-1)", () => {
  const key = Buffer.from("12345678901234567890");
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ])("t=%i", (t, code) => {
    expect(hotp(key, Math.floor(t / 30), 8)).toBe(code);
  });
  it("window ±1 and anti-replay", () => {
    const secret = base32Encode(key);
    expect(base32Decode(secret).equals(key)).toBe(true);
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(secret, totpCode(secret, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 2), now, null)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step), now, step)).toBeNull();
    expect(otpauthUrl("Kamino", "demo", secret)).toContain(`secret=${secret}`);
  });
});

describe("tokens and client info", () => {
  it("tokens are 256-bit, hashed with SHA-256", () => {
    const t = randomToken();
    expect(Buffer.from(t, "base64url")).toHaveLength(32);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("client and IP are described, never stored raw in responses", () => {
    expect(describeClient("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Gecko/20100101 Firefox/131.0")).toBe("Firefox · macOS");
    expect(describeClient("obsidian/1.7 Android")).toBe("Obsidian · Android");
    expect(describeClient(undefined)).toBe("?");
    expect(ipPrefix("192.168.1.42")).toBe("192.168.1.x");
    expect(ipPrefix("2001:db8:85a3::8a2e:370:7334")).toBe("2001:db8:85a3:x");
    expect(ipPrefix("::ffff:10.0.0.5")).toBe("10.0.0.x");
  });
  it("rate limiter: fixed window per bucket and key", () => {
    let now = 0;
    const rl = new RateLimiter({ login: { max: 2, windowMs: 1000 } }, () => now);
    expect(rl.hit("login", "a").ok).toBe(true);
    expect(rl.hit("login", "a").ok).toBe(true);
    expect(rl.hit("login", "a")).toEqual({ ok: false, retryAfterSec: 1 });
    expect(rl.hit("login", "b").ok).toBe(true);
    now = 1000;
    expect(rl.hit("login", "a").ok).toBe(true);
  });
});
```

- [ ] **Step 3: Implementazione**

`apps/server/src/auth/password.ts`:

```ts
import { hash, verify } from "@node-rs/argon2";
import { PASSWORD_MIN } from "@kamino/protocol";
import { COMMON_PASSWORDS } from "./common-passwords.js";

/** Argon2id, OWASP minimum (B2). 2 = Algorithm.Argon2id (a const enum, not usable with isolatedModules). */
const OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

let dummy: Promise<string> | undefined;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/** Constant work: an unknown user (null hash) is checked against a dummy hash. */
export async function verifyPassword(hashed: string | null, password: string): Promise<boolean> {
  const target = hashed ?? (await (dummy ??= hash("kamino-dummy-password", OPTIONS)));
  const ok = await verify(target, password).catch(() => false);
  return hashed !== null && ok;
}

export function isWeakPassword(password: string): boolean {
  return password.length < PASSWORD_MIN || COMMON_PASSWORDS.has(password.toLowerCase());
}
```

`apps/server/src/auth/totp.ts`:

```ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_MS = 30_000;

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP with SHA-1. */
export function hotp(key: Uint8Array, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return bin.toString().padStart(digits, "0");
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, step: number): string {
  return hotp(base32Decode(secret), step);
}

/** Accepts steps −1..+1 newer than `lastStep` (anti-replay). Returns the matched step. */
export function verifyTotp(secret: string, code: string, nowMs: number, lastStep: number | null): number | null {
  const step = Math.floor(nowMs / STEP_MS);
  const given = Buffer.from(code.padEnd(6, " "));
  for (const s of [step - 1, step, step + 1]) {
    if (lastStep !== null && s <= lastStep) continue;
    const expected = Buffer.from(totpCode(secret, s));
    if (given.length === expected.length && timingSafeEqual(given, expected)) return s;
  }
  return null;
}

export function otpauthUrl(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
```

`apps/server/src/auth/tokens.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";

/** 256-bit random token, URL-safe. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Tokens are long random values: SHA-256 is enough to store them. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** UUIDv7: time-ordered ids (05: UUIDv7 primary keys). */
export function uuidv7(now = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Recovery codes: "XXXX-XXXX" from an unambiguous alphabet. */
export function recoveryCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const chars = [...bytes].map((x) => alphabet[x % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}
```

`apps/server/src/auth/client-info.ts`:

```ts
/** "Firefox · macOS": what the user sees about a session (never the raw user agent). */
export function describeClient(ua: string | undefined): string {
  if (!ua) return "?";
  const app = /obsidian/i.test(ua)
    ? "Obsidian"
    : /edg\//i.test(ua)
      ? "Edge"
      : /firefox\//i.test(ua)
        ? "Firefox"
        : /chrome\//i.test(ua)
          ? "Chrome"
          : /safari\//i.test(ua)
            ? "Safari"
            : "Browser";
  const os = /iphone|ipad/i.test(ua)
    ? "iOS"
    : /android/i.test(ua)
      ? "Android"
      : /mac os x|macintosh/i.test(ua)
        ? "macOS"
        : /windows/i.test(ua)
          ? "Windows"
          : /linux/i.test(ua)
            ? "Linux"
            : "?";
  return `${app} · ${os}`;
}

/** Truncated address: "192.168.1.x", "2001:db8:85a3:x". */
export function ipPrefix(ip: string | undefined): string {
  if (!ip) return "?";
  const v4 = /(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.x`;
  const groups = ip.split(":").filter(Boolean);
  return `${groups.slice(0, 3).join(":")}:x`;
}
```

`apps/server/src/auth/rate-limit.ts`:

```ts
export interface Limit {
  max: number;
  windowMs: number;
}

/** In-memory fixed windows (single instance, 04 §8). */
export class RateLimiter<B extends string> {
  private readonly hits = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limits: Record<B, Limit>,
    private readonly now: () => number = Date.now,
  ) {}

  hit(bucket: B, key: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const { max, windowMs } = this.limits[bucket];
    const id = `${bucket}\u0000${key}`;
    const t = this.now();
    const cur = this.hits.get(id);
    if (!cur || t - cur.start >= windowMs) {
      this.hits.set(id, { start: t, count: 1 });
      return { ok: true };
    }
    if (cur.count >= max) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((cur.start + windowMs - t) / 1000)) };
    cur.count++;
    return { ok: true };
  }
}
```

Run test/typecheck/lint; commit `feat(server): add password, TOTP, token and rate-limit primitives`.

---

### Task 4: Servizio di autenticazione e integrazione nell'app

**Files:** Create `apps/server/src/auth/service.ts`, `apps/server/src/auth/http.ts` (cookie, CSRF, utente corrente, errori); Modify `apps/server/src/app.ts` (dipendenze `kek`, registrazione), `apps/server/src/main.ts` (token di setup all'avvio).

**Produces:** `class AuthService` con i metodi usati dalle rotte; `registerAuthHttp(app, service, config)`; decorator `request.auth` = `{ user, sessionId } | null`; helper `fail(reply, status, code, retryAfter?)`.

- [ ] **Step 1: Servizio** — `apps/server/src/auth/service.ts`:

```ts
import type { Me, SecurityEventType, SessionInfo } from "@kamino/protocol";
import { and, count, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { systemKey } from "../crypto/dek.js";
import { decryptField, encryptField } from "../crypto/field.js";
import type { Kek } from "../crypto/keyring.js";
import type { Db } from "../db/client.js";
import { auditLog, oneTimeTokens, recoveryCodes, securityEvents, users, webSessions } from "../db/schema.js";
import { describeClient, ipPrefix } from "./client-info.js";
import { hashPassword, isWeakPassword, verifyPassword } from "./password.js";
import { hashToken, randomToken, recoveryCode, uuidv7 } from "./tokens.js";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "./totp.js";

export type User = typeof users.$inferSelect;
export interface Ctx {
  ip: string | undefined;
  userAgent: string | undefined;
}
export class AuthError extends Error {
  constructor(readonly code: "invalid_credentials" | "user_blocked" | "totp_invalid" | "challenge_expired" | "setup_not_needed" | "setup_token_invalid" | "token_invalid" | "token_expired" | "password_weak" | "password_wrong" | "totp_mandatory" | "not_found" | "forbidden", readonly status: number) {
    super(code);
  }
}

const DAY = 86_400_000;
export const SESSION_IDLE_MS = 14 * DAY;
export const SESSION_ABSOLUTE_MS = 90 * DAY;
const CHALLENGE_MS = 5 * 60_000;
const TTL: Record<"password_reset" | "invite" | "activation", number> = { password_reset: 3_600_000, invite: 7 * DAY, activation: 7 * DAY };

/** Uniqueness keys for usernames and emails (no citext). */
export const keyOf = (s: string) => s.trim().normalize("NFC").toLowerCase();

export class AuthService {
  private readonly totpKey: Buffer;
  private readonly challenges = new Map<string, { userId: string; expiresAt: number }>();

  constructor(
    private readonly db: Db,
    kek: Kek,
    private readonly issuer: string,
    private readonly now: () => number = Date.now,
  ) {
    this.totpKey = systemKey(kek);
  }

  // ---------- users ----------

  async userCount(): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(users);
    return row?.n ?? 0;
  }

  async byId(id: string): Promise<User | undefined> {
    return (await this.db.select().from(users).where(eq(users.id, id)))[0];
  }

  async byUsername(username: string): Promise<User | undefined> {
    return (await this.db.select().from(users).where(eq(users.usernameKey, keyOf(username))))[0];
  }

  me(u: User): Me {
    return {
      id: u.id,
      username: u.username,
      email: u.email,
      role: u.role,
      lang: u.locale === "en" ? "en" : "it",
      theme: u.theme,
      totpEnabled: u.totpEnabledAt !== null,
      totpSetupRequired: u.role === "admin" && u.totpEnabledAt === null,
      adminResetAt: u.adminResetAt?.toISOString() ?? null,
    };
  }

  private async event(userId: string, type: SecurityEventType, ctx?: Ctx): Promise<void> {
    await this.db.insert(securityEvents).values({ id: uuidv7(), userId, type, ip: ctx?.ip ?? null, client: ctx ? describeClient(ctx.userAgent) : null });
  }

  async audit(actor: string, action: string, target: string | null): Promise<void> {
    await this.db.insert(auditLog).values({ id: uuidv7(), actor, action, target });
  }

  // ---------- one-time tokens ----------

  async createToken(kind: (typeof oneTimeTokens.$inferInsert)["kind"], opts: { userId?: string; email?: string; ttlMs: number; createdBy?: string }): Promise<string> {
    const token = randomToken();
    await this.db.insert(oneTimeTokens).values({
      id: uuidv7(), kind, tokenHash: hashToken(token), userId: opts.userId ?? null, email: opts.email ?? null,
      expiresAt: new Date(this.now() + opts.ttlMs), createdBy: opts.createdBy ?? null,
    });
    return token;
  }

  private async findToken(kind: (typeof oneTimeTokens.$inferInsert)["kind"], token: string) {
    const row = (await this.db.select().from(oneTimeTokens).where(and(eq(oneTimeTokens.tokenHash, hashToken(token)), eq(oneTimeTokens.kind, kind))))[0];
    if (!row || row.usedAt) throw new AuthError("token_invalid", 400);
    if (row.expiresAt.getTime() <= this.now()) throw new AuthError("token_expired", 400);
    return row;
  }

  // ---------- setup ----------

  /** Called at startup: when there are no users, a fresh setup token to print once in the logs. */
  async ensureSetupToken(): Promise<string | null> {
    if ((await this.userCount()) > 0) return null;
    await this.db.delete(oneTimeTokens).where(eq(oneTimeTokens.kind, "setup"));
    return this.createToken("setup", { ttlMs: 365 * DAY });
  }

  async setup(input: { token: string; username: string; email: string; password: string }, ctx: Ctx): Promise<User> {
    if ((await this.userCount()) > 0) throw new AuthError("setup_not_needed", 409);
    const row = await this.findToken("setup", input.token).catch(() => {
      throw new AuthError("setup_token_invalid", 403);
    });
    if (isWeakPassword(input.password)) throw new AuthError("password_weak", 400);
    const user = await this.insertUser({ username: input.username, email: input.email, role: "admin", status: "active", passwordHash: await hashPassword(input.password) });
    await this.db.update(oneTimeTokens).set({ usedAt: new Date(this.now()) }).where(eq(oneTimeTokens.id, row.id));
    await this.audit(user.username, "setup", user.username);
    await this.event(user.id, "login", ctx);
    return user;
  }

  async insertUser(v: { username: string; email: string; role: "user" | "admin"; status: User["status"]; passwordHash: string | null }): Promise<User> {
    const [u] = await this.db.insert(users).values({ id: uuidv7(), ...v, usernameKey: keyOf(v.username), emailKey: keyOf(v.email) }).returning();
    return u!;
  }

  // ---------- login ----------

  async login(username: string, password: string, ctx: Ctx): Promise<{ status: "ok"; user: User } | { status: "totp_required"; challengeId: string }> {
    const u = await this.byUsername(username);
    const ok = await verifyPassword(u?.passwordHash ?? null, password);
    if (!u || !ok) {
      if (u) await this.event(u.id, "login_failed", ctx);
      throw new AuthError("invalid_credentials", 401);
    }
    if (u.status !== "active") throw new AuthError("user_blocked", 403);
    if (u.totpEnabledAt) {
      const challengeId = randomToken();
      this.challenges.set(challengeId, { userId: u.id, expiresAt: this.now() + CHALLENGE_MS });
      return { status: "totp_required", challengeId };
    }
    await this.event(u.id, "login", ctx);
    return { status: "ok", user: u };
  }

  /** TOTP code or a recovery code (consumed). The challenge is single-use. */
  async loginTotp(challengeId: string, code: string, ctx: Ctx): Promise<User> {
    const ch = this.challenges.get(challengeId);
    if (!ch || ch.expiresAt <= this.now()) throw new AuthError("challenge_expired", 401);
    const u = await this.byId(ch.userId);
    if (!u || u.status !== "active") throw new AuthError("user_blocked", 403);
    if (!(await this.checkSecondFactor(u, code))) {
      await this.event(u.id, "login_failed", ctx);
      throw new AuthError("totp_invalid", 401);
    }
    this.challenges.delete(challengeId);
    await this.event(u.id, "login", ctx);
    return u;
  }

  private async checkSecondFactor(u: User, code: string): Promise<boolean> {
    const trimmed = code.trim();
    if (/^\d{6}$/.test(trimmed) && u.totpSecret) {
      const secret = decryptField(this.totpKey, { table: "users", column: "totp_secret", rowId: u.id }, u.totpSecret).toString();
      const step = verifyTotp(secret, trimmed, this.now(), u.totpLastStep);
      if (step === null) return false;
      await this.db.update(users).set({ totpLastStep: step }).where(eq(users.id, u.id));
      return true;
    }
    const codes = await this.db.select().from(recoveryCodes).where(and(eq(recoveryCodes.userId, u.id), isNull(recoveryCodes.usedAt)));
    for (const rc of codes) {
      if (await verifyPassword(rc.codeHash, trimmed.toUpperCase())) {
        await this.db.update(recoveryCodes).set({ usedAt: new Date(this.now()) }).where(eq(recoveryCodes.id, rc.id));
        return true;
      }
    }
    return false;
  }

  // ---------- sessions ----------

  async createSession(userId: string, ctx: Ctx): Promise<string> {
    const token = randomToken();
    await this.db.insert(webSessions).values({
      id: uuidv7(), userId, tokenHash: hashToken(token), expiresAt: new Date(this.now() + SESSION_ABSOLUTE_MS),
      ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null,
    });
    return token;
  }

  /** Valid session → its user; idle (14 d), absolute (90 d) or revoked → null. */
  async resolveSession(token: string): Promise<{ user: User; sessionId: string } | null> {
    const row = (await this.db.select().from(webSessions).where(eq(webSessions.tokenHash, hashToken(token))))[0];
    const t = this.now();
    if (!row || row.revokedAt || row.expiresAt.getTime() <= t || row.lastSeenAt.getTime() + SESSION_IDLE_MS <= t) return null;
    const user = await this.byId(row.userId);
    if (!user || user.status !== "active") return null;
    if (t - row.lastSeenAt.getTime() > 60_000) await this.db.update(webSessions).set({ lastSeenAt: new Date(t) }).where(eq(webSessions.id, row.id));
    return { user, sessionId: row.id };
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    await this.db.update(webSessions).set({ revokedAt: new Date(this.now()) }).where(and(eq(webSessions.id, sessionId), eq(webSessions.userId, userId)));
  }

  async revokeOtherSessions(userId: string, keep: string | null): Promise<void> {
    const cond = keep ? and(eq(webSessions.userId, userId), ne(webSessions.id, keep), isNull(webSessions.revokedAt)) : and(eq(webSessions.userId, userId), isNull(webSessions.revokedAt));
    await this.db.update(webSessions).set({ revokedAt: new Date(this.now()) }).where(cond);
  }

  async listSessions(userId: string, current: string): Promise<SessionInfo[]> {
    const t = new Date(this.now());
    const rows = await this.db.select().from(webSessions)
      .where(and(eq(webSessions.userId, userId), isNull(webSessions.revokedAt), gt(webSessions.expiresAt, t)))
      .orderBy(desc(webSessions.lastSeenAt));
    return rows
      .filter((r) => r.lastSeenAt.getTime() + SESSION_IDLE_MS > t.getTime())
      .map((r) => ({ id: r.id, current: r.id === current, client: describeClient(r.userAgent ?? undefined), ipPrefix: ipPrefix(r.ip ?? undefined), lastUsedAt: r.lastSeenAt.toISOString() }));
  }

  // ---------- account ----------

  async updateProfile(u: User, patch: { email?: string; lang?: "it" | "en"; theme?: "light" | "dark" | "system" }): Promise<User> {
    const set: Partial<typeof users.$inferInsert> = { updatedAt: new Date(this.now()) };
    if (patch.email !== undefined) Object.assign(set, { email: patch.email, emailKey: keyOf(patch.email) });
    if (patch.lang !== undefined) set.locale = patch.lang;
    if (patch.theme !== undefined) set.theme = patch.theme;
    const [row] = await this.db.update(users).set(set).where(eq(users.id, u.id)).returning();
    return row!;
  }

  /** Revokes every other session and clears the admin-reset notice (04 §8). */
  async changePassword(u: User, current: string, next: string, sessionId: string, ctx: Ctx): Promise<void> {
    if (!(await verifyPassword(u.passwordHash, current))) throw new AuthError("password_wrong", 400);
    if (isWeakPassword(next)) throw new AuthError("password_weak", 400);
    await this.db.update(users).set({ passwordHash: await hashPassword(next), adminResetAt: null, updatedAt: new Date(this.now()) }).where(eq(users.id, u.id));
    await this.revokeOtherSessions(u.id, sessionId);
    await this.event(u.id, "password_changed", ctx);
  }

  async totpSetup(u: User): Promise<{ secret: string; otpauthUrl: string }> {
    const secret = generateTotpSecret();
    const sealed = encryptField(this.totpKey, { table: "users", column: "totp_secret", rowId: u.id }, secret);
    // Pending until confirmed: an enabled TOTP is never replaced here.
    if (u.totpEnabledAt) throw new AuthError("forbidden", 409);
    await this.db.update(users).set({ totpSecret: sealed }).where(eq(users.id, u.id));
    return { secret, otpauthUrl: otpauthUrl(this.issuer, u.username, secret) };
  }

  async totpConfirm(u: User, code: string, ctx: Ctx): Promise<string[]> {
    if (!u.totpSecret || u.totpEnabledAt) throw new AuthError("totp_invalid", 400);
    const secret = decryptField(this.totpKey, { table: "users", column: "totp_secret", rowId: u.id }, u.totpSecret).toString();
    const step = verifyTotp(secret, code, this.now(), null);
    if (step === null) throw new AuthError("totp_invalid", 400);
    await this.db.update(users).set({ totpEnabledAt: new Date(this.now()), totpLastStep: step }).where(eq(users.id, u.id));
    await this.event(u.id, "totp_enabled", ctx);
    return this.newRecoveryCodes(u.id);
  }

  async totpDisable(u: User, password: string, ctx: Ctx): Promise<void> {
    if (u.role === "admin") throw new AuthError("totp_mandatory", 403);
    if (!(await verifyPassword(u.passwordHash, password))) throw new AuthError("password_wrong", 400);
    await this.db.update(users).set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null }).where(eq(users.id, u.id));
    await this.db.delete(recoveryCodes).where(eq(recoveryCodes.userId, u.id));
    await this.event(u.id, "totp_disabled", ctx);
  }

  async regenerateRecoveryCodes(u: User, password: string): Promise<string[]> {
    if (!(await verifyPassword(u.passwordHash, password))) throw new AuthError("password_wrong", 400);
    if (!u.totpEnabledAt) throw new AuthError("forbidden", 409);
    return this.newRecoveryCodes(u.id);
  }

  private async newRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: 10 }, recoveryCode);
    await this.db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    const hashed = await Promise.all(codes.map((c) => hashPassword(c)));
    await this.db.insert(recoveryCodes).values(hashed.map((codeHash) => ({ id: uuidv7(), userId, codeHash })));
    return codes;
  }

  async securityLog(userId: string, page: number): Promise<{ items: { id: string; type: SecurityEventType; at: string; client?: string }[]; page: number; pages: number }> {
    const [row] = await this.db.select({ n: count() }).from(securityEvents).where(eq(securityEvents.userId, userId));
    const pages = Math.max(1, Math.ceil((row?.n ?? 0) / 20));
    const p = Math.min(pages, Math.max(1, page));
    const rows = await this.db.select().from(securityEvents).where(eq(securityEvents.userId, userId)).orderBy(desc(securityEvents.createdAt), desc(securityEvents.id)).limit(20).offset((p - 1) * 20);
    return { items: rows.map((r) => ({ id: r.id, type: r.type as SecurityEventType, at: r.createdAt.toISOString(), ...(r.client ? { client: r.client } : {}) })), page: p, pages };
  }

  // ---------- reset and invitations ----------

  async resetLink(username: string, by: string): Promise<string> {
    const u = await this.byUsername(username);
    if (!u) throw new AuthError("not_found", 404);
    const token = await this.createToken("password_reset", { userId: u.id, ttlMs: TTL.password_reset, createdBy: by });
    await this.db.update(users).set({ adminResetAt: new Date(this.now()) }).where(eq(users.id, u.id));
    await this.event(u.id, "admin_reset");
    await this.audit(by, "reset_link_created", u.username);
    return token;
  }

  async resetPassword(token: string, password: string, ctx: Ctx): Promise<User> {
    const row = await this.findToken("password_reset", token);
    if (isWeakPassword(password)) throw new AuthError("password_weak", 400);
    const u = row.userId ? await this.byId(row.userId) : undefined;
    if (!u) throw new AuthError("token_invalid", 400);
    await this.db.update(users).set({ passwordHash: await hashPassword(password), adminResetAt: null }).where(eq(users.id, u.id));
    await this.db.update(oneTimeTokens).set({ usedAt: new Date(this.now()) }).where(eq(oneTimeTokens.id, row.id));
    await this.revokeOtherSessions(u.id, null);
    await this.event(u.id, "password_changed", ctx);
    return u;
  }

  async invite(username: string, email: string, by: string): Promise<string> {
    const u = await this.insertUser({ username, email, role: "user", status: "invited", passwordHash: null });
    await this.audit(by, "user_invited", username);
    return this.createToken("invite", { userId: u.id, email, ttlMs: TTL.invite, createdBy: by });
  }

  async inviteInfo(token: string): Promise<{ username: string; email: string }> {
    const row = await this.findToken("invite", token);
    const u = row.userId ? await this.byId(row.userId) : undefined;
    if (!u) throw new AuthError("token_invalid", 400);
    return { username: u.username, email: u.email };
  }

  async acceptInvite(token: string, password: string, ctx: Ctx): Promise<User> {
    const row = await this.findToken("invite", token);
    if (isWeakPassword(password)) throw new AuthError("password_weak", 400);
    const [u] = await this.db.update(users).set({ passwordHash: await hashPassword(password), status: "active" })
      .where(and(eq(users.id, row.userId ?? ""), eq(users.status, "invited"))).returning();
    if (!u) throw new AuthError("token_invalid", 400);
    await this.db.update(oneTimeTokens).set({ usedAt: new Date(this.now()) }).where(eq(oneTimeTokens.id, row.id));
    await this.event(u.id, "login", ctx);
    return u;
  }

  async resetTotp(username: string, by: string): Promise<void> {
    const u = await this.byUsername(username);
    if (!u) throw new AuthError("not_found", 404);
    await this.db.update(users).set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null }).where(eq(users.id, u.id));
    await this.db.delete(recoveryCodes).where(eq(recoveryCodes.userId, u.id));
    await this.event(u.id, "totp_disabled");
    await this.audit(by, "totp_reset", u.username);
  }

  /** Test hook: the number of pending challenges never grows unbounded. */
  pruneChallenges(): void {
    const t = this.now();
    for (const [id, ch] of this.challenges) if (ch.expiresAt <= t) this.challenges.delete(id);
  }
}

void sql;
```

(L'ultima riga si toglie se `sql` non serve; tenerla solo se il lint non segnala import inutilizzati.)

- [ ] **Step 2: HTTP** — `apps/server/src/auth/http.ts`:

```ts
import cookie from "@fastify/cookie";
import { PRODUCT_SLUG } from "@kamino/brand";
import type { ErrorCode } from "@kamino/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AuthError, SESSION_ABSOLUTE_MS, type AuthService, type Ctx, type User } from "./service.js";

export const SESSION_COOKIE = `${PRODUCT_SLUG}_session`;
export const CSRF_VALUE = `${PRODUCT_SLUG}-web`;
const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

declare module "fastify" {
  interface FastifyRequest {
    auth: { user: User; sessionId: string } | null;
  }
}

export function fail(reply: FastifyReply, status: number, code: ErrorCode, retryAfterSec?: number): FastifyReply {
  if (retryAfterSec !== undefined) void reply.header("retry-after", String(retryAfterSec));
  return reply.code(status).send({ error: { code, message: code, retryable: status === 429 || status >= 500 } });
}

export const ctxOf = (req: FastifyRequest): Ctx => ({ ip: req.ip, userAgent: req.headers["user-agent"] });

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  void reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: SESSION_ABSOLUTE_MS / 1000 });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  void reply.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure, path: "/" });
}

/** Cookie parsing, CSRF on writes (B8), current user on every API request, AuthError → error body. */
export async function registerAuthHttp(app: FastifyInstance, service: AuthService): Promise<void> {
  await app.register(cookie);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    if (WRITE.has(req.method) && req.headers["x-requested-with"] !== CSRF_VALUE) return fail(reply, 403, "forbidden");
    const token = req.cookies[SESSION_COOKIE];
    req.auth = token ? await service.resolveSession(token) : null;
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError) return fail(reply, err.status, err.code);
    app.log.error({ err: { name: err.name, code: (err as { code?: unknown }).code } }, "request failed");
    return fail(reply, 500, "internal");
  });
}

/** Route guard: the signed-in user, or a 401 already sent. */
export function requireUser(req: FastifyRequest, reply: FastifyReply): { user: User; sessionId: string } | null {
  if (!req.auth) {
    void fail(reply, 401, "unauthorized");
    return null;
  }
  return req.auth;
}
```

- [ ] **Step 3: App e avvio** — `AppDeps` aggiunge `kek: Kek` e `auth?: AuthService` (per i test); `buildApp` diventa `async` e:

```ts
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app = Fastify({ loggerInstance, trustProxy: true });
  const auth = deps.auth ?? new AuthService(deps.db, deps.kek, PRODUCT_NAME);
  await registerAuthHttp(app, auth);
  const secure = deps.config.publicUrl.startsWith("https:");
  await app.register(authRoutes(auth, secure), { prefix: "/api/v1" });
  await app.register(accountRoutes(auth, secure), { prefix: "/api/v1" });
  healthRoutes(app, deps.db);
  versionRoutes(app, deps.buildInfo);
  webRoutes(app, deps.webRoot);
  return app;
}
```

In `main.ts`, dopo la verifica della chiave e prima di `listen`:

```ts
  const auth = new AuthService(db, kek, PRODUCT_NAME);
  const setupToken = await auth.ensureSetupToken();
  // 04 §8: the only token ever logged, once, while the server has no users.
  if (setupToken) logger.warn(`no users yet: finish the setup at ${config.publicUrl}/setup?token=${setupToken}`);
  const app = await buildApp({ config, db, logger, buildInfo, kek, auth, webRoot: resolveWebRoot() });
```

Aggiornare i test esistenti che chiamano `buildApp` (`await`, `kek`). Run typecheck/lint; commit insieme al Task 5.

---

### Task 5: Rotte di autenticazione

**Files:** Create `apps/server/src/routes/auth.ts`, `apps/server/test/auth.test.ts`, `apps/server/test/helpers/app.ts`.

- [ ] **Step 1: Helper di test** — `apps/server/test/helpers/app.ts`:

```ts
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { pino } from "pino";
import { buildApp } from "../../src/app.js";
import { AuthService } from "../../src/auth/service.js";
import { CSRF_VALUE, SESSION_COOKIE } from "../../src/auth/http.js";
import { buildInfo } from "../../src/build-info.js";
import { ensureKeyCheck } from "../../src/crypto/key-check.js";
import { parseMasterKey } from "../../src/crypto/keyring.js";
import { createDb, type Db } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";

export const kek = parseMasterKey(Buffer.alloc(32, 3).toString("base64"));

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  auth: AuthService;
  clock: { now: number };
  /** JSON request with CSRF header and the cookie jar of `agent`. */
  call(agent: Agent, method: string, url: string, body?: unknown): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}
export type Agent = { cookie?: string };

export async function testApp(url: string): Promise<TestApp> {
  const db = createDb(url);
  await runMigrations(db, async () => {
    await ensureKeyCheck(db, kek);
  });
  const clock = { now: Date.UTC(2026, 10, 9, 12) };
  const auth = new AuthService(db, kek, "Kamino", () => clock.now);
  const app = await buildApp({
    config: { publicUrl: "http://localhost:8080", port: 0, databaseUrl: url, masterKey: "", logLevel: "error" },
    db, logger: pino({ level: "silent" }), buildInfo, kek, auth,
  });
  return {
    app, db, auth, clock,
    async call(agent, method, path, body) {
      const res = await app.inject({
        method: method as "GET",
        url: `/api/v1${path}`,
        headers: { "x-requested-with": CSRF_VALUE, ...(agent.cookie ? { cookie: agent.cookie } : {}), "user-agent": "Mozilla/5.0 (Macintosh) Firefox/131.0" },
        ...(body !== undefined ? { payload: body as object } : {}),
      });
      const set = res.cookies.find((c) => c.name === SESSION_COOKIE);
      if (set) agent.cookie = set.value ? `${SESSION_COOKIE}=${set.value}` : undefined;
      return res;
    },
    async close() {
      await app.close();
      await db.$client.end();
    },
  };
}
```

- [ ] **Step 2: Test** — `apps/server/test/auth.test.ts`:

```ts
import { LoginResponse, Me, SetupStatus } from "@kamino/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { totpCode } from "../src/auth/totp.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { testApp, type Agent, type TestApp } from "./helpers/app.js";

const PW = "Qp7#vT2!mZx9-long";

describe.skipIf(dockerUnavailable)("auth routes", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let n = 0;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => pg?.stop());
  beforeEach(async () => {
    await t?.close();
    t = await testApp(await pg.createDatabase(`auth_${++n}`));
  });

  async function setupAdmin(agent: Agent) {
    const token = await t.auth.ensureSetupToken();
    return t.call(agent, "POST", "/setup", { token, username: "admin", email: "admin@example.com", password: PW });
  }

  it("setup once, with the token; the admin must configure TOTP", async () => {
    const a: Agent = {};
    expect(SetupStatus.parse((await t.call(a, "GET", "/setup/status")).json())).toEqual({ needed: true });
    expect((await t.call(a, "POST", "/setup", { token: "wrong", username: "x", email: "x@example.com", password: PW })).json().error.code).toBe("setup_token_invalid");
    const res = await setupAdmin(a);
    expect(res.statusCode).toBe(200);
    expect(Me.parse(res.json())).toMatchObject({ role: "admin", totpSetupRequired: true });
    expect(res.cookies.find((c) => c.name.endsWith("_session"))).toMatchObject({ httpOnly: true, sameSite: "Lax" });
    expect((await t.call(a, "GET", "/me")).statusCode).toBe(200);
    expect((await setupAdmin({})).json().error.code).toBe("setup_not_needed");
  });

  it("writes need the CSRF header", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "a", password: "b" } });
    expect(res.statusCode).toBe(403);
  });

  it("login: wrong password, success, logout", async () => {
    await setupAdmin({});
    const a: Agent = {};
    expect((await t.call(a, "POST", "/auth/login", { username: "admin", password: "nope" })).json().error.code).toBe("invalid_credentials");
    expect((await t.call(a, "POST", "/auth/login", { username: "ghost", password: "nope" })).json().error.code).toBe("invalid_credentials");
    const ok = LoginResponse.parse((await t.call(a, "POST", "/auth/login", { username: "ADMIN", password: PW })).json());
    expect(ok.status).toBe("ok");
    expect((await t.call(a, "POST", "/auth/logout")).statusCode).toBe(204);
    expect((await t.call(a, "GET", "/me")).statusCode).toBe(401);
  });

  it("TOTP: setup, confirm, login with a code (no replay) and with a recovery code (single use)", async () => {
    const a: Agent = {};
    await setupAdmin(a);
    const { secret } = (await t.call(a, "POST", "/account/totp/setup")).json() as { secret: string };
    const step = Math.floor(t.clock.now / 30_000);
    const { recoveryCodes } = (await t.call(a, "POST", "/account/totp/confirm", { code: totpCode(secret, step) })).json() as { recoveryCodes: string[] };
    expect(recoveryCodes).toHaveLength(10);
    const b: Agent = {};
    const ch = LoginResponse.parse((await t.call(b, "POST", "/auth/login", { username: "admin", password: PW })).json());
    if (ch.status !== "totp_required") throw new Error("expected totp");
    expect((await t.call(b, "POST", "/auth/totp", { challengeId: ch.challengeId, code: totpCode(secret, step) })).json().error.code).toBe("totp_invalid"); // replay
    t.clock.now += 30_000;
    expect((await t.call(b, "POST", "/auth/totp", { challengeId: ch.challengeId, code: totpCode(secret, step + 1) })).statusCode).toBe(200);
    const c: Agent = {};
    const ch2 = LoginResponse.parse((await t.call(c, "POST", "/auth/login", { username: "admin", password: PW })).json());
    if (ch2.status !== "totp_required") throw new Error("expected totp");
    expect((await t.call(c, "POST", "/auth/totp", { challengeId: ch2.challengeId, code: recoveryCodes[0] })).statusCode).toBe(200);
    const ch3 = LoginResponse.parse((await t.call({}, "POST", "/auth/login", { username: "admin", password: PW })).json());
    if (ch3.status !== "totp_required") throw new Error("expected totp");
    expect((await t.call({}, "POST", "/auth/totp", { challengeId: ch3.challengeId, code: recoveryCodes[0] })).json().error.code).toBe("totp_invalid");
  });

  it("blocked users and expired sessions", async () => {
    const a: Agent = {};
    await setupAdmin(a);
    t.clock.now += 15 * 86_400_000; // idle > 14 days
    expect((await t.call(a, "GET", "/me")).statusCode).toBe(401);
    await t.db.$client`update users set status = 'blocked'`;
    expect((await t.call({}, "POST", "/auth/login", { username: "admin", password: PW })).json().error.code).toBe("user_blocked");
  });

  it("reset and invitations (tokens from the CLI service)", async () => {
    await setupAdmin({});
    const reset = await t.auth.resetLink("admin", "cli");
    expect((await t.call({}, "POST", "/auth/reset", { token: reset, password: "short" })).statusCode).toBe(400);
    expect((await t.call({}, "POST", "/auth/reset", { token: reset, password: `${PW}-new` })).statusCode).toBe(204);
    expect((await t.call({}, "POST", "/auth/reset", { token: reset, password: `${PW}-new` })).json().error.code).toBe("token_invalid");
    const invite = await t.auth.invite("mario", "mario@example.com", "cli");
    expect((await t.call({}, "GET", `/invites/${invite}`)).json()).toEqual({ username: "mario", email: "mario@example.com" });
    const a: Agent = {};
    expect(Me.parse((await t.call(a, "POST", `/invites/${invite}/accept`, { password: PW })).json()).username).toBe("mario");
    expect((await t.call({}, "POST", "/auth/forgot", { email: "mario@example.com" })).json()).toEqual({ smtp: false });
  });

  it("rate limit on login", async () => {
    await setupAdmin({});
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await t.call({}, "POST", "/auth/login", { username: "admin", password: "nope" })).statusCode;
    expect(last).toBe(429);
  });
});
```

- [ ] **Step 3: Rotte** — `apps/server/src/routes/auth.ts`:

```ts
import { ForgotRequest, InviteAccept, LoginRequest, ResetRequest, SetupRequest, TotpLoginRequest } from "@kamino/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { clearSessionCookie, ctxOf, fail, setSessionCookie } from "../auth/http.js";
import { RateLimiter } from "../auth/rate-limit.js";
import type { AuthService, User } from "../auth/service.js";

type Bucket = "login" | "totp" | "setup" | "reset" | "forgot" | "invite";

/** Validates a body with the contract schema; weak passwords get their own code. */
export function parse<T>(schema: z.ZodType<T>, req: FastifyRequest, reply: FastifyReply): T | null {
  const r = schema.safeParse(req.body);
  if (r.success) return r.data;
  const weak = r.error.issues.some((i) => i.path.includes("password") || i.path.includes("next"));
  void fail(reply, 400, weak ? "password_weak" : "internal");
  return null;
}

export function authRoutes(auth: AuthService, secure: boolean) {
  const limiter = new RateLimiter<Bucket>({
    login: { max: 10, windowMs: 15 * 60_000 },
    totp: { max: 10, windowMs: 15 * 60_000 },
    setup: { max: 10, windowMs: 15 * 60_000 },
    reset: { max: 10, windowMs: 15 * 60_000 },
    forgot: { max: 5, windowMs: 15 * 60_000 },
    invite: { max: 20, windowMs: 15 * 60_000 },
  });
  const limited = (bucket: Bucket, req: FastifyRequest, reply: FastifyReply): boolean => {
    const r = limiter.hit(bucket, req.ip);
    if (r.ok) return false;
    void fail(reply, 429, "rate_limited", r.retryAfterSec);
    return true;
  };
  const signIn = async (user: User, req: FastifyRequest, reply: FastifyReply) => {
    setSessionCookie(reply, await auth.createSession(user.id, ctxOf(req)), secure);
    return auth.me(user);
  };

  return async (app: FastifyInstance) => {
    app.get("/setup/status", async () => ({ needed: (await auth.userCount()) === 0 }));
    app.post("/setup", async (req, reply) => {
      if (limited("setup", req, reply)) return reply;
      const b = parse(SetupRequest, req, reply);
      if (!b) return reply;
      return signIn(await auth.setup(b, ctxOf(req)), req, reply);
    });
    app.post("/auth/login", async (req, reply) => {
      if (limited("login", req, reply)) return reply;
      const b = parse(LoginRequest, req, reply);
      if (!b) return reply;
      const r = await auth.login(b.username, b.password, ctxOf(req));
      if (r.status === "totp_required") return r;
      return { status: "ok", me: await signIn(r.user, req, reply) };
    });
    app.post("/auth/totp", async (req, reply) => {
      if (limited("totp", req, reply)) return reply;
      const b = parse(TotpLoginRequest, req, reply);
      if (!b) return reply;
      return signIn(await auth.loginTotp(b.challengeId, b.code, ctxOf(req)), req, reply);
    });
    app.post("/auth/logout", async (req, reply) => {
      if (req.auth) await auth.revokeSession(req.auth.user.id, req.auth.sessionId);
      clearSessionCookie(reply, secure);
      return reply.code(204).send();
    });
    app.get("/me", async (req, reply) => (req.auth ? auth.me(req.auth.user) : fail(reply, 401, "unauthorized")));
    app.post("/auth/forgot", async (req, reply) => {
      if (limited("forgot", req, reply)) return reply;
      if (!parse(ForgotRequest, req, reply)) return reply;
      return { smtp: false }; // B5: email arrives with M5; same answer whether the email exists or not
    });
    app.post("/auth/reset", async (req, reply) => {
      if (limited("reset", req, reply)) return reply;
      const b = parse(ResetRequest, req, reply);
      if (!b) return reply;
      await auth.resetPassword(b.token, b.password, ctxOf(req));
      return reply.code(204).send();
    });
    app.get<{ Params: { token: string } }>("/invites/:token", async (req, reply) => {
      if (limited("invite", req, reply)) return reply;
      return auth.inviteInfo(req.params.token);
    });
    app.post<{ Params: { token: string } }>("/invites/:token/accept", async (req, reply) => {
      if (limited("invite", req, reply)) return reply;
      const b = parse(InviteAccept, req, reply);
      if (!b) return reply;
      return signIn(await auth.acceptInvite(req.params.token, b.password, ctxOf(req)), req, reply);
    });
  };
}
```

Run test/typecheck/lint; commit `feat(server): real web authentication (setup, login, TOTP, sessions, reset, invitations)`.

---

### Task 6: Rotte dell'account

**Files:** Create `apps/server/src/routes/account.ts`, `apps/server/test/account.test.ts`.

- [ ] **Step 1: Test** — `apps/server/test/account.test.ts`:

```ts
import { SecurityLogPage, SessionList } from "@kamino/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { testApp, type Agent, type TestApp } from "./helpers/app.js";

const PW = "Qp7#vT2!mZx9-long";

describe.skipIf(dockerUnavailable)("account routes", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let n = 0;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => pg?.stop());
  beforeEach(async () => {
    await t?.close();
    t = await testApp(await pg.createDatabase(`account_${++n}`));
    const token = await t.auth.ensureSetupToken();
    await t.call({}, "POST", "/setup", { token, username: "admin", email: "admin@example.com", password: PW });
    const invite = await t.auth.invite("demo", "demo@example.com", "cli");
    await t.call({}, "POST", `/invites/${invite}/accept`, { password: PW });
  });

  const login = async () => {
    const a: Agent = {};
    await t.call(a, "POST", "/auth/login", { username: "demo", password: PW });
    return a;
  };

  it("needs a session", async () => {
    expect((await t.call({}, "GET", "/account/sessions")).statusCode).toBe(401);
  });

  it("profile", async () => {
    const a = await login();
    const me = (await t.call(a, "PATCH", "/account/profile", { lang: "en", theme: "dark" })).json();
    expect(me).toMatchObject({ lang: "en", theme: "dark" });
  });

  it("password change revokes the other sessions", async () => {
    const a = await login();
    const b = await login();
    expect((await t.call(a, "POST", "/account/password", { current: "nope", next: `${PW}-2` })).json().error.code).toBe("password_wrong");
    expect((await t.call(a, "POST", "/account/password", { current: PW, next: "password1234" })).json().error.code).toBe("password_weak");
    expect((await t.call(a, "POST", "/account/password", { current: PW, next: `${PW}-2` })).statusCode).toBe(204);
    expect((await t.call(a, "GET", "/me")).statusCode).toBe(200);
    expect((await t.call(b, "GET", "/me")).statusCode).toBe(401);
  });

  it("sessions: list with the current one, revoke one, revoke the others", async () => {
    const a = await login();
    await login();
    const list = SessionList.parse((await t.call(a, "GET", "/account/sessions")).json());
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list[0]!.client).toBe("Firefox · macOS");
    const other = list.find((s) => !s.current)!;
    expect((await t.call(a, "DELETE", `/account/sessions/${other.id}`)).statusCode).toBe(204);
    expect(SessionList.parse((await t.call(a, "GET", "/account/sessions")).json())).toHaveLength(1);
    await login();
    expect((await t.call(a, "DELETE", "/account/sessions")).statusCode).toBe(204);
    expect(SessionList.parse((await t.call(a, "GET", "/account/sessions")).json())).toHaveLength(1);
  });

  it("admins can't disable TOTP; users can, with their password", async () => {
    const admin: Agent = {};
    await t.call(admin, "POST", "/auth/login", { username: "admin", password: PW });
    expect((await t.call(admin, "POST", "/account/totp/disable", { password: PW })).json().error.code).toBe("totp_mandatory");
  });

  it("security log is paginated and uses the contract", async () => {
    const a = await login();
    for (let i = 0; i < 25; i++) await t.call({}, "POST", "/auth/login", { username: "demo", password: "nope" });
    const page = SecurityLogPage.parse((await t.call(a, "GET", "/account/security-log?page=1")).json());
    expect(page.items).toHaveLength(20);
    expect(page.pages).toBeGreaterThan(1);
  });
});
```

(Il rate limit del login scatta prima dei 25 tentativi: nel test usare un `AuthService` con limiti alti oppure inserire direttamente gli eventi. Scelta: inserire 25 righe in `security_events` con SQL nel test, al posto del ciclo di login.)

- [ ] **Step 2: Rotte** — `apps/server/src/routes/account.ts`:

```ts
import { PasswordChange, PasswordConfirm, ProfilePatch, TotpConfirm } from "@kamino/protocol";
import type { FastifyInstance } from "fastify";
import { ctxOf, requireUser } from "../auth/http.js";
import type { AuthService } from "../auth/service.js";
import { parse } from "./auth.js";

export function accountRoutes(auth: AuthService, _secure: boolean) {
  return async (app: FastifyInstance) => {
    app.patch("/account/profile", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const b = parse(ProfilePatch, req, reply);
      if (!b) return reply;
      return auth.me(await auth.updateProfile(s.user, b));
    });
    app.post("/account/password", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const b = parse(PasswordChange, req, reply);
      if (!b) return reply;
      await auth.changePassword(s.user, b.current, b.next, s.sessionId, ctxOf(req));
      return reply.code(204).send();
    });
    app.post("/account/totp/setup", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      return auth.totpSetup(s.user);
    });
    app.post("/account/totp/confirm", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const b = parse(TotpConfirm, req, reply);
      if (!b) return reply;
      return { recoveryCodes: await auth.totpConfirm(s.user, b.code, ctxOf(req)) };
    });
    app.post("/account/totp/disable", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const b = parse(PasswordConfirm, req, reply);
      if (!b) return reply;
      await auth.totpDisable(s.user, b.password, ctxOf(req));
      return reply.code(204).send();
    });
    app.post("/account/totp/recovery-codes", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      const b = parse(PasswordConfirm, req, reply);
      if (!b) return reply;
      return { recoveryCodes: await auth.regenerateRecoveryCodes(s.user, b.password) };
    });
    app.get("/account/sessions", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      return auth.listSessions(s.user.id, s.sessionId);
    });
    app.delete<{ Params: { id: string } }>("/account/sessions/:id", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      await auth.revokeSession(s.user.id, req.params.id);
      return reply.code(204).send();
    });
    app.delete("/account/sessions", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      await auth.revokeOtherSessions(s.user.id, s.sessionId);
      return reply.code(204).send();
    });
    app.get<{ Querystring: { page?: string } }>("/account/security-log", async (req, reply) => {
      const s = requireUser(req, reply);
      if (!s) return reply;
      return auth.securityLog(s.user.id, Number(req.query.page) || 1);
    });
  };
}
```

Run test/typecheck/lint; commit `feat(server): account routes (profile, password, TOTP, sessions, security log)`.

---

### Task 7: CLI

**Files:** Create `apps/server/src/cli/commands/users.ts`; Modify `apps/server/src/cli/index.ts`; Test `apps/server/test/cli-users.test.ts`.

- [ ] `apps/server/src/cli/commands/users.ts`:

```ts
import { PRODUCT_NAME } from "@kamino/brand";
import { AuthError, AuthService } from "../../auth/service.js";
import { createDb } from "../../db/client.js";
import type { Command } from "../io.js";
import { loadConfigAndKek } from "./load.js";

async function withAuth(env: Parameters<Command>[1], io: Parameters<Command>[2], fn: (auth: AuthService, publicUrl: string) => Promise<void>): Promise<number> {
  const loaded = loadConfigAndKek(env, io);
  if (!loaded) return 1;
  const db = createDb(loaded.config.databaseUrl);
  try {
    await fn(new AuthService(db, loaded.kek, PRODUCT_NAME), loaded.config.publicUrl);
    return 0;
  } catch (e) {
    io.stderr(e instanceof AuthError ? `${e.code}\n` : "command failed\n");
    return 1;
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

/** `users reset-link <username>`: prints a one-hour password reset link. */
export const usersResetLink: Command = (args, env, io) => {
  const [username] = args;
  if (!username) {
    io.stderr("usage: users reset-link <username>\n");
    return Promise.resolve(2);
  }
  return withAuth(env, io, async (auth, url) => {
    io.stdout(`${url}/reset/${await auth.resetLink(username, "cli")}\n`);
  });
};

/** `users invite <username> <email>`: creates the user and prints a 7-day activation link. */
export const usersInvite: Command = (args, env, io) => {
  const [username, email] = args;
  if (!username || !email) {
    io.stderr("usage: users invite <username> <email>\n");
    return Promise.resolve(2);
  }
  return withAuth(env, io, async (auth, url) => {
    io.stdout(`${url}/invite/${await auth.invite(username, email, "cli")}\n`);
  });
};

/** `users reset-2fa <username>`: removes TOTP (an admin locked out); logged in audit and security log. */
export const usersReset2fa: Command = (args, env, io) => {
  const [username] = args;
  if (!username) {
    io.stderr("usage: users reset-2fa <username>\n");
    return Promise.resolve(2);
  }
  return withAuth(env, io, async (auth) => {
    await auth.resetTotp(username, "cli");
    io.stdout("two-step verification removed\n");
  });
};
```

Registrare in `commands` come `"users reset-link"`, `"users invite"`, `"users reset-2fa"`. Test di integrazione: con un DB migrato, `main(["users","invite","mario","m@example.com"], env, io)` stampa un link `/invite/…` valido per `auth.inviteInfo`; `reset-link` su utente inesistente → exit 1 con `not_found`. Commit `feat(server): CLI to create reset and invitation links and to reset 2FA`.

---

### Task 8: Web in modalità ibrida

**Files:** Modify `apps/web/src/mocks/browser.ts`, `apps/web/src/mocks/handlers.ts` (export separati), `apps/web/.env.example` (nuovo), `docs/ui/design-system.md` §9 (comandi).

- [ ] `handlers.ts` esporta `authHandlers` (oggi locali) oltre a `handlers`. In `browser.ts`:

```ts
/** B6: "hybrid" sends auth/account to the real server (Vite proxy), everything else to MSW. */
const hybrid = import.meta.env["VITE_KAMINO_API"] === "hybrid";
const worker = setupWorker(...(hybrid ? handlers.filter((h) => !authHandlers.includes(h)) : handlers));
```

e il `DevPanel` mostra "Server vero: login e account" in modalità ibrida (testo i18n `dev.hybrid`). `.env.example`: `# VITE_KAMINO_API=hybrid  # login/account on the real server (needs pnpm --filter @kamino/server dev)`. Test: il test di build verifica già che MSW non sia nel bundle di produzione. Commit `feat(web): hybrid dev mode with the real server for auth and account`.

---

### Task 9: Documenti e verifica

- [ ] `docs/04-security-threat-model.md` §8: parametri effettivi (Argon2id 19 MiB/2/1, TOTP ±1 con anti-replay, cookie, CSRF, scadenze, rate limit); `docs/05-data-model.md` già aggiornato al Task 2; `docs/self-hosting.md`: primo avvio (link di setup nei log) e comandi `users …`; `CLAUDE.md`: nuovi comandi CLI e modalità ibrida.
- [ ] HANDOVER: M1b completata sul branch, decisioni B1–B8, R16 chiuso, prossimo M1c.
- [ ] Changeset `.changeset/m1b-crypto-auth.md` (`"@kamino/server": minor`, `"@kamino/web": minor`).
- [ ] Verifica completa (build, typecheck, lint, test, format, release-names, Docker: primo avvio con link di setup, login dalla web app), push, CI, revisione finale (un subagente), PR.
