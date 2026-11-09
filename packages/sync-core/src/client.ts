import type {
  AcceptedResult,
  ErrorCode,
  JournalEntry,
  Op,
  OpResult,
  RejectedResult,
  Snapshot,
} from "@kamino/protocol";
import { classify, type SyncSettings } from "./exclusions.js";
import {
  collisionKey,
  conflictSiblingPath,
  isRepresentable,
  localPath,
  type Platform,
} from "./paths.js";

/** One file as this device knows it (durable). Folders arrive with M1d (Z9). */
export interface Entry {
  fileId: string;
  /** Canonical path on this device. */
  path: string;
  /** The server knows this fileId. */
  confirmed: boolean;
  /** Path on the server as last known (null until confirmed). */
  remotePath: string | null;
  /** Version the local content derives from. */
  base: string | null;
  baseHash: string | null;
  /** Latest server version known: may be newer than `base`. */
  head: string | null;
  headHash: string | null;
  headSeq: number;
  /** Journal position up to which `remotePath` reflects the server: older moves are stale. */
  pathSeq: number;
  headDeleted: boolean;
  /** Content on disk as last seen; null = not on disk. */
  localHash: string | null;
  size: number;
  mtime: number;
  /** Was on disk for this entry: only then a missing file means "deleted here". */
  materialized: boolean;
  /** Write in progress, persisted before the write (write-ahead). */
  pendingWrite: { versionId: string; hash: string } | null;
  /** Losing side of an open conflict: the local copy is the user's, never overwritten (03 §9.2). */
  conflictId: string | null;
  /** Why the server path can't exist on this device (not representable or excluded): never written or moved here. */
  unavailable: string | null;
  /** Last rejection: not retried until the next sync cycle. */
  blocked: ErrorCode | null;
  /**
   * Following a server move: `path` is the server path to follow, `target` the local rename
   * already issued for it (null = not yet, or failed). While set, the difference between `path`
   * and `remotePath` is not a local move (no `move` op is sent).
   */
  renaming: { path: string; target: string | null } | null;
}

export interface Durable {
  index: Record<string, Entry>;
  /** Ops sent with unknown outcome: resent identical (same opId) before anything else. */
  sent: Op[];
  cursor: number;
  joined: boolean;
}

export interface Volatile {
  phase: "idle" | "joining" | "pushing" | "pulling";
  requestId: string | null;
  /** Set when an unknown, non-ignorable journal entry arrives: the plugin must be updated. */
  stopped: "update_required" | null;
}

export interface ClientConfig {
  deviceId: string;
  platform: Platform;
  configDir: string;
  settings: SyncSettings;
  batchSize: number;
}

export interface ClientState {
  config: ClientConfig;
  durable: Durable;
  vol: Volatile;
}

export interface ScanItem {
  /** Canonical path. */
  path: string;
  hash: string;
  size: number;
  mtime: number;
}

export type ClientEvent =
  /** Start of a cycle (03 §8): full scan of the vault, then push and pull. */
  | { type: "sync"; scan: ScanItem[] }
  | { type: "localRename"; from: string; to: string }
  | { type: "snapshotResult"; requestId: string; snapshot: Snapshot }
  | { type: "pushResult"; requestId: string; results: OpResult[]; head: number }
  | {
      type: "pullResult";
      requestId: string;
      entries: JournalEntry[];
      head: number;
      hasMore: boolean;
    }
  | { type: "networkError"; requestId: string }
  | { type: "written"; fileId: string; ok: boolean }
  | { type: "renamed"; fileId: string; to: string; ok: boolean }
  | { type: "trashed"; fileId: string; ok: boolean };

export type NotifyKind = "conflict" | "blocked" | "restored" | "renamed" | "update_required";

