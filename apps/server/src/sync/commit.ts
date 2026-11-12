import type { FinalResult, JournalEntry, Op, OpResult, Snapshot } from "@kamino/protocol";
import {
  collisionKey,
  decide,
  type Decision,
  type FileRecord,
  type Mutation,
} from "@kamino/sync-core";
import { PRODUCT_SLUG } from "@kamino/brand";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { uuidv7 } from "../auth/tokens.js";
import type { Db } from "../db/client.js";
import {
  appliedOps,
  blobs,
  conflictCandidates,
  conflicts,
  devices,
  files,
  fileVersions,
  journal,
  vaults,
} from "../db/schema.js";
import type { VaultCrypto } from "../vaults/vault-crypto.js";
import { NeedData, PrefetchedView, type Need } from "./view.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** 02 §110: one notification per journal entry, `<vaultId>:<seq>`, sent only if the commit lands. */
export const NOTIFY_CHANNEL = `${PRODUCT_SLUG}_vault`;

/** The cursor is not in the journal (compacted, or beyond the head): start again from the snapshot. */
export class CursorTooOld extends Error {
  constructor() {
    super("cursor_too_old");
  }
}

/** The vault was deleted while the request was on its way (checked under the vault lock). */
export class VaultGone extends Error {
  constructor() {
    super("not_found");
  }
}

