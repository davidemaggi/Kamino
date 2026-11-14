import type { BinaryMeta, ConflictDetail, ConflictSummary } from "@kamino/protocol";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { BlobStore } from "../blobs/store.js";
import type { Db } from "../db/client.js";
import { conflictCandidates, conflicts, devices, files, fileVersions } from "../db/schema.js";
import { HistoryService, isTextMime, mimeOf, TEXT_PREVIEW_MAX } from "../history/service.js";
import { notFound } from "../http/errors.js";
import type { Vault, VaultService } from "../vaults/service.js";
import type { VaultCrypto } from "../vaults/vault-crypto.js";

interface Side {
  versionId: string;
  device: string;
  at: Date;
  blobId: string;
  size: number;
}

/**
 * Open conflicts, read only (F2). "Mine" is the version the server keeps as the file's head,
 * "incoming" the newest candidate that lost against it.
 */
export class ConflictService {
  private readonly history: HistoryService;
  constructor(
    private readonly db: Db,
    store: BlobStore,
    private readonly vaults: VaultService,
  ) {
    this.history = new HistoryService(db, store);
  }

  async list(userId: string): Promise<ConflictSummary[]> {
    const out: ConflictSummary[] = [];
    for (const vault of await this.vaults.listForUser(userId)) {
      const vc = this.vaults.cryptoOf(vault);
      const rows = await this.db
        .select({ id: conflicts.id })
        .from(conflicts)
        .where(and(eq(conflicts.vaultId, vault.id), eq(conflicts.status, "open")))
        .orderBy(desc(conflicts.createdAt));
      for (const r of rows) {
        const s = await this.summary(vault, vc, r.id);
        if (s) out.push(s.summary);
      }
    }
    return out;
  }

  async detail(vault: Vault, conflictId: string): Promise<ConflictDetail> {
    const vc = this.vaults.cryptoOf(vault);
    const s = await this.summary(vault, vc, conflictId);
    if (!s) throw notFound();
    const { binary, ...base } = s.summary;
    if (!binary) {
      const [mineText, incomingText] = await Promise.all([
        this.textOrNull(vc, s.mine),
        this.textOrNull(vc, s.incoming),
      ]);
      if (mineText !== null && incomingText !== null)
        return { ...base, binary: false, mineText, incomingText };
    }
    const meta = (x: Side): BinaryMeta => ({ size: x.size, mime: s.mime, previewUrl: null });
    return { ...base, binary: true, mineFile: meta(s.mine), incomingFile: meta(s.incoming) };
  }

  /**
   * A side whose object is missing from the store (e.g. a data directory moved without its
   * blobs) is shown like a binary one: the choice still works, only the preview is gone.
   */
  private async textOrNull(vc: VaultCrypto, x: Side): Promise<string | null> {
    try {
      return await this.history.text(vc, x.blobId, x.size);
    } catch (e) {
      const err = e as { code?: string; name?: string };
      if (err.code === "ENOENT" || err.name === "NoSuchKey") return null;
      throw e;
    }
  }

  /** Finds which of the user's vaults holds `conflictId` (ids are unique per vault). */
  async vaultOf(userId: string, conflictId: string): Promise<Vault> {
    const owned = await this.vaults.listForUser(userId);
    if (owned.length === 0) throw notFound();
    const rows = await this.db
      .select({ vaultId: conflicts.vaultId })
      .from(conflicts)
      .where(
        and(
          eq(conflicts.id, conflictId),
          inArray(
            conflicts.vaultId,
            owned.map((v) => v.id),
          ),
        ),
      );
    const only = rows.length === 1 ? owned.find((v) => v.id === rows[0]!.vaultId) : undefined;
    if (!only) throw notFound();
    return only;
  }

  private async summary(
    vault: Vault,
    vc: VaultCrypto,
    conflictId: string,
  ): Promise<{ summary: ConflictSummary; mine: Side; incoming: Side; mime: string } | null> {
    const v = vault.id;
    const [c] = await this.db
      .select()
      .from(conflicts)
      .where(
        and(eq(conflicts.vaultId, v), eq(conflicts.id, conflictId), eq(conflicts.status, "open")),
      );
    if (!c) return null;
    const [f] = await this.db
      .select()
      .from(files)
      .where(and(eq(files.vaultId, v), eq(files.id, c.fileId)));
    if (!f?.headVersionId) return null;
    const [cand] = await this.db
      .select({ versionId: conflictCandidates.versionId })
      .from(conflictCandidates)
      .where(and(eq(conflictCandidates.vaultId, v), eq(conflictCandidates.conflictId, c.id)))
      // Same order as ResolutionService.state: ties broken by version id.
      .orderBy(desc(conflictCandidates.createdAt), desc(conflictCandidates.versionId))
      .limit(1);
    if (!cand) return null;
    const sides = await this.db
      .select({
        versionId: fileVersions.id,
        device: devices.name,
        at: fileVersions.createdAt,
        blobId: fileVersions.blobId,
        size: fileVersions.size,
      })
      .from(fileVersions)
      .leftJoin(devices, eq(devices.id, fileVersions.deviceId))
      .where(
        and(
          eq(fileVersions.vaultId, v),
          inArray(fileVersions.id, [f.headVersionId, cand.versionId]),
        ),
      );
    const side = (id: string): Side | undefined => {
      const r = sides.find((x) => x.versionId === id);
      return r && { ...r, device: r.device ?? "—" };
    };
    const mine = side(f.headVersionId);
    const incoming = side(cand.versionId);
    if (!mine || !incoming) return null;
    const path = vc.dec("files", "path", `${v}:${f.id}`, f.pathEnc);
    const mime = mimeOf(path);
    const binary =
      !isTextMime(mime) || mine.size > TEXT_PREVIEW_MAX || incoming.size > TEXT_PREVIEW_MAX;
    return {
      summary: {
        id: c.id,
        vaultId: v,
        vaultName: this.vaults.nameOf(vault),
        path,
        kind: c.kind as ConflictSummary["kind"],
        binary,
        mine: { device: mine.device, at: mine.at.toISOString() },
        incoming: { device: incoming.device, at: incoming.at.toISOString() },
      },
      mine,
      incoming,
      mime,
    };
  }
}