/** Paths in file effects are local (configuration folder under its local name). */
export type Effect =
  | { type: "persist" }
  | { type: "snapshot"; requestId: string }
  | { type: "push"; requestId: string; ops: Op[]; hashes: string[] }
  | { type: "pull"; requestId: string; after: number }
  /** Write only if the file at `path` still has hash `expect` (null = must not exist). */
  | { type: "write"; fileId: string; path: string; hash: string; expect: string | null }
  | { type: "rename"; fileId: string; from: string; to: string; toPath: string }
  /** Move to the trash only if the file still has hash `expect`. */
  | { type: "trash"; fileId: string; path: string; expect: string }
  | { type: "ack"; seq: number }
  | { type: "notify"; kind: NotifyKind; fileId?: string; code?: ErrorCode };

export interface ClientEnv {
  newId(): string;
}

interface Ctx {
  s: ClientState;
  env: ClientEnv;
  fx: Effect[];
}

export function initialState(config: ClientConfig): ClientState {
  return {
    config,
    durable: { index: {}, sent: [], cursor: 0, joined: false },
    vol: { phase: "idle", requestId: null, stopped: null },
  };
}

/** Exponential backoff with jitter, 1 s to 5 min (03 §8). `random` in [0, 1). */
export function retryDelay(attempt: number, random: number): number {
  const base = Math.min(300_000, 1000 * 2 ** Math.min(attempt, 20));
  return Math.min(300_000, Math.round(base * (1 + random)));
}

/**
 * The whole client as a pure reducer. `persist` is always the first effect: the shell saves
 * `durable` before doing anything else (S-04, write-ahead).
 */
export function step(
  state: ClientState,
  event: ClientEvent,
  env: ClientEnv,
): { state: ClientState; effects: Effect[] } {
  const s: ClientState = {
    config: state.config,
    durable: JSON.parse(JSON.stringify(state.durable)) as Durable,
    vol: { ...state.vol },
  };
  const c: Ctx = { s, env, fx: [] };
  switch (event.type) {
    case "sync":
      onSync(c, event.scan);
      break;
    case "localRename":
      onLocalRename(c, event.from, event.to);
      break;
    case "snapshotResult":
      if (event.requestId === s.vol.requestId) onSnapshot(c, event.snapshot);
      break;
    case "pushResult":
      if (event.requestId === s.vol.requestId) onPushResult(c, event.results);
      break;
    case "pullResult":
      if (event.requestId === s.vol.requestId) onPullResult(c, event.entries, event.hasMore);
      break;
    case "networkError":
      if (event.requestId === s.vol.requestId) idle(s);
      break;
    case "written":
      onWritten(c, event.fileId, event.ok);
      break;
    case "renamed":
      onRenamed(c, event.fileId, event.to, event.ok);
      break;
    case "trashed":
      onTrashed(c, event.fileId, event.ok);
      break;
  }
  return { state: s, effects: [{ type: "persist" }, ...c.fx] };
}

// ---------- helpers ----------

const entries = (s: ClientState): Entry[] => Object.values(s.durable.index);
const caseInsensitive = (p: Platform) => p !== "linux";
const diskKey = (s: ClientState, path: string) =>
  caseInsensitive(s.config.platform) ? collisionKey(path) : path;
const local = (s: ClientState, path: string) => localPath(path, s.config.configDir);

function idle(s: ClientState): void {
  s.vol.phase = "idle";
  s.vol.requestId = null;
}

/** Why a server path can't be used on this device, or null. */
function unavailableReason(s: ClientState, path: string): string | null {
  const r = isRepresentable(local(s, path), s.config.platform);
  if (!r.ok) return r.reason;
  return classify(path, s.config.settings).excluded ? "excluded" : null;
}

/** The entry whose file occupies `path` on disk (or is being written there). */
function ownerOf(s: ClientState, path: string, except?: Entry): Entry | undefined {
  const key = diskKey(s, path);
  return entries(s).find(
    (e) =>
      e !== except &&
      (e.localHash !== null || e.pendingWrite !== null) &&
      diskKey(s, e.path) === key,
  );
}

