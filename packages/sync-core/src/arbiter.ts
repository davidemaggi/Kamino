import type {
  ConflictResult,
  DeleteOp,
  ErrorCode,
  FinalResult,
  JournalType,
  MkdirOp,
  MoveOp,
  Op,
  PutOp,
  RejectedResult,
} from "@kamino/protocol";
import { ALWAYS_EXCLUDED, globMatch } from "./exclusions.js";
import { collisionKey, conflictSiblingPath, isCanonical } from "./paths.js";

/** Server-side file or folder (current state). */
export interface FileRecord {
  fileId: string;
  kind: "file" | "folder";
  path: string;
  /** Null for folders. */
  headVersionId: string | null;
  headHash: string | null;
  size: number;
  mtime: number;
  deleted: boolean;
}

export interface OpenConflict {
  conflictId: string;
  fileId: string;
  candidates: string[];
}

/**
 * What the rules read. The server (M1c) implements it with queries inside the commit
 * transaction, with the vault row locked; MemoryStore implements it in memory.
 */
export interface ArbiterView {
  recorded(opId: string): FinalResult | undefined;
  file(fileId: string): FileRecord | undefined;
  /** Live (not deleted) file or folder with this collision key. */
  liveAt(key: string): FileRecord | undefined;
  openConflict(fileId: string): OpenConflict | undefined;
  hasLiveDescendants(path: string): boolean;
  /** A version (current, old or candidate) with this id already exists. */
  versionExists(versionId: string): boolean;
  blobPresent(hash: string): boolean;
}

export interface JournalDraft {
  type: JournalType;
  fileId: string;
  kind: "file" | "folder";
  path: string;
  versionId?: string;
  contentHash?: string;
  size?: number;
  mtime?: number;
  conflictId?: string;
}

export type Mutation =
  | { type: "createFile"; file: FileRecord }
  | {
      type: "version";
      fileId: string;
      versionId: string;
      hash: string;
      size: number;
      mtime: number;
    }
  /** New current version; also clears `deleted`. */
  | { type: "head"; fileId: string; versionId: string; hash: string; size: number; mtime: number }
  | { type: "path"; fileId: string; path: string }
  | { type: "tombstone"; fileId: string }
  | { type: "undelete"; fileId: string }
  | {
      type: "openConflict";
      conflictId: string;
      fileId: string;
      kind: "concurrent_edit" | "both_created";
      baseVersionId: string | null;
      headVersionId: string;
      candidate: string;
    }
  | { type: "addCandidate"; conflictId: string; versionId: string }
  | { type: "journal"; entry: JournalDraft };

/** Accepted results get their `seq` from the store (the op's journal entry, or the head). */
export type DraftResult =
  | { status: "accepted"; fileId: string; versionId?: string; path: string }
  | ConflictResult
  | RejectedResult
  | { status: "duplicate"; original: FinalResult };

export interface Decision {
  result: DraftResult;
  mutations: Mutation[];
}

export interface ArbiterCtx {
  newId(): string;
}

const reject = (code: ErrorCode, path?: string): Decision => ({
  result: path === undefined ? { status: "rejected", code } : { status: "rejected", code, path },
  mutations: [],
});

const accept = (
  fileId: string,
  path: string,
  mutations: Mutation[],
  versionId?: string,
): Decision => ({
  result:
    versionId === undefined
      ? { status: "accepted", fileId, path }
      : { status: "accepted", fileId, versionId, path },
  mutations,
});

function pathError(path: string): ErrorCode | null {
  if (!isCanonical(path)) return "path_invalid";
  // NUL and control characters can't exist on any device's file system.
  for (const ch of path) if ((ch.codePointAt(0) ?? 0) < 32) return "path_invalid";
  if (ALWAYS_EXCLUDED.some((p) => globMatch(p, path))) return "path_forbidden";
  return null;
}

function freeSibling(view: ArbiterView, path: string, fileId: string): string {
  for (let n = 1; ; n++) {
    const candidate = conflictSiblingPath(path, n);
    const other = view.liveAt(collisionKey(candidate));
    if (!other || other.fileId === fileId) return candidate;
  }
}

