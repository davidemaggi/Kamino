import { and, eq, isNotNull } from "drizzle-orm";
import { blobKeyOf } from "../blobs/uploads.js";
import type { BlobStore } from "../blobs/store.js";
import type { Db } from "../db/client.js";
import { blobs, uploadSessions, vaults } from "../db/schema.js";

/**
 * Removes the stored blobs of deleted vaults (their key is already gone, F5). Idempotent: a blob
 * row is dropped only after its object, so an interrupted run resumes where it stopped.
 */
export async function purgeDeletedVaults(db: Db, store: BlobStore): Promise<{ blobs: number }> {
  const gone = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(and(eq(vaults.status, "deleted"), isNotNull(vaults.deletedAt)));
  let n = 0;
  for (const { id } of gone) {
    for (;;) {
      const batch = await db
        .select({ blobId: blobs.blobId })
        .from(blobs)
        .where(eq(blobs.vaultId, id))
        .limit(500);
      if (batch.length === 0) break;
      for (const b of batch) {
        await store.delete(blobKeyOf(id, b.blobId));
        await db.delete(blobs).where(and(eq(blobs.vaultId, id), eq(blobs.blobId, b.blobId)));
        n++;
      }
    }
    await db.delete(uploadSessions).where(eq(uploadSessions.vaultId, id));
  }
  return { blobs: n };
}
