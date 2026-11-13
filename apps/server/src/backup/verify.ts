import { createHash, randomBytes, randomInt } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { PRODUCT_SLUG } from "@kamino/brand";
import { FsBlobStore } from "../blobs/fs-store.js";
import { collect, SYSTEM_PREFIX } from "../blobs/store.js";
import { readPlain } from "../blobs/uploads.js";
import { verifyKeyCheck } from "../crypto/key-check.js";
import type { Keyring } from "../crypto/keyring.js";
import { createDb } from "../db/client.js";
import { blobs, vaults } from "../db/schema.js";
import { VaultService } from "../vaults/service.js";
import { assertKeysMatch, BackupError, BackupReader, restoreBackup } from "./archive.js";

export type VerifyReport = {
  tables: number;
  rows: number;
  /** Active vaults whose DEK opened with the configured key. */
  vaults: number;
  blobsChecked: number;
  blobsTotal: number;
};

function pick<T>(all: T[], n: number): T[] {
  const a = [...all];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

/**
 * M7b B3 (04 §7): restores the backup into a temporary database on the same server (and a
 * sample of objects into a temporary folder), checks that the key opens the key check and every
 * DEK, and that each sampled blob decrypts to content matching its hash. Drops both afterwards.
 */
export async function verifyBackup(
  databaseUrl: string,
  file: string,
  ring: Keyring,
  sample = 20,
): Promise<VerifyReport> {
  const backup = await BackupReader.open(file);
  const admin = createDb(databaseUrl);
  const name = `${PRODUCT_SLUG}_verify_${randomBytes(6).toString("hex")}`;
  const dir = await mkdtemp(join(tmpdir(), `${PRODUCT_SLUG}-verify-`));
  let created = false;
  try {
    assertKeysMatch(backup.manifest, ring);
    await admin.$client.unsafe(`create database "${name}"`);
    created = true;
    const url = new URL(databaseUrl);
    url.pathname = `/${name}`;
    const db = createDb(url.toString());
    try {
      const keys = backup.blobKeys().filter((k) => !k.startsWith(`${SYSTEM_PREFIX}/`));
      const chosen = new Set(pick(keys, sample));
      const store = new FsBlobStore(dir);
      const restored = await restoreBackup(db, store, backup, ring, {
        blobs: (k) => chosen.has(k),
      });
      await verifyKeyCheck(db, ring);
      const svc = new VaultService(db, ring);
      const active = await db.select().from(vaults).where(eq(vaults.status, "active"));
      for (const v of active) svc.cryptoOf(v);
      let checked = 0;
      for (const key of chosen) {
        const [vaultId, blobId] = key.split("/") as [string, string];
        const v = active.find((x) => x.id === vaultId);
        if (!v) continue; // A deleted vault's blobs wait for the purge: no DEK any more.
        const [row] = await db
          .select({ size: blobs.size })
          .from(blobs)
          .where(and(eq(blobs.vaultId, vaultId), eq(blobs.blobId, blobId)));
        if (!row) continue;
        const vc = svc.cryptoOf(v);
        const plain = await collect(readPlain(store, vc, blobId, row.size, 0, row.size));
        const hash = createHash("sha256").update(plain).digest("hex");
        if (vc.blobId(hash) !== blobId) throw new BackupError("a blob does not match its hash");
        checked++;
      }
      return {
        tables: restored.tables,
        rows: restored.rows,
        vaults: active.length,
        blobsChecked: checked,
        blobsTotal: keys.length,
      };
    } finally {
      await db.$client.end({ timeout: 5 });
    }
  } finally {
    backup.close();
    if (created) await admin.$client.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.$client.end({ timeout: 5 });
    await rm(dir, { recursive: true, force: true });
  }
}