function newLocalEntry(fileId: string, item: ScanItem): Entry {
  return {
    fileId,
    path: item.path,
    confirmed: false,
    remotePath: null,
    base: null,
    baseHash: null,
    head: null,
    headHash: null,
    headSeq: 0,
    pathSeq: 0,
    headDeleted: false,
    localHash: item.hash,
    size: item.size,
    mtime: item.mtime,
    materialized: true,
    pendingWrite: null,
    conflictId: null,
    unavailable: null,
    blocked: null,
    renaming: null,
  };
}

function remoteEntry(
  s: ClientState,
  r: {
    fileId: string;
    path: string;
    versionId: string;
    hash: string;
    size: number;
    mtime: number;
    seq: number;
  },
): Entry {
  return {
    fileId: r.fileId,
    path: r.path,
    confirmed: true,
    remotePath: r.path,
    base: null,
    baseHash: null,
    head: r.versionId,
    headHash: r.hash,
    headSeq: r.seq,
    pathSeq: r.seq,
    headDeleted: false,
    localHash: null,
    size: r.size,
    mtime: r.mtime,
    materialized: false,
    pendingWrite: null,
    conflictId: null,
    unavailable: unavailableReason(s, r.path),
    blocked: null,
    renaming: null,
  };
}

function adoptWrite(e: Entry): void {
  const w = e.pendingWrite!;
  e.localHash = w.hash;
  e.base = w.versionId;
  e.baseHash = w.hash;
  e.materialized = true;
  e.pendingWrite = null;
}

function write(c: Ctx, e: Entry): void {
  if (e.head === null || e.headHash === null) return;
  e.pendingWrite = { versionId: e.head, hash: e.headHash };
  c.fx.push({
    type: "write",
    fileId: e.fileId,
    path: local(c.s, e.path),
    hash: e.headHash,
    expect: e.localHash,
  });
}

function renameLocal(c: Ctx, e: Entry, to: string): void {
  c.fx.push({
    type: "rename",
    fileId: e.fileId,
    from: local(c.s, e.path),
    to: local(c.s, to),
    toPath: to,
  });
}

/** A free path next to `path` on this device: "Nota (1).md", "Nota (2).md"… */
function freeLocalSibling(s: ClientState, path: string, self: Entry): string {
  for (let n = 1; ; n++) {
    const p = conflictSiblingPath(path, n);
    const key = diskKey(s, p);
    if (!entries(s).some((e) => e !== self && diskKey(s, e.path) === key)) return p;
  }
}

/** Download what the server has and this device doesn't (and is allowed to have). */
function materialize(c: Ctx, e: Entry): void {
  if (!e.confirmed || e.materialized || e.pendingWrite || e.headDeleted || e.conflictId) return;
  // Not on disk here: it lives at its server path (a local rename of a lost write doesn't count).
  if (e.remotePath !== null) e.path = e.remotePath;
  e.unavailable = unavailableReason(c.s, e.path);
  if (e.unavailable || ownerOf(c.s, e.path, e)) return;
  write(c, e);
}

/** Remote deletion of an unmodified file: to the trash, never a hard delete (03 §6.4). */
function trashIfClean(c: Ctx, e: Entry): void {
  if (!e.headDeleted || e.conflictId || e.pendingWrite || e.localHash === null) return;
  if (e.localHash !== e.baseHash) return; // the edit wins: the next put resurrects it
  c.fx.push({ type: "trash", fileId: e.fileId, path: local(c.s, e.path), expect: e.localHash });
}

/** The server path changed: follow it, unless a local move is pending (first arrived wins, the server says). */
function followRemotePath(c: Ctx, e: Entry, path: string, seq: number | null): void {
  // `seq` null = authoritative now (a rejection telling the current server path).
  if (seq !== null) {
    if (seq <= e.pathSeq) return; // older than what this device already knows
    e.pathSeq = seq;
  }
  const previous = e.remotePath;
  e.remotePath = path;
  if (e.path === path) {
    // A rename issued for an older server path may still complete: follow again afterwards.
    e.renaming = e.renaming?.target ? { path, target: null } : null;
    return;
  }
  if (!e.materialized || (e.localHash === null && !e.pendingWrite)) {
    e.path = path;
    e.unavailable = unavailableReason(c.s, path);
    return;
  }
  // A local move is pending: the server decides (first arrived wins).
  if (previous !== null && e.path !== previous && !e.renaming) return;
  const reason = unavailableReason(c.s, path);
  if (reason) {
    // Can't live here under its new name (Z10): the local copy leaves once the server has it.
    e.unavailable = reason;
    e.renaming = null;
    retire(c, e);
    return;
  }
  e.unavailable = null;
  e.renaming = { path, target: null };
  follow(c, e);
}