export class SyncService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** 03 §5: ops in order, each atomic on its own, vault row locked. */
  async commit(
    vc: VaultCrypto,
    deviceId: string,
    ops: Op[],
  ): Promise<{ results: OpResult[]; head: number }> {
    const results: OpResult[] = [];
    for (const op of ops)
      results.push(await this.db.transaction((tx) => this.applyOne(tx, vc, deviceId, op)));
    const [v] = await this.db
      .select({ head: vaults.headSeq })
      .from(vaults)
      .where(eq(vaults.id, vc.vaultId));
    await this.db
      .update(devices)
      .set({ lastSyncAt: new Date(this.now()) })
      .where(eq(devices.id, deviceId));
    return { results, head: v?.head ?? 0 };
  }

  private async applyOne(tx: Tx, vc: VaultCrypto, deviceId: string, op: Op): Promise<OpResult> {
    const [locked] = await tx
      .select({ head: vaults.headSeq, status: vaults.status })
      .from(vaults)
      .where(eq(vaults.id, vc.vaultId))
      .for("update");
    // deleteVault takes the same lock: nothing is written into a vault once it is deleted.
    if (!locked || locked.status !== "active") throw new VaultGone();
    let head = locked.head;
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
        // The path before the entry, from the record decide() read: lets history rebuild past trees.
        const before = view.files.get(m.entry.fileId)?.path;
        const fromPath = before !== undefined && before !== m.entry.path ? before : null;
        await this.insertJournal(tx, vc, deviceId, op.opId, seq, m.entry, fromPath);
      } else await this.mutate(tx, vc, deviceId, m);
    }
    if (head !== locked.head) {
      await tx.update(vaults).set({ headSeq: head }).where(eq(vaults.id, vc.vaultId));
      await tx.execute(sql`select pg_notify(${NOTIFY_CHANNEL}, ${`${vc.vaultId}:${head}`})`);
    }
    const r = decision.result;
    if (r.status === "accepted") {
      const result: FinalResult = { ...r, seq };
      await tx.insert(appliedOps).values({ vaultId: vc.vaultId, opId: op.opId, result });
      return result;
    }
    if (r.status === "conflict")
      await tx.insert(appliedOps).values({ vaultId: vc.vaultId, opId: op.opId, result: r });
    return r;
  }

  private async fileRecord(
    tx: Tx,
    vc: VaultCrypto,
    row: typeof files.$inferSelect,
  ): Promise<FileRecord> {
    let headHash: string | null = null;
    if (row.headVersionId) {
      const [v] = await tx
        .select()
        .from(fileVersions)
        .where(and(eq(fileVersions.vaultId, vc.vaultId), eq(fileVersions.id, row.headVersionId)));
      if (v)
        headHash = vc.dec(
          "file_versions",
          "content_hash",
          `${vc.vaultId}:${v.id}`,
          v.contentHashEnc,
        );
    }
    return {
      fileId: row.id,
      kind: row.kind as "file" | "folder",
      path: vc.dec("files", "path", `${vc.vaultId}:${row.id}`, row.pathEnc),
      headVersionId: row.headVersionId,
      headHash,
      size: row.size,
      mtime: row.mtime,
      deleted: row.deleted,
    };
  }

  private async load(tx: Tx, vc: VaultCrypto, view: PrefetchedView, need: Need): Promise<void> {
    const v = vc.vaultId;
    switch (need.kind) {
      case "recorded": {
        const [r] = await tx
          .select()
          .from(appliedOps)
          .where(and(eq(appliedOps.vaultId, v), eq(appliedOps.opId, need.opId)));
        view.recordedMap.set(need.opId, (r?.result as FinalResult | undefined) ?? null);
        return;
      }
      case "file": {
        const [r] = await tx
          .select()
          .from(files)
          .where(and(eq(files.vaultId, v), eq(files.id, need.fileId)));
        view.files.set(need.fileId, r ? await this.fileRecord(tx, vc, r) : null);
        return;
      }
      case "liveAt": {
        const [r] = await tx
          .select()
          .from(files)
          .where(
            and(
              eq(files.vaultId, v),
              eq(files.pathMac, vc.macOfKey(need.key)),
              eq(files.deleted, false),
            ),
          );
        view.live.set(need.key, r ? await this.fileRecord(tx, vc, r) : null);
        return;
      }
      case "conflict": {
        const [c] = await tx
          .select()
          .from(conflicts)
          .where(
            and(
              eq(conflicts.vaultId, v),
              eq(conflicts.fileId, need.fileId),
              eq(conflicts.status, "open"),
            ),
          );
        if (!c) {
          view.conflicts.set(need.fileId, null);
          return;
        }
        const cands = await tx
          .select()
          .from(conflictCandidates)
          .where(and(eq(conflictCandidates.vaultId, v), eq(conflictCandidates.conflictId, c.id)));
        view.conflicts.set(need.fileId, {
          conflictId: c.id,
          fileId: c.fileId,
          candidates: cands.map((x) => x.versionId),
        });
        return;
      }
      case "descendants": {
        // C8: paths are encrypted, so the prefix check decrypts the vault's live paths in memory.
        const prefix = `${collisionKey(need.path)}/`;
        const rows = await tx
          .select()
          .from(files)
          .where(and(eq(files.vaultId, v), eq(files.deleted, false)));
        view.descendants.set(
          need.path,
          rows.some((r) =>
            collisionKey(vc.dec("files", "path", `${v}:${r.id}`, r.pathEnc)).startsWith(prefix),
          ),
        );
        return;
      }
      case "version": {
        const [r] = await tx
          .select({ id: fileVersions.id })
          .from(fileVersions)
          .where(and(eq(fileVersions.vaultId, v), eq(fileVersions.id, need.versionId)));
        view.versions.set(need.versionId, !!r);
        return;
      }
      case "blob": {
        const [r] = await tx
          .select({ id: blobs.blobId })
          .from(blobs)
          .where(and(eq(blobs.vaultId, v), eq(blobs.blobId, vc.blobId(need.hash))));
        view.blobs.set(need.hash, !!r);
        return;
      }
    }
  }

  private async mutate(
    tx: Tx,
    vc: VaultCrypto,
    deviceId: string,
    m: Exclude<Mutation, { type: "journal" }>,
  ): Promise<void> {
    const v = vc.vaultId;
    const fileWhere = (id: string) => and(eq(files.vaultId, v), eq(files.id, id));
    switch (m.type) {
      case "createFile":
        await tx.insert(files).values({
          vaultId: v,
          id: m.file.fileId,
          kind: m.file.kind,
          pathEnc: vc.enc("files", "path", `${v}:${m.file.fileId}`, m.file.path),
          pathMac: vc.pathMac(m.file.path),
          headVersionId: m.file.headVersionId,
          size: m.file.size,
          mtime: m.file.mtime,
          deleted: false,
          createdAt: new Date(this.now()),
        });
        return;
      case "version":
        await tx.insert(fileVersions).values({
          vaultId: v,
          id: m.versionId,
          fileId: m.fileId,
          baseVersionId: m.baseVersionId,
          contentHashEnc: vc.enc("file_versions", "content_hash", `${v}:${m.versionId}`, m.hash),
          blobId: vc.blobId(m.hash),
          size: m.size,
          mtime: m.mtime,
          deviceId,
          createdAt: new Date(this.now()),
        });
        return;
      case "head":
        await tx
          .update(files)
          .set({
            headVersionId: m.versionId,
            size: m.size,
            mtime: m.mtime,
            deleted: false,
            deletedAt: null,
          })
          .where(fileWhere(m.fileId));
        return;
      case "path":
        await tx
          .update(files)
          .set({
            pathEnc: vc.enc("files", "path", `${v}:${m.fileId}`, m.path),
            pathMac: vc.pathMac(m.path),
          })
          .where(fileWhere(m.fileId));
        return;
      case "tombstone":
        await tx
          .update(files)
          .set({ deleted: true, deletedAt: new Date(this.now()) })
          .where(fileWhere(m.fileId));
        return;
      case "undelete":
        await tx.update(files).set({ deleted: false, deletedAt: null }).where(fileWhere(m.fileId));
        return;
      case "openConflict":
        await tx.insert(conflicts).values({
          vaultId: v,
          id: m.conflictId,
          fileId: m.fileId,
          kind: m.kind,
          baseVersionId: m.baseVersionId,
          headVersionId: m.headVersionId,
          createdAt: new Date(this.now()),
        });
        await tx.insert(conflictCandidates).values({
          vaultId: v,
          conflictId: m.conflictId,
          versionId: m.candidate,
          deviceId,
          createdAt: new Date(this.now()),
        });
        return;
      case "addCandidate":
        await tx.insert(conflictCandidates).values({
          vaultId: v,
          conflictId: m.conflictId,
          versionId: m.versionId,
          deviceId,
          createdAt: new Date(this.now()),
        });
        return;
    }
  }

  private async insertJournal(
    tx: Tx,
    vc: VaultCrypto,
    deviceId: string,
    opId: string,
    seq: number,
    e: Extract<Mutation, { type: "journal" }>["entry"],
    fromPath: string | null,
  ): Promise<void> {
    const v = vc.vaultId;
    await tx.insert(journal).values({
      vaultId: v,
      seq,
      type: e.type,
      fileId: e.fileId,
      kind: e.kind,
      opId,
      versionId: e.versionId ?? null,
      pathEnc: vc.enc("journal", "path", `${v}:${seq}`, e.path),
      fromPathEnc:
        fromPath === null ? null : vc.enc("journal", "from_path", `${v}:${seq}`, fromPath),
      contentHashEnc:
        e.contentHash === undefined
          ? null
          : vc.enc("journal", "content_hash", `${v}:${seq}`, e.contentHash),
      size: e.size ?? null,
      mtime: e.mtime ?? null,
      conflictId: e.conflictId ?? null,
      deviceId,
      at: new Date(this.now()),
    });
  }

  /** Floor and entries in one consistent read, so compaction can't open a silent gap. */
  async changes(
    vc: VaultCrypto,
    after: number,
    limit: number,
  ): Promise<{ entries: JournalEntry[]; head: number; hasMore: boolean }> {
    const v = vc.vaultId;
    return this.db.transaction(
      async (tx) => {
        const [h] = await tx
          .select({ head: vaults.headSeq, floor: vaults.journalFloor })
          .from(vaults)
          .where(eq(vaults.id, v));
        // Below the floor: compacted away. Above the head: the server's journal is not the one the
        // device knew (e.g. restored from a backup); skipping reused seqs would lose changes.
        if (after < (h?.floor ?? 0) || after > (h?.head ?? 0)) throw new CursorTooOld();
        const rows = await tx
          .select()
          .from(journal)
          .where(and(eq(journal.vaultId, v), gt(journal.seq, after)))
          .orderBy(asc(journal.seq))
          .limit(limit + 1);
        const entries = rows.slice(0, limit).map((r): JournalEntry => ({
          seq: r.seq,
          type: r.type,
          fileId: r.fileId,
          kind: r.kind as "file" | "folder",
          path: vc.dec("journal", "path", `${v}:${r.seq}`, r.pathEnc),
          deviceId: r.deviceId,
          at: r.at.toISOString(),
          ...(r.opId ? { opId: r.opId } : {}),
          ...(r.versionId ? { versionId: r.versionId } : {}),
          ...(r.contentHashEnc
            ? {
                contentHash: vc.dec("journal", "content_hash", `${v}:${r.seq}`, r.contentHashEnc),
              }
            : {}),
          ...(r.size !== null ? { size: r.size } : {}),
          ...(r.mtime !== null ? { mtime: r.mtime } : {}),
          ...(r.conflictId ? { conflictId: r.conflictId } : {}),
          // Entries about the vault, not a file: clients that don't know them skip them (03 §13).
          ...(r.type === "vault_settings_changed" ? { ignorable: true } : {}),
        }));
        return { entries, head: h?.head ?? 0, hasMore: rows.length > limit };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  /** One consistent read: the state is exactly the one at `head` (03 §6.2). */
  async snapshot(vc: VaultCrypto): Promise<Snapshot> {
    return this.db.transaction(
      async (tx) => {
        const v = vc.vaultId;
        const [h] = await tx.select({ head: vaults.headSeq }).from(vaults).where(eq(vaults.id, v));
        const rows = await tx
          .select()
          .from(files)
          .where(and(eq(files.vaultId, v), eq(files.deleted, false)));
        const out: Snapshot["files"] = [];
        for (const r of rows) {
          const rec = await this.fileRecord(tx, vc, r);
          out.push({
            fileId: rec.fileId,
            kind: rec.kind,
            path: rec.path,
            versionId: rec.headVersionId,
            contentHash: rec.headHash,
            size: rec.size,
            mtime: rec.mtime,
          });
        }
        const open = await tx
          .select()
          .from(conflicts)
          .where(and(eq(conflicts.vaultId, v), eq(conflicts.status, "open")));
        return {
          head: h?.head ?? 0,
          files: out,
          openConflicts: open.map((c) => ({ conflictId: c.id, fileId: c.fileId })),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async ack(deviceId: string, vaultId: string, seq: number): Promise<void> {
    await this.db
      .update(devices)
      .set({
        cursorSeq: sql`greatest(${devices.cursorSeq}, least(${seq}, (select head_seq from vaults where id = ${vaultId})))`,
        lastAckAt: new Date(this.now()),
      })
      .where(eq(devices.id, deviceId));
  }
}
