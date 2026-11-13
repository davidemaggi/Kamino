import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import type { Sql as PgSql, TransactionSql } from "postgres";
import yauzl from "yauzl";
import { ZipFile } from "yazl";
import { PRODUCT_SLUG } from "@kamino/brand";
import { keksOf, MasterKeyError, type Keyring } from "../crypto/keyring.js";
import type { BlobStore } from "../blobs/store.js";
import type { Db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";

/**
 * M7b B2–B4 (04 §7): a backup is a ZIP with
 * - `db/<table>.copy`: each application table as `COPY … (FORMAT binary)`, all from one snapshot;
 * - `blobs/<key>`: the storage objects, already encrypted, byte for byte;
 * - `manifest.json`: format, migration version, ids of the master keys it needs, counts.
 * The master key is never in it. Restoring needs the same server version and the same key.
 */
export const BACKUP_FORMAT = 1;
const MANIFEST = "manifest.json";

export type Manifest = {
  format: number;
  product: string;
  createdAt: string;
  migrations: { count: number; last: string };
  /** Active key checks: the master key(s) the backup can be read with. */
  kekIds: string[];
  tables: { name: string; rows: number }[];
  /** Objects referenced by the database but absent from the storage when the backup ran. */
  missingBlobs: string[];
  blobs: number;
};

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

type Sql = PgSql | TransactionSql;
type Tx = Sql;

/**
 * yazl's lazy stream callback from a promise of a stream. Failures (opening or mid-stream) go to
 * `onError`: yazl would otherwise leave the output open forever.
 */
function lazyWith(onError: (e: unknown) => void) {
  return (open: () => Promise<Readable>) =>
    (cb: (err: unknown, s: NodeJS.ReadableStream) => void) => {
      open().then((s) => {
        s.on("error", onError);
        cb(null, s);
      }, onError);
    };
}

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Application tables, parents before children (foreign keys), so a restore can insert in order. */
async function tablesInOrder(sql: Sql | Tx): Promise<string[]> {
  const tables = (
    await sql<{ name: string }[]>`
      select tablename as name from pg_tables where schemaname = 'public' order by tablename`
  ).map((r) => r.name);
  const edges = await sql<{ child: string; parent: string }[]>`
    select ch.relname as child, pa.relname as parent
    from pg_constraint c
    join pg_class ch on ch.oid = c.conrelid
    join pg_class pa on pa.oid = c.confrelid
    join pg_namespace n on n.oid = ch.relnamespace
    where c.contype = 'f' and n.nspname = 'public' and ch.relname <> pa.relname`;
  const out: string[] = [];
  const left = new Set(tables);
  while (left.size > 0) {
    const ready = [...left].filter((t) => !edges.some((e) => e.child === t && left.has(e.parent)));
    if (ready.length === 0) throw new BackupError("circular foreign keys between tables");
    for (const t of ready) {
      out.push(t);
      left.delete(t);
    }
  }
  return out;
}

async function migrationState(sql: Sql | Tx): Promise<Manifest["migrations"]> {
  const rows = await sql<{ hash: string }[]>`
    select hash from drizzle.__drizzle_migrations order by created_at, id`;
  return { count: rows.length, last: rows[rows.length - 1]?.hash ?? "" };
}

/** Storage keys the database refers to, with their stored size. */
async function objectsOf(sql: Sql | Tx): Promise<{ key: string; size: number }[]> {
  const blobs = await sql<{ key: string; size: string }[]>`
    select vault_id::text || '/' || blob_id as key, stored_size as size from blobs order by 1`;
  // F6 deletion exports: object key = nil-UUID prefix + export id without dashes.
  const exports = await sql<{ key: string; size: string }[]>`
    select '00000000-0000-0000-0000-000000000000/' || replace(id::text, '-', '') as key,
      stored_size as size
    from user_exports where ready_at is not null and stored_size is not null order by 1`;
  return [...blobs, ...exports].map((r) => ({ key: r.key, size: Number(r.size) }));
}

/**
 * Writes the backup to `file` (via a temporary name, mode 0600). Runs while the server is up:
 * the tables come from one repeatable-read snapshot; an object the GC removes meanwhile was
 * unreferenced, and is listed in `missingBlobs`.
 */
export async function createBackup(db: Db, store: BlobStore, file: string): Promise<Manifest> {
  const partial = `${file}.partial`;
  try {
    const manifest = await db.$client.begin(
      "isolation level repeatable read read only",
      async (tx) => {
        const tables = await tablesInOrder(tx);
        const m: Manifest = {
          format: BACKUP_FORMAT,
          product: PRODUCT_SLUG,
          createdAt: new Date().toISOString(),
          migrations: await migrationState(tx),
          kekIds: (
            await tx<{ id: string }[]>`
              select kek_id as id from key_check where retired_at is null order by 1`
          ).map((r) => r.id),
          tables: [],
          missingBlobs: [],
          blobs: 0,
        };
        for (const name of tables) {
          const [r] = await tx.unsafe<{ n: string }[]>(`select count(*) as n from ${ident(name)}`);
          m.tables.push({ name, rows: Number(r!.n) });
        }
        const objects = await objectsOf(tx);
        const zip = new ZipFile();
        let fail!: (e: unknown) => void;
        const failed = new Promise<never>((_, ko) => (fail = ko));
        const lazy = lazyWith(fail);
        const out = createWriteStream(partial, { mode: 0o600 });
        out.on("error", fail);
        zip.outputStream.pipe(out);
        for (const name of tables)
          zip.addReadStreamLazy(
            `db/${name}.copy`,
            {},
            lazy(() => tx.unsafe(`copy ${ident(name)} to stdout (format binary)`).readable()),
          );
        for (const o of objects)
          zip.addReadStreamLazy(
            `blobs/${o.key}`,
            { compress: false },
            lazy(async () => {
              const n = await store.size(o.key);
              if (n === null) {
                m.missingBlobs.push(o.key);
                return Readable.from([]);
              }
              m.blobs++;
              return Readable.from(store.getRange(o.key, 0, n));
            }),
          );
        // Last, so it can list what was missing.
        zip.addReadStreamLazy(
          MANIFEST,
          {},
          lazy(async () => Readable.from([Buffer.from(JSON.stringify(m, null, 2))])),
        );
        zip.end();
        try {
          await Promise.race([finished(out), failed]);
        } catch (e) {
          out.destroy();
          throw e;
        }
        return m;
      },
    );
    await rename(partial, file);
    return manifest;
  } catch (e) {
    await rm(partial, { force: true });
    throw e;
  }
}

/** A backup opened for reading: entries by name, streamed on demand. */
export class BackupReader {
  private constructor(
    private readonly zip: yauzl.ZipFile,
    private readonly entries: Map<string, yauzl.Entry>,
    readonly manifest: Manifest,
  ) {}

  static async open(file: string): Promise<BackupReader> {
    const zip = await new Promise<yauzl.ZipFile>((ok, ko) =>
      yauzl.open(file, { lazyEntries: true, autoClose: false }, (e, z) => (e ? ko(e) : ok(z))),
    );
    const entries = new Map<string, yauzl.Entry>();
    await new Promise<void>((ok, ko) => {
      zip.on("entry", (en: yauzl.Entry) => {
        entries.set(en.fileName, en);
        zip.readEntry();
      });
      zip.on("end", ok);
      zip.on("error", ko);
      zip.readEntry();
    });
    const r = new BackupReader(zip, entries, {} as Manifest);
    if (!entries.has(MANIFEST)) {
      zip.close();
      throw new BackupError("not a backup: manifest missing");
    }
    const parts: Buffer[] = [];
    for await (const c of await r.stream(MANIFEST)) parts.push(c as Buffer);
    const manifest = JSON.parse(Buffer.concat(parts).toString("utf8")) as Manifest;
    if (manifest.format !== BACKUP_FORMAT) {
      zip.close();
      throw new BackupError(`unsupported backup format ${String(manifest.format)}`);
    }
    return new BackupReader(zip, entries, manifest);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Storage keys in the backup (missing ones excluded). */
  blobKeys(): string[] {
    const missing = new Set(this.manifest.missingBlobs);
    return [...this.entries.keys()]
      .filter((n) => n.startsWith("blobs/"))
      .map((n) => n.slice("blobs/".length))
      .filter((k) => !missing.has(k));
  }

  stream(name: string): Promise<Readable> {
    const en = this.entries.get(name);
    if (!en) return Promise.reject(new BackupError(`backup entry missing: ${name}`));
    return new Promise((ok, ko) => this.zip.openReadStream(en, (e, s) => (e ? ko(e) : ok(s))));
  }

  close(): void {
    this.zip.close();
  }
}

/** The configured key(s) must include every key the backup was made with. */
export function assertKeysMatch(manifest: Manifest, ring: Keyring): void {
  const ids = new Set(keksOf(ring).map((k) => k.id));
  if (manifest.kekIds.length === 0 || !manifest.kekIds.every((id) => ids.has(id)))
    throw new MasterKeyError("master key does not match this backup");
}

export type RestoreOptions = {
  /** Which storage objects to write (default: all). */
  blobs?: (key: string) => boolean;
};

/**
 * Restores into an empty database: migrates it, refuses if any table has rows or the migration
 * version differs, writes the storage objects first and then every table in one transaction,
 * so an interrupted restore leaves the database empty and can simply be run again.
 */
export async function restoreBackup(
  db: Db,
  store: BlobStore,
  backup: BackupReader,
  ring: Keyring,
  opts: RestoreOptions = {},
): Promise<{ tables: number; rows: number; blobs: number }> {
  const m = backup.manifest;
  assertKeysMatch(m, ring);
  await runMigrations(db);
  const sql = db.$client;
  const mine = await migrationState(sql);
  if (mine.count !== m.migrations.count || mine.last !== m.migrations.last)
    throw new BackupError(
      "the backup comes from a different server version: restore it with the same version, then upgrade",
    );
  const tables = await tablesInOrder(sql);
  const names = new Set(m.tables.map((t) => t.name));
  if (tables.length !== names.size || tables.some((t) => !names.has(t)))
    throw new BackupError("the backup's tables don't match this server version");
  for (const t of tables) {
    const [r] = await sql.unsafe<{ n: string }[]>(`select exists (select 1 from ${ident(t)}) as n`);
    if (String(r!.n) === "true") throw new BackupError("the target database is not empty");
  }

  let blobs = 0;
  for (const key of backup.blobKeys()) {
    if (opts.blobs && !opts.blobs(key)) continue;
    await store.put(key, await backup.stream(`blobs/${key}`));
    blobs++;
  }

  let rows = 0;
  await sql.begin(async (tx) => {
    for (const t of tables) {
      const w = await tx.unsafe(`copy ${ident(t)} from stdin (format binary)`).writable();
      await pipeline(await backup.stream(`db/${t}.copy`), w);
    }
    // None today; a future serial column must continue after the restored rows.
    const seqs = await tx<{ seq: string; tbl: string; col: string }[]>`
      select s.relname as seq, t.relname as tbl, a.attname as col
      from pg_class s
      join pg_namespace n on n.oid = s.relnamespace
      join pg_depend d on d.objid = s.oid and d.deptype in ('a', 'i')
      join pg_class t on t.oid = d.refobjid
      join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
      where s.relkind = 'S' and n.nspname = 'public'`;
    for (const q of seqs)
      await tx.unsafe(
        `select setval('${ident(q.seq).replaceAll("'", "''")}', coalesce(max(${ident(q.col)}), 0) + 1, false) from ${ident(q.tbl)}`,
      );
    for (const t of m.tables) {
      const [r] = await tx.unsafe<{ n: string }[]>(`select count(*) as n from ${ident(t.name)}`);
      if (Number(r!.n) !== t.rows) throw new BackupError(`row count mismatch in ${t.name}`);
      rows += t.rows;
    }
  });
  return { tables: tables.length, rows, blobs };
}