/** Moves the local file to the server path, or next to it if something else is there on this device. */
function follow(c: Ctx, e: Entry): void {
  if (!e.renaming || e.renaming.target !== null) return; // nothing to do, or already issued
  if (e.localHash === null && !e.pendingWrite) {
    // Nothing on disk to move: it simply lives at the server path.
    e.path = e.renaming.path;
    e.renaming = null;
    return;
  }
  const want = e.renaming.path;
  const target = ownerOf(c.s, want, e) ? freeLocalSibling(c.s, want, e) : want;
  if (target === e.path) {
    e.renaming = null;
    return;
  }
  e.renaming.target = target;
  renameLocal(c, e, target);
}

/** The file now is at `to` on disk. A follow is done only if this was the rename issued for it. */
function renameDone(e: Entry, to: string): void {
  e.path = to;
  if (e.renaming?.target === to) e.renaming = null;
}

// ---------- local side ----------

function onSync(c: Ctx, scan: ScanItem[]): void {
  const { s } = c;
  for (const e of entries(s)) e.blocked = null;
  applyScan(c, scan);
  if (s.vol.phase !== "idle") return;
  if (!s.durable.joined) {
    startSnapshot(c);
    return;
  }
  for (const e of entries(s)) {
    follow(c, e);
    materialize(c, e);
    catchUp(c, e);
    retire(c, e);
    trashIfClean(c, e);
  }
  if (!startPush(c)) startPull(c);
}

function applyScan(c: Ctx, scan: ScanItem[]): void {
  const { s } = c;
  const owners = new Map<string, Entry>();
  const byTarget = new Map<string, Entry>();
  const holders: Entry[] = [];
  for (const e of entries(s)) {
    if (e.localHash === null && !e.pendingWrite) continue;
    holders.push(e);
    owners.set(diskKey(s, e.path), e);
    // A rename issued before a crash may have happened on disk without its event.
    if (e.renaming?.target) byTarget.set(diskKey(s, e.renaming.target), e);
  }
  const seen = new Set<Entry>();
  for (const item of scan) {
    if (classify(item.path, s.config.settings).excluded) continue;
    const moved = owners.has(diskKey(s, item.path))
      ? undefined
      : byTarget.get(diskKey(s, item.path));
    if (moved && !seen.has(moved)) {
      seen.add(moved);
      renameDone(moved, item.path);
      if (moved.localHash !== item.hash) moved.localHash = item.hash;
      continue;
    }
    const e = owners.get(diskKey(s, item.path));
    if (e?.pendingWrite) {
      if (item.hash === e.pendingWrite.hash) {
        adoptWrite(e); // the write happened; its event was lost (crash)
        e.path = item.path;
        seen.add(e);
        continue;
      }
      e.pendingWrite = null;
      if (e.localHash === null) {
        // An untracked file where a remote one was going: both are kept.
        const id = c.env.newId();
        s.durable.index[id] = newLocalEntry(id, item);
        continue;
      }
    }
    if (e) {
      seen.add(e);
      e.path = item.path;
      if (e.localHash !== item.hash) {
        e.localHash = item.hash;
        e.size = item.size;
        e.mtime = item.mtime;
      }
      continue;
    }
    const id = c.env.newId();
    s.durable.index[id] = newLocalEntry(id, item);
  }
  // Every entry that thought it had a file, not only the map's winners: two entries can't share a path.
  for (const e of holders) {
    // Seen at its old path: an issued rename did not happen, retry it.
    if (seen.has(e) && e.renaming?.target && e.path !== e.renaming.target) e.renaming.target = null;
    if (seen.has(e)) continue;
    if (e.pendingWrite) {
      e.pendingWrite = null; // the write never happened
      continue;
    }
    e.localHash = null;
    // Created and deleted here before the server ever knew it.
    if (!e.confirmed && !s.durable.sent.some((op) => op.fileId === e.fileId))
      delete s.durable.index[e.fileId];
  }
}

