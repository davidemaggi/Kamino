import type { FileList, FileVersions, TrashList, VersionContent } from "@kamino/protocol";
import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { readPlain } from "../blobs/uploads.js";
import type { BlobStore } from "../blobs/store.js";
import type { Db } from "../db/client.js";
import { conflictCandidates, devices, files, fileVersions, journal, vaults } from "../db/schema.js";
import { ApiError, notFound } from "../http/errors.js";
import type { VaultCrypto } from "../vaults/vault-crypto.js";

export const TEXT_PREVIEW_MAX = 1 << 20;
export const FILE_SEARCH_LIMIT = 200;
/** H-01: deleted files stay recoverable at least this long, whatever the history retention. */
export const TRASH_MIN_DAYS = 7;
const DAY_MS = 86_400_000;

export interface TreeEntry {
  kind: "file" | "folder";
  /** Empty for folders. */
  blobId: string;
  size: number;
  mtime: number;
}

const MIME: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  json: "application/json",
  canvas: "application/json",
  base: "text/plain",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

export function mimeOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return (dot > 0 && MIME[name.slice(dot + 1).toLowerCase()]) || "application/octet-stream";
}

export function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json";
}

const fold = (s: string) => s.normalize("NFC").toLowerCase();

/** Read-only views over a vault's history (F2): search, versions, trash, the tree at a date. */
export class HistoryService {
  constructor(
    private readonly db: Db,
    private readonly store: BlobStore,
    private readonly now: () => number = Date.now,
  ) {}

  private pathOf(vc: VaultCrypto, row: { id: string; pathEnc: Uint8Array }): string {
    return vc.dec("files", "path", `${vc.vaultId}:${row.id}`, row.pathEnc);
  }

  async search(vc: VaultCrypto, q: string): Promise<FileList> {
    const v = vc.vaultId;
    const rows = await this.db
      .select({
        id: files.id,
        pathEnc: files.pathEnc,
        versions: sql<number>`count(${fileVersions.id})::int`,
        last: sql<Date>`max(${fileVersions.createdAt})`,
      })
      .from(files)
      .innerJoin(
        fileVersions,
        and(eq(fileVersions.vaultId, files.vaultId), eq(fileVersions.fileId, files.id)),
      )
      .where(and(eq(files.vaultId, v), eq(files.kind, "file"), eq(files.deleted, false)))
      .groupBy(files.id, files.pathEnc);
    const needle = fold(q.trim());
    return {
      files: rows
        .map((r) => ({
          fileId: r.id,
          path: this.pathOf(vc, r),
          versions: r.versions,
          lastChangedAt: new Date(r.last).toISOString(),
        }))
        .filter((f) => fold(f.path).includes(needle))
        .sort((a, b) => b.lastChangedAt.localeCompare(a.lastChangedAt))
        .slice(0, FILE_SEARCH_LIMIT),
    };
  }

  private async file(vc: VaultCrypto, fileId: string) {
    const [f] = await this.db
      .select()
      .from(files)
      .where(and(eq(files.vaultId, vc.vaultId), eq(files.id, fileId), eq(files.kind, "file")));
    if (!f) throw notFound();
    return f;
  }