/** The commit rules of 03 §5.3, one op at a time. */
export function decide(view: ArbiterView, op: Op, ctx: ArbiterCtx): Decision {
  const recorded = view.recorded(op.opId);
  if (recorded) return { result: { status: "duplicate", original: recorded }, mutations: [] };
  switch (op.type) {
    case "put":
      return decidePut(view, op, ctx);
    case "move":
      return decideMove(view, op);
    case "delete":
      return decideDelete(view, op);
    case "mkdir":
      return decideMkdir(view, op);
  }
}

function versionOf(fileId: string, op: PutOp): Mutation {
  return {
    type: "version",
    fileId,
    versionId: op.versionId,
    hash: op.contentHash,
    size: op.size,
    mtime: op.mtime,
  };
}

function headOf(fileId: string, op: PutOp): Mutation {
  return {
    type: "head",
    fileId,
    versionId: op.versionId,
    hash: op.contentHash,
    size: op.size,
    mtime: op.mtime,
  };
}

function putJournal(type: JournalType, fileId: string, path: string, op: PutOp): Mutation {
  return {
    type: "journal",
    entry: {
      type,
      fileId,
      kind: "file",
      path,
      versionId: op.versionId,
      contentHash: op.contentHash,
      size: op.size,
      mtime: op.mtime,
    },
  };
}

/** The version is kept as a candidate: nothing is ever thrown away (C-02). */
function conflictOn(
  view: ArbiterView,
  target: FileRecord,
  kind: "concurrent_edit" | "both_created",
  op: PutOp,
  ctx: ArbiterCtx,
): Decision {
  const headVersionId = target.headVersionId ?? "";
  const version = versionOf(target.fileId, op);
  const open = view.openConflict(target.fileId);
  if (open)
    return {
      result: { status: "conflict", conflictId: open.conflictId, headVersionId },
      mutations: [
        version,
        { type: "addCandidate", conflictId: open.conflictId, versionId: op.versionId },
      ],
    };
  const conflictId = ctx.newId();
  return {
    result: { status: "conflict", conflictId, headVersionId },
    mutations: [
      version,
      {
        type: "openConflict",
        conflictId,
        fileId: target.fileId,
        kind,
        baseVersionId: op.baseVersionId,
        headVersionId,
        candidate: op.versionId,
      },
      {
        type: "journal",
        entry: {
          type: "conflict_opened",
          fileId: target.fileId,
          kind: "file",
          path: target.path,
          conflictId,
        },
      },
    ],
  };
}

function decidePut(view: ArbiterView, op: PutOp, ctx: ArbiterCtx): Decision {
  // A version id is never reused: a retry has the same opId and is caught above as a duplicate.
  if (view.versionExists(op.versionId)) return reject("invalid_request");
  if (!view.blobPresent(op.contentHash)) return reject("blob_missing");
  const f = view.file(op.fileId);
  if (!f) {
    if (op.baseVersionId !== null) return reject("not_found");
    const bad = pathError(op.path);
    if (bad) return reject(bad);
    const other = view.liveAt(collisionKey(op.path));
    if (other)
      return other.kind === "folder"
        ? reject("path_taken", other.path)
        : conflictOn(view, other, "both_created", op, ctx);
    const file: FileRecord = {
      fileId: op.fileId,
      kind: "file",
      path: op.path,
      headVersionId: op.versionId,
      headHash: op.contentHash,
      size: op.size,
      mtime: op.mtime,
      deleted: false,
    };
    return accept(
      op.fileId,
      op.path,
      [
        { type: "createFile", file },
        versionOf(op.fileId, op),
        putJournal("file_put", op.fileId, op.path, op),
      ],
      op.versionId,
    );
  }
  if (f.kind === "folder") return reject("path_invalid");
  if (f.deleted) {
    // C-06: an edit wins over a deletion. Restored at its path, or next to it if taken meanwhile.
    const other = view.liveAt(collisionKey(f.path));
    const path = other && other.fileId !== f.fileId ? freeSibling(view, f.path, f.fileId) : f.path;
    // Path first, then alive: a restored file is never live, even for a moment, at a taken path
    // (the server enforces it with a unique index on live paths).
    const mutations: Mutation[] = [versionOf(f.fileId, op)];
    if (path !== f.path) mutations.push({ type: "path", fileId: f.fileId, path });
    mutations.push(headOf(f.fileId, op), putJournal("file_restored", f.fileId, path, op));
    return accept(f.fileId, path, mutations, op.versionId);
  }
  if (op.baseVersionId === f.headVersionId)
    return accept(
      f.fileId,
      f.path,
      [versionOf(f.fileId, op), headOf(f.fileId, op), putJournal("file_put", f.fileId, f.path, op)],
      op.versionId,
    );
  return conflictOn(view, f, "concurrent_edit", op, ctx);
}