function onLocalRename(c: Ctx, from: string, to: string): void {
  const e = ownerOf(c.s, from);
  if (!e) return;
  e.renaming = null; // the user's move wins over following the server
  // The rename succeeded, so whatever the index thought was at `to` is no longer on disk.
  const previous = ownerOf(c.s, to, e);
  if (previous) {
    previous.localHash = null;
    if (!previous.confirmed && !c.s.durable.sent.some((op) => op.fileId === previous.fileId))
      delete c.s.durable.index[previous.fileId];
  }
  if (classify(to, c.s.config.settings).excluded) e.localHash = null;
  else e.path = to;
}

// ---------- push ----------

/** Ops for every difference between this device and the server (Z8): one per file, deletes → moves → puts. */
export function nextOps(s: ClientState, env: ClientEnv): Op[] {
  if (s.durable.sent.length > 0) return s.durable.sent;
  const deletes: Op[] = [];
  const moves: Op[] = [];
  const puts: Op[] = [];
  for (const e of entries(s)) {
    if (e.conflictId || e.pendingWrite || e.blocked) continue;
    if (!e.confirmed) {
      if (e.localHash !== null)
        puts.push({
          type: "put",
          opId: env.newId(),
          fileId: e.fileId,
          versionId: env.newId(),
          path: e.path,
          baseVersionId: null,
          contentHash: e.localHash,
          size: e.size,
          mtime: e.mtime,
        });
      continue;
    }
    if (e.localHash === null) {
      if (e.materialized && !e.headDeleted && e.base !== null)
        deletes.push({
          type: "delete",
          opId: env.newId(),
          fileId: e.fileId,
          baseVersionId: e.base,
        });
      continue;
    }
    // Deleted on the server: only an edit counts (it resurrects the file, C-06); a move would be refused.
    const movable = !e.headDeleted;
    if (
      movable &&
      e.remotePath !== null &&
      e.path !== e.remotePath &&
      !e.unavailable &&
      !e.renaming
    )
      moves.push({
        type: "move",
        opId: env.newId(),
        fileId: e.fileId,
        fromPath: e.remotePath,
        toPath: e.path,
      });
    else if (e.localHash !== e.baseHash)
      puts.push({
        type: "put",
        opId: env.newId(),
        fileId: e.fileId,
        versionId: env.newId(),
        path: e.path,
        baseVersionId: e.base,
        contentHash: e.localHash,
        size: e.size,
        mtime: e.mtime,
      });
  }
  return [...deletes, ...moves, ...puts].slice(0, s.config.batchSize);
}

function startPush(c: Ctx): boolean {
  const { s } = c;
  const ops = nextOps(s, c.env);
  if (ops.length === 0) return false;
  s.durable.sent = ops;
  s.vol.phase = "pushing";
  s.vol.requestId = c.env.newId();
  const hashes = [...new Set(ops.flatMap((op) => (op.type === "put" ? [op.contentHash] : [])))];
  c.fx.push({ type: "push", requestId: s.vol.requestId, ops, hashes });
  return true;
}

function onPushResult(c: Ctx, results: OpResult[]): void {
  const { s } = c;
  const sent = s.durable.sent;
  s.durable.sent = [];
  idle(s);
  sent.forEach((op, i) => {
    const r = results[i];
    if (r) applyResult(c, op, r);
  });
  if (!startPush(c)) startPull(c);
}