  async versions(vc: VaultCrypto, fileId: string): Promise<FileVersions> {
    const f = await this.file(vc, fileId);
    const rows = await this.db
      .select({
        id: fileVersions.id,
        at: fileVersions.createdAt,
        size: fileVersions.size,
        device: devices.name,
      })
      .from(fileVersions)
      .leftJoin(devices, eq(devices.id, fileVersions.deviceId))
      .where(and(eq(fileVersions.vaultId, vc.vaultId), eq(fileVersions.fileId, fileId)))
      .orderBy(desc(fileVersions.createdAt), desc(fileVersions.id));
    return {
      fileId,
      path: this.pathOf(vc, f),
      versions: rows.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        device: r.device ?? "—",
        size: r.size,
        current: r.id === f.headVersionId,
      })),
    };
  }

  async version(vc: VaultCrypto, versionId: string): Promise<VersionContent> {
    const [ver] = await this.db
      .select()
      .from(fileVersions)
      .where(and(eq(fileVersions.vaultId, vc.vaultId), eq(fileVersions.id, versionId)));
    if (!ver) throw notFound();
    const path = this.pathOf(vc, await this.file(vc, ver.fileId));
    const mime = mimeOf(path);
    return {
      id: ver.id,
      path,
      at: ver.createdAt.toISOString(),
      mime,
      size: ver.size,
      text:
        isTextMime(mime) && ver.size <= TEXT_PREVIEW_MAX
          ? await this.text(vc, ver.blobId, ver.size)
          : null,
      previewUrl: null,
    };
  }

  /** The decoded text of a blob, or null when it is not valid UTF-8. */
  async text(vc: VaultCrypto, blobId: string, size: number): Promise<string | null> {
    const parts: Buffer[] = [];
    for await (const p of readPlain(this.store, vc, blobId, size, 0, size)) parts.push(p);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
    } catch {
      return null;
    }
  }

  async trash(vc: VaultCrypto): Promise<TrashList> {
    const v = vc.vaultId;
    const [vault] = await this.db
      .select({ retentionDays: vaults.retentionDays })
      .from(vaults)
      .where(eq(vaults.id, v));
    const keepMs = Math.max(TRASH_MIN_DAYS, vault?.retentionDays ?? 0) * DAY_MS;
    const rows = await this.db
      .select({
        id: files.id,
        pathEnc: files.pathEnc,
        size: files.size,
        deletedAt: sql<Date | null>`(select max(${journal.at}) from ${journal}
          where ${journal.vaultId} = ${files.vaultId} and ${journal.fileId} = ${files.id}
          and ${journal.type} = 'file_deleted')`,
        lastVersionAt: sql<Date | null>`(select max(${fileVersions.createdAt}) from ${fileVersions}
          where ${fileVersions.vaultId} = ${files.vaultId} and ${fileVersions.fileId} = ${files.id})`,
      })
      .from(files)
      .where(and(eq(files.vaultId, v), eq(files.kind, "file"), eq(files.deleted, true)));
    const items = rows.map((r) => {
      // Journal compacted: the last version is the latest moment the deletion can be dated from.
      const deleted = new Date(r.deletedAt ?? r.lastVersionAt ?? 0);
      return {
        fileId: r.id,
        path: this.pathOf(vc, r),
        deletedAt: deleted.toISOString(),
        expiresAt: new Date(deleted.getTime() + keepMs).toISOString(),
        size: r.size,
      };
    });
    return { items: items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)) };
  }

  /**
   * Live files and folders at `at` (null = now): path → entry. Rebuilt from the current state by
   * undoing, newest first, the journal entries after `at`: all of them are still there, because
   * compaction only removes entries older than the retention window (checked here).
   */
  async treeAt(vc: VaultCrypto, at: Date | null): Promise<Map<string, TreeEntry>> {
    const v = vc.vaultId;
    const now = this.now();
    const [vault] = await this.db
      .select({ retentionDays: vaults.retentionDays, createdAt: vaults.createdAt })
      .from(vaults)
      .where(eq(vaults.id, v));
    if (!vault) throw notFound();
    const when = at === null || at.getTime() >= now ? null : at;
    if (
      when &&
      (when.getTime() < now - vault.retentionDays * DAY_MS ||
        when.getTime() < vault.createdAt.getTime())
    )
      throw new ApiError("history_window", 400);

    return this.db.transaction(
      async (tx) => {
        const state = new Map<
          string,
          { kind: "file" | "folder"; path: string; alive: boolean; head: string | null }
        >();
        const created = new Map<string, Date>();
        for (const r of await tx.select().from(files).where(eq(files.vaultId, v))) {
          state.set(r.id, {
            kind: r.kind as "file" | "folder",
            path: this.pathOf(vc, r),
            alive: !r.deleted,
            head: r.headVersionId,
          });
          created.set(r.id, r.createdAt);
        }
        if (when) {
          // Created after the date: not there yet. The entries left to undo only change files that existed.
          for (const [id, c] of created) if (c.getTime() > when.getTime()) state.delete(id);
          const entries = await tx
            .select()
            .from(journal)
            .where(and(eq(journal.vaultId, v), gt(journal.at, when)))
            .orderBy(desc(journal.seq));
          const bases = await this.bases(
            tx,
            v,
            entries.flatMap((e) => (e.versionId ? [e.versionId] : [])),
          );
          for (const e of entries) {
            const s = state.get(e.fileId);
            if (!s) continue;
            const from =
              e.fromPathEnc === null
                ? null
                : vc.dec("journal", "from_path", `${v}:${e.seq}`, e.fromPathEnc);
            switch (e.type) {
              case "file_put": {
                const base = e.versionId ? bases.get(e.versionId) : undefined;
                if (base) s.head = base;
                break;
              }
              case "file_restored":
                s.alive = false;
                if (from !== null) s.path = from;
                s.head = await this.headBefore(tx, v, e.fileId, e.seq, e.at);
                break;
              case "folder_created":
                s.alive = false;
                if (from !== null) s.path = from;
                break;
              case "file_moved":
                if (from !== null) s.path = from;
                break;
              case "file_deleted":
              case "folder_deleted":
                s.alive = true;
                break;
            }
          }
        }
        const heads = [...state.values()].flatMap((s) =>
          s.alive && s.kind === "file" && s.head ? [s.head] : [],
        );
        const vers = new Map<string, { blobId: string; size: number; mtime: number }>();
        for (let i = 0; i < heads.length; i += 1000)
          for (const r of await tx
            .select({
              id: fileVersions.id,
              blobId: fileVersions.blobId,
              size: fileVersions.size,
              mtime: fileVersions.mtime,
            })
            .from(fileVersions)
            .where(
              and(eq(fileVersions.vaultId, v), inArray(fileVersions.id, heads.slice(i, i + 1000))),
            ))
            vers.set(r.id, r);
        const out = new Map<string, TreeEntry>();
        for (const s of state.values()) {
          if (!s.alive) continue;
          if (s.kind === "folder")
            out.set(s.path, { kind: "folder", blobId: "", size: 0, mtime: 0 });
          else {
            const ver = s.head ? vers.get(s.head) : undefined;
            if (ver) out.set(s.path, { kind: "file", ...ver });
          }
        }
        return out;
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  /** versionId → its base (the head it replaced; null when it created the file). */
  private async bases(tx: Tx, vaultId: string, ids: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (let i = 0; i < ids.length; i += 1000)
      for (const r of await tx
        .select({ id: fileVersions.id, base: fileVersions.baseVersionId })
        .from(fileVersions)
        .where(
          and(eq(fileVersions.vaultId, vaultId), inArray(fileVersions.id, ids.slice(i, i + 1000))),
        ))
        out.set(r.id, r.base);
    return out;
  }

  /** The head a file had before the entry `seq`: the previous head-setting entry, else the last non-candidate version. */
  private async headBefore(
    tx: Tx,
    vaultId: string,
    fileId: string,
    seq: number,
    at: Date,
  ): Promise<string | null> {
    const [prev] = await tx
      .select({ versionId: journal.versionId })
      .from(journal)
      .where(
        and(
          eq(journal.vaultId, vaultId),
          eq(journal.fileId, fileId),
          lt(journal.seq, seq),
          inArray(journal.type, ["file_put", "file_restored"]),
        ),
      )
      .orderBy(desc(journal.seq))
      .limit(1);
    if (prev?.versionId) return prev.versionId;
    const [ver] = await tx
      .select({ id: fileVersions.id })
      .from(fileVersions)
      .where(
        and(
          eq(fileVersions.vaultId, vaultId),
          eq(fileVersions.fileId, fileId),
          lt(fileVersions.createdAt, at),
          sql`not exists (select 1 from ${conflictCandidates} where ${conflictCandidates.vaultId} = ${vaultId} and ${conflictCandidates.versionId} = ${fileVersions.id})`,
        ),
      )
      .orderBy(desc(fileVersions.createdAt))
      .limit(1);
    return ver?.id ?? null;
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
