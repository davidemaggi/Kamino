import type { BulkStrategy, ResolveAllRequest, ResolveKeep, Resolution } from "@kamino/protocol";
import { CONFLICT_COPY_LABEL, conflictCopyPath, conflictStamp } from "@kamino/sync-core";
import { and, desc, eq } from "drizzle-orm";
import { uuidv7 } from "../auth/tokens.js";
import { storePlain, type UploadService } from "../blobs/uploads.js";
import type { Db } from "../db/client.js";
import { conflictCandidates, conflicts, devices, files, fileVersions } from "../db/schema.js";
import { ApiError } from "../http/errors.js";
import { WEB_AUTHOR, type SyncService } from "../sync/commit.js";
import { commitForWeb } from "../sync/server-ops.js";
import type { Vault, VaultService } from "../vaults/service.js";
import type { VaultCrypto } from "../vaults/vault-crypto.js";

const stale = () => new ApiError("stale_resolution", 409);
const matches = (seen: Seen, e: { incomingAt: string; mineAt?: string | undefined }) =>
  seen.incoming.at.toISOString() === e.incomingAt &&
  (e.mineAt === undefined || seen.headAt.toISOString() === e.mineAt);

interface Seen {
  fileId: string;
  path: string;
  headVersionId: string;
  headAt: Date;
  incoming: { versionId: string; at: Date; device: string | null };
}

/**
 * Conflict resolution from the web app (03 §9.3). The choice becomes a `resolve` op, committed
 * through the same rules as a device's: "mine" is the server head, "incoming" the newest
 * candidate, as in the conflict view.
 */
export class ResolutionService {
  constructor(
    private readonly db: Db,
    private readonly sync: SyncService,
    private readonly vaults: VaultService,
    private readonly uploads: UploadService,
  ) {}

  async resolve(
    vault: Vault,
    lang: "it" | "en",
    conflictId: string,
    resolution: Resolution,
    expected: { incomingAt: string; mineAt?: string | undefined },
  ): Promise<void> {
    const vc = this.vaults.cryptoOf(vault);
    const seen = await this.state(vc, conflictId);
    if (!seen || !matches(seen, expected)) throw stale();
    const keep = await this.keepOf(vc, lang, seen, resolution);
    await this.commit(vc, conflictId, seen, keep);
  }

  /**
   * Only the conflicts the user saw, as they saw them: those closed or changed meanwhile, or
   * that cannot be resolved this way (e.g. no room for the copy), are skipped, not an error.
   */
  async resolveAll(
    owned: Vault[],
    lang: "it" | "en",
    strategy: BulkStrategy,
    items: ResolveAllRequest["items"],
  ): Promise<number> {
    let resolved = 0;
    const done = new Set<string>();
    for (const item of items) {
      if (done.has(item.id)) continue;
      done.add(item.id);
      for (const vault of owned) {
        const vc = this.vaults.cryptoOf(vault);
        const seen = await this.state(vc, item.id);
        if (!seen) continue;
        const expected = { incomingAt: item.expectedIncomingAt, mineAt: item.expectedMineAt };
        if (!matches(seen, expected)) break;
        try {
          await this.commit(vc, item.id, seen, await this.keepOf(vc, lang, seen, strategy));
          resolved++;
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
        }
        break;
      }
    }
    return resolved;
  }

  private async commit(vc: VaultCrypto, conflictId: string, seen: Seen, keep: ResolveKeep) {
    await commitForWeb(this.sync, vc, {
      type: "resolve",
      opId: uuidv7(),
      conflictId,
      expectedHeadVersionId: seen.headVersionId,
      keep,
    });
  }

  private async keepOf(
    vc: VaultCrypto,
    lang: "it" | "en",
    seen: Seen,
    resolution: Resolution,
  ): Promise<ResolveKeep> {
    if (resolution === "keep_mine") return { kind: "head" };
    if (resolution === "keep_incoming")
      return {
        kind: "candidate",
        candidateVersionId: seen.incoming.versionId,
        versionId: uuidv7(),
      };
    if (resolution === "keep_both")
      return {
        kind: "both",
        candidateVersionId: seen.incoming.versionId,
        fileId: uuidv7(),
        versionId: uuidv7(),
        // The server doesn't know the user's time zone: the stamp is UTC.
        path: conflictCopyPath(
          seen.path,
          CONFLICT_COPY_LABEL[lang],
          seen.incoming.device ?? "web",
          conflictStamp(seen.incoming.at, true),
        ),
      };
    const data = Buffer.from(resolution.manual, "utf8");
    const { contentHash, size } = await storePlain(this.uploads, vc, WEB_AUTHOR, data);
    return { kind: "content", versionId: uuidv7(), contentHash, size, mtime: Date.now() };
  }

  /** The open conflict as the web app shows it, or null when it is not open any more. */
  private async state(vc: VaultCrypto, conflictId: string): Promise<Seen | null> {
    const v = vc.vaultId;
    const [c] = await this.db
      .select()
      .from(conflicts)
      .where(
        and(eq(conflicts.vaultId, v), eq(conflicts.id, conflictId), eq(conflicts.status, "open")),
      );
    if (!c) return null;
    const [f] = await this.db
      .select({
        id: files.id,
        pathEnc: files.pathEnc,
        head: files.headVersionId,
        at: fileVersions.createdAt,
      })
      .from(files)
      .innerJoin(
        fileVersions,
        and(eq(fileVersions.vaultId, files.vaultId), eq(fileVersions.id, files.headVersionId)),
      )
      .where(and(eq(files.vaultId, v), eq(files.id, c.fileId)));
    if (!f?.head) return null;
    const [cand] = await this.db
      .select({
        versionId: conflictCandidates.versionId,
        at: fileVersions.createdAt,
        device: devices.name,
      })
      .from(conflictCandidates)
      .innerJoin(
        fileVersions,
        and(
          eq(fileVersions.vaultId, conflictCandidates.vaultId),
          eq(fileVersions.id, conflictCandidates.versionId),
        ),
      )
      .leftJoin(devices, eq(devices.id, fileVersions.deviceId))
      .where(and(eq(conflictCandidates.vaultId, v), eq(conflictCandidates.conflictId, c.id)))
      .orderBy(desc(conflictCandidates.createdAt), desc(conflictCandidates.versionId))
      .limit(1);
    if (!cand) return null;
    return {
      fileId: f.id,
      path: vc.dec("files", "path", `${v}:${f.id}`, f.pathEnc),
      headVersionId: f.head,
      headAt: f.at,
      incoming: { versionId: cand.versionId, at: cand.at, device: cand.device },
    };
  }
}