function applyResult(c: Ctx, op: Op, r: OpResult): void {
  const res = r.status === "duplicate" ? r.original : r;
  const e = c.s.durable.index[op.fileId];
  if (!e) return;
  if (res.status === "accepted") onAccepted(c, e, op, res);
  else if (res.status === "conflict") {
    e.conflictId = res.conflictId;
    c.fx.push({ type: "notify", kind: "conflict", fileId: e.fileId });
  } else onRejected(c, e, op, res);
}

/** Idempotent: the same result may arrive from the response and from the journal. */
function onAccepted(c: Ctx, e: Entry, op: Op, res: Pick<AcceptedResult, "seq" | "path">): void {
  const wasConfirmed = e.confirmed;
  e.confirmed = true;
  if (op.type === "put") {
    e.base = op.versionId;
    e.baseHash = op.contentHash;
    if (res.seq >= e.headSeq) {
      e.head = op.versionId;
      e.headHash = op.contentHash;
      e.headSeq = res.seq;
      e.headDeleted = false;
    }
    if (!wasConfirmed || e.remotePath === null) e.remotePath = op.path;
    if (res.path !== e.remotePath) followRemotePath(c, e, res.path, res.seq);
    else e.pathSeq = Math.max(e.pathSeq, res.seq);
  } else if (op.type === "move") {
    if (res.seq >= e.pathSeq) {
      e.remotePath = res.path;
      e.pathSeq = res.seq;
    }
  } else if (op.type === "delete") {
    if (res.seq >= e.headSeq) {
      e.headDeleted = true;
      e.headSeq = res.seq;
    }
    if (e.localHash === null) bury(e);
  }
}

/**
 * A deleted file stays in the index as an inert tombstone: it keeps the journal positions, so
 * older entries about it are recognised as stale (pruned with journal compaction, M2).
 */
function bury(e: Entry): void {
  e.renaming = null;
  if (e.remotePath !== null) e.path = e.remotePath;
  e.localHash = null;
  e.materialized = false;
  e.pendingWrite = null;
  e.base = null;
  e.baseHash = null;
}

function onRejected(c: Ctx, e: Entry, op: Op, res: RejectedResult): void {
  e.blocked = res.code;
  switch (res.code) {
    case "moved_elsewhere":
      if (res.path !== undefined) {
        e.remotePath = res.path;
        e.renaming = { path: res.path, target: null };
        follow(c, e);
      }
      return;
    case "path_taken":
      if (op.type === "move") {
        renameLocal(c, e, freeLocalSibling(c.s, op.toPath, e));
        c.fx.push({ type: "notify", kind: "renamed", fileId: e.fileId });
      }
      return;
    case "modified_since":
      // Changed elsewhere: the deletion doesn't happen, the current version comes back (03 §5.3).
      e.materialized = false;
      e.base = null;
      e.baseHash = null;
      e.blocked = null;
      c.fx.push({ type: "notify", kind: "restored", fileId: e.fileId });
      materialize(c, e);
      return;
    case "not_found":
      // move/delete of a file deleted on the server: the journal tells what happened, nothing to undo.
      if (op.type !== "put") return;
      e.confirmed = false;
      e.remotePath = null;
      e.base = null;
      e.baseHash = null;
      if (e.localHash === null) delete c.s.durable.index[e.fileId];
      return;
    case "blob_missing":
      return; // retried at the next cycle with the content on disk then
    default:
      c.fx.push({ type: "notify", kind: "blocked", fileId: e.fileId, code: res.code });
  }
}

// ---------- pull ----------

function startSnapshot(c: Ctx): void {
  c.s.vol.phase = "joining";
  c.s.vol.requestId = c.env.newId();
  c.fx.push({ type: "snapshot", requestId: c.s.vol.requestId });
}

function startPull(c: Ctx): boolean {
  const { s } = c;
  if (s.vol.phase !== "idle" || s.vol.stopped) return false;
  s.vol.phase = "pulling";
  s.vol.requestId = c.env.newId();
  c.fx.push({ type: "pull", requestId: s.vol.requestId, after: s.durable.cursor });
  return true;
}

