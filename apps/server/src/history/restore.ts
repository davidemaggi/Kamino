import { and, eq } from "drizzle-orm";
import { uuidv7 } from "../auth/tokens.js";
import type { Db } from "../db/client.js";
import { files, fileVersions } from "../db/schema.js";
import { notFound } from "../http/errors.js";
import type { SyncService } from "../sync/commit.js";
import { commitForWeb } from "../sync/server-ops.js";
import type { VaultCrypto } from "../vaults/vault-crypto.js";

/**
 * Restores from the web app (03 §9.4) as plain puts built by the server: a new current version
 * with the chosen content on top of the head. On a deleted file the put brings it back (at its
 * path, or with " (n)" if taken) and the journal says `file_restored`.
 */
export class RestoreService {
  constructor(
    private readonly db: Db,
    private readonly sync: SyncService,
  ) {}

  async version(vc: VaultCrypto, versionId: string): Promise<void> {
    const v = vc.vaultId;
    const [ver] = await this.db
      .select()
      .from(fileVersions)
      .where(and(eq(fileVersions.vaultId, v), eq(fileVersions.id, versionId)));
    if (!ver) throw notFound();
    const f = await this.file(vc, ver.fileId);
    // Already the live current version: nothing to do.
    if (!f.deleted && f.headVersionId === ver.id) return;
    await this.put(vc, f, ver);
  }

  async trash(vc: VaultCrypto, fileId: string): Promise<void> {
    const f = await this.file(vc, fileId);
    if (!f.deleted || !f.headVersionId) throw notFound();
    const [ver] = await this.db
      .select()
      .from(fileVersions)
      .where(and(eq(fileVersions.vaultId, vc.vaultId), eq(fileVersions.id, f.headVersionId)));
    if (!ver) throw notFound();
    await this.put(vc, f, ver);
  }

  private async file(vc: VaultCrypto, fileId: string) {
    const [f] = await this.db
      .select()
      .from(files)
      .where(and(eq(files.vaultId, vc.vaultId), eq(files.id, fileId), eq(files.kind, "file")));
    if (!f) throw notFound();
    return f;
  }

  private async put(
    vc: VaultCrypto,
    f: typeof files.$inferSelect,
    ver: typeof fileVersions.$inferSelect,
  ): Promise<void> {
    const v = vc.vaultId;
    await commitForWeb(this.sync, vc, {
      type: "put",
      opId: uuidv7(),
      fileId: f.id,
      versionId: uuidv7(),
      path: vc.dec("files", "path", `${v}:${f.id}`, f.pathEnc),
      // The head read just now: if it moves before the commit, the put becomes a conflict
      // candidate, and the restored content is still kept.
      baseVersionId: f.headVersionId,
      contentHash: vc.dec("file_versions", "content_hash", `${v}:${ver.id}`, ver.contentHashEnc),
      size: ver.size,
      mtime: ver.mtime,
    });
  }
}