function decideMove(view: ArbiterView, op: MoveOp): Decision {
  const f = view.file(op.fileId);
  if (!f || f.deleted) return reject("not_found");
  if (f.path !== op.fromPath) return reject("moved_elsewhere", f.path);
  const bad = pathError(op.toPath);
  if (bad) return reject(bad);
  const other = view.liveAt(collisionKey(op.toPath));
  if (other && other.fileId !== f.fileId) return reject("path_taken", other.path);
  return accept(f.fileId, op.toPath, [
    { type: "path", fileId: f.fileId, path: op.toPath },
    {
      type: "journal",
      entry: { type: "file_moved", fileId: f.fileId, kind: f.kind, path: op.toPath },
    },
  ]);
}

function decideDelete(view: ArbiterView, op: DeleteOp): Decision {
  const f = view.file(op.fileId);
  if (!f) return reject("not_found");
  if (f.deleted) return accept(f.fileId, f.path, []);
  if (f.kind === "folder") {
    if (view.hasLiveDescendants(f.path)) return reject("modified_since");
    return accept(f.fileId, f.path, [
      { type: "tombstone", fileId: f.fileId },
      {
        type: "journal",
        entry: { type: "folder_deleted", fileId: f.fileId, kind: "folder", path: f.path },
      },
    ]);
  }
  if (op.baseVersionId !== f.headVersionId) return reject("modified_since");
  return accept(f.fileId, f.path, [
    { type: "tombstone", fileId: f.fileId },
    {
      type: "journal",
      entry: { type: "file_deleted", fileId: f.fileId, kind: "file", path: f.path },
    },
  ]);
}

function decideMkdir(view: ArbiterView, op: MkdirOp): Decision {
  const f = view.file(op.fileId);
  if (f && f.kind !== "folder") return reject("path_invalid");
  if (f && !f.deleted) return accept(f.fileId, f.path, []);
  const bad = pathError(op.path);
  if (bad) return reject(bad);
  const other = view.liveAt(collisionKey(op.path));
  // 03 §9.4: two folders with the same path merge.
  if (other)
    return other.kind === "folder"
      ? accept(other.fileId, other.path, [])
      : reject("path_taken", other.path);
  const journal: Mutation = {
    type: "journal",
    entry: { type: "folder_created", fileId: op.fileId, kind: "folder", path: op.path },
  };
  if (f) {
    // Same rule as resurrection: move first, then alive.
    const mutations: Mutation[] = [];
    if (f.path !== op.path) mutations.push({ type: "path", fileId: f.fileId, path: op.path });
    mutations.push({ type: "undelete", fileId: f.fileId });
    return accept(f.fileId, op.path, [...mutations, journal]);
  }
  const folder: FileRecord = {
    fileId: op.fileId,
    kind: "folder",
    path: op.path,
    headVersionId: null,
    headHash: null,
    size: 0,
    mtime: 0,
    deleted: false,
  };
  return accept(op.fileId, op.path, [{ type: "createFile", file: folder }, journal]);
}