function onPullResult(c: Ctx, journal: JournalEntry[], hasMore: boolean): void {
  const { s } = c;
  idle(s);
  const before = s.durable.cursor;
  for (const entry of journal) {
    if (entry.seq <= s.durable.cursor) continue;
    if (!applyEntry(c, entry)) break;
    s.durable.cursor = entry.seq;
  }
  if (s.durable.cursor > before) c.fx.push({ type: "ack", seq: s.durable.cursor });
  if (hasMore && !s.vol.stopped) startPull(c);
}

/** 03 §6.4. Returns false when sync must stop (unknown, non-ignorable entry). */
function applyEntry(c: Ctx, entry: JournalEntry): boolean {
  const { s } = c;
  const own =
    entry.opId === undefined ? undefined : s.durable.sent.find((op) => op.opId === entry.opId);
  if (own) {
    // Our op went through but its response was lost: the journal tells us. Still resent (duplicate).
    const e = s.durable.index[own.fileId];
    if (e && entry.type === "conflict_opened" && entry.conflictId !== undefined)
      e.conflictId = entry.conflictId;
    else if (e) onAccepted(c, e, own, { seq: entry.seq, path: entry.path });
    return true;
  }
  // This device's own entries go through the same rules: the journal positions make them no-ops
  // when the index already reflects them, and restore them when it doesn't.
  if (entry.kind === "folder") return true; // folders: M1d (Z9)
  switch (entry.type) {
    case "file_put":
    case "file_restored":
      onRemotePut(c, entry);
      return true;
    case "file_moved": {
      const e = s.durable.index[entry.fileId];
      if (e) followRemotePath(c, e, entry.path, entry.seq);
      return true;
    }
    case "file_deleted":
      onRemoteDelete(c, entry);
      return true;
    case "folder_created":
    case "folder_deleted":
    case "conflict_opened":
    case "conflict_resolved":
    case "vault_settings_changed":
      return true;
    default:
      if (entry.ignorable) return true;
      s.vol.stopped = "update_required";
      c.fx.push({ type: "notify", kind: "update_required" });
      return false;
  }
}

function onRemotePut(c: Ctx, entry: JournalEntry): void {
  const { s } = c;
  if (entry.versionId === undefined || entry.contentHash === undefined) return;
  let e = s.durable.index[entry.fileId];
  if (!e) {
    e = remoteEntry(s, {
      fileId: entry.fileId,
      path: entry.path,
      versionId: entry.versionId,
      hash: entry.contentHash,
      size: entry.size ?? 0,
      mtime: entry.mtime ?? 0,
      seq: entry.seq,
    });
    s.durable.index[e.fileId] = e;
    materialize(c, e);
    return;
  }
  e.confirmed = true; // the server knows it, whatever this device thought
  if (entry.seq > e.headSeq) {
    e.head = entry.versionId;
    e.headHash = entry.contentHash;
    e.headSeq = entry.seq;
    e.headDeleted = false;
  }
  if (e.remotePath !== entry.path) followRemotePath(c, e, entry.path, entry.seq);
  if (e.conflictId || e.pendingWrite) return;
  if (!e.materialized) {
    materialize(c, e);
    return;
  }
  catchUp(c, e);
}

/**
 * Unmodified here and the server has a newer version → write it. Local edits wait: their put
 * meets the conflict on the server (no overwrite).
 */
function catchUp(c: Ctx, e: Entry): void {
  if (!e.materialized || e.pendingWrite || e.conflictId || e.headDeleted || e.localHash === null)
    return;
  if (e.unavailable) return;
  if (e.localHash === e.baseHash && e.headHash !== null && e.headHash !== e.localHash) write(c, e);
}

function onRemoteDelete(c: Ctx, entry: JournalEntry): void {
  const e = c.s.durable.index[entry.fileId];
  // Stale: this device already knows a later state (e.g. its own edit resurrected the file).
  if (!e || entry.seq <= e.headSeq) return;
  e.headDeleted = true;
  e.headSeq = entry.seq;
  if (e.conflictId) return;
  if (!e.materialized || (e.localHash === null && !e.pendingWrite)) {
    bury(e);
    return;
  }
  trashIfClean(c, e);
}

