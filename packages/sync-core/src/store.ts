import type {
  CommitResponse,
  FinalResult,
  JournalEntry,
  Op,
  OpResult,
  Snapshot,
} from "@kamino/protocol";
import { decide, type ArbiterView, type FileRecord, type Mutation } from "./arbiter.js";
import { collisionKey } from "./paths.js";

export interface StoredVersion {
  fileId: string;
  hash: string;
  size: number;
  mtime: number;
}

export interface StoredConflict {
  conflictId: string;
  fileId: string;
  kind: "concurrent_edit" | "both_created";
  baseVersionId: string | null;
  headVersionId: string;
  candidates: string[];
}

/** In-memory server: the simulator's backend and, in M1c, the oracle for the real server's tests. */
export class MemoryStore {
  head = 0;
  readonly files = new Map<string, FileRecord>();
  readonly versions = new Map<string, StoredVersion>();
  readonly conflicts = new Map<string, StoredConflict>();
  readonly journal: JournalEntry[] = [];
  readonly results = new Map<string, FinalResult>();
  readonly blobs = new Set<string>();
  readonly cursors = new Map<string, number>();
  private ids = 0;

  private readonly view: ArbiterView = {
    recorded: (opId) => this.results.get(opId),
    file: (fileId) => this.files.get(fileId),
    liveAt: (key) => {
      for (const f of this.files.values()) if (!f.deleted && collisionKey(f.path) === key) return f;
      return undefined;
    },
    // In M1a every stored conflict is open (resolution comes with M3).
    openConflict: (fileId) => {
      for (const c of this.conflicts.values()) if (c.fileId === fileId) return c;
      return undefined;
    },
    hasLiveDescendants: (path) => {
      const prefix = `${collisionKey(path)}/`;
      for (const f of this.files.values())
        if (!f.deleted && collisionKey(f.path).startsWith(prefix)) return true;
      return false;
    },
    blobPresent: (hash) => this.blobs.has(hash),
    versionExists: (versionId) => this.versions.has(versionId),
  };

  commit(ops: readonly Op[], deviceId: string): CommitResponse {
    return { results: ops.map((op) => this.apply(op, deviceId)), head: this.head };
  }

  private apply(op: Op, deviceId: string): OpResult {
    const decision = decide(this.view, op, { newId: () => `srv-${++this.ids}` });
    let seq = this.head;
    for (const m of decision.mutations) {
      if (m.type === "journal") {
        seq = ++this.head;
        this.journal.push({
          ...m.entry,
          seq,
          opId: op.opId,
          deviceId,
          at: new Date(0).toISOString(),
        });
      } else this.mutate(m);
    }
    const r = decision.result;
    if (r.status === "accepted") {
      const result: FinalResult = { ...r, seq };
      this.results.set(op.opId, result);
      return result;
    }
    if (r.status === "conflict") this.results.set(op.opId, r);
    return r;
  }

  private mutate(m: Exclude<Mutation, { type: "journal" }>): void {
    switch (m.type) {
      case "createFile":
        this.files.set(m.file.fileId, { ...m.file });
        return;
      case "version":
        this.versions.set(m.versionId, {
          fileId: m.fileId,
          hash: m.hash,
          size: m.size,
          mtime: m.mtime,
        });
        return;
      case "head": {
        const f = this.files.get(m.fileId)!;
        Object.assign(f, {
          headVersionId: m.versionId,
          headHash: m.hash,
          size: m.size,
          mtime: m.mtime,
          deleted: false,
        });
        return;
      }
      case "path":
        this.files.get(m.fileId)!.path = m.path;
        return;
      case "tombstone":
        this.files.get(m.fileId)!.deleted = true;
        return;
      case "undelete":
        this.files.get(m.fileId)!.deleted = false;
        return;
      case "openConflict":
        this.conflicts.set(m.conflictId, {
          conflictId: m.conflictId,
          fileId: m.fileId,
          kind: m.kind,
          baseVersionId: m.baseVersionId,
          headVersionId: m.headVersionId,
          candidates: [m.candidate],
        });
        return;
      case "addCandidate":
        this.conflicts.get(m.conflictId)!.candidates.push(m.versionId);
        return;
    }
  }

  changes(
    after: number,
    limit = 1000,
  ): { entries: JournalEntry[]; head: number; hasMore: boolean } {
    const all = this.journal.filter((e) => e.seq > after);
    return { entries: all.slice(0, limit), head: this.head, hasMore: all.length > limit };
  }

  snapshot(): Snapshot {
    return {
      head: this.head,
      files: [...this.files.values()]
        .filter((f) => !f.deleted)
        .map((f) => ({
          fileId: f.fileId,
          kind: f.kind,
          path: f.path,
          versionId: f.headVersionId,
          contentHash: f.headHash,
          size: f.size,
          mtime: f.mtime,
        })),
      openConflicts: [...this.conflicts.values()].map((c) => ({
        conflictId: c.conflictId,
        fileId: c.fileId,
      })),
    };
  }

  /** Whether this content is on the server: as a version, current or old, or as a conflict candidate. */
  hasContent(hash: string): boolean {
    for (const v of this.versions.values()) if (v.hash === hash) return true;
    return false;
  }
}

/** Broken invariants, as readable strings (empty = fine). */
export function checkInvariants(s: MemoryStore): string[] {
  const out: string[] = [];
  const keys = new Map<string, string>();
  for (const f of s.files.values()) {
    if (f.deleted) continue;
    const key = collisionKey(f.path);
    const other = keys.get(key);
    if (other) out.push(`two live files share a collision key: ${other} and ${f.fileId}`);
    keys.set(key, f.fileId);
    if (f.kind === "file") {
      const v = f.headVersionId === null ? undefined : s.versions.get(f.headVersionId);
      if (!v || v.hash !== f.headHash) out.push(`head of ${f.fileId} is not a stored version`);
    }
  }
  s.journal.forEach((e, i) => {
    if (e.seq !== i + 1) out.push(`journal seq ${e.seq} at position ${i + 1}`);
  });
  if (s.journal.length !== s.head) out.push(`head ${s.head} but ${s.journal.length} entries`);
  const perFile = new Set<string>();
  for (const c of s.conflicts.values()) {
    if (perFile.has(c.fileId)) out.push(`two open conflicts on ${c.fileId}`);
    perFile.add(c.fileId);
    for (const v of c.candidates) if (!s.versions.has(v)) out.push(`candidate ${v} not stored`);
  }
  return out;
}