// ---------- file effects ----------

function onWritten(c: Ctx, fileId: string, ok: boolean): void {
  const e = c.s.durable.index[fileId];
  if (!e?.pendingWrite) return;
  if (ok) {
    adoptWrite(e);
    trashIfClean(c, e);
    catchUp(c, e); // a newer version may have arrived while writing
  } else e.pendingWrite = null; // the file changed meanwhile: the next scan sees the user's content
}

function onRenamed(c: Ctx, fileId: string, to: string, ok: boolean): void {
  const e = c.s.durable.index[fileId];
  if (!e) return;
  if (!ok) {
    if (e.renaming) e.renaming.target = null; // retried at the next cycle
    return;
  }
  renameDone(e, to);
}

/**
 * Z10: a file moved elsewhere to a name this device can't use goes to the local trash, but only
 * once its content is on the server; local edits are pushed first. `materialized` is cleared
 * before trashing, so the missing file is never taken for a deletion to send.
 */
function retire(c: Ctx, e: Entry): void {
  if (!e.unavailable || !e.materialized || e.pendingWrite || e.conflictId || e.localHash === null)
    return;
  if (e.localHash !== e.baseHash) return;
  e.materialized = false;
  c.fx.push({ type: "trash", fileId: e.fileId, path: local(c.s, e.path), expect: e.localHash });
}

function onTrashed(c: Ctx, fileId: string, ok: boolean): void {
  const e = c.s.durable.index[fileId];
  if (!e) return;
  if (!ok) {
    if (e.unavailable && e.localHash !== null) e.materialized = true; // changed meanwhile: sync it first
    return;
  }
  if (e.headDeleted) {
    bury(e);
    return;
  }
  // Resurrected on the server while being trashed here: download it again.
  e.localHash = null;
  e.materialized = false;
  e.base = null;
  e.baseHash = null;
  materialize(c, e);
}

// ---------- joining (D-07, V-05) ----------

/** 03 §8.1 for a device without index: identical files align, different ones become conflicts, nothing is overwritten. */
function onSnapshot(c: Ctx, snap: Snapshot): void {
  const { s } = c;
  idle(s);
  const remote = new Map<string, Snapshot["files"][number]>();
  for (const f of snap.files)
    if (f.kind === "file" && f.versionId !== null && f.contentHash !== null)
      remote.set(diskKey(s, f.path), f);
  for (const e of entries(s)) {
    if (e.confirmed || e.localHash === null) continue;
    const r = remote.get(diskKey(s, e.path));
    if (!r || r.versionId === null || r.contentHash === null) continue;
    if (r.contentHash !== e.localHash) continue; // both kept: our put meets both_created
    remote.delete(diskKey(s, e.path));
    delete s.durable.index[e.fileId];
    const aligned = remoteEntry(s, {
      fileId: r.fileId,
      path: e.path,
      versionId: r.versionId,
      hash: r.contentHash,
      size: r.size,
      mtime: r.mtime,
      seq: snap.head,
    });
    Object.assign(aligned, {
      localHash: e.localHash,
      base: r.versionId,
      baseHash: r.contentHash,
      materialized: true,
      remotePath: r.path,
      unavailable: null,
    });
    s.durable.index[r.fileId] = aligned;
    if (e.path !== r.path) {
      aligned.renaming = { path: r.path, target: null };
      follow(c, aligned);
    }
  }
  for (const r of remote.values()) {
    if (r.versionId === null || r.contentHash === null) continue;
    const e = remoteEntry(s, {
      fileId: r.fileId,
      path: r.path,
      versionId: r.versionId,
      hash: r.contentHash,
      size: r.size,
      mtime: r.mtime,
      seq: snap.head,
    });
    s.durable.index[e.fileId] = e;
    materialize(c, e);
  }
  s.durable.cursor = snap.head;
  s.durable.joined = true;
  if (!startPush(c)) startPull(c);
}
