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
  /**
   * Its local path is excluded by this device's settings (C1): the file stays as it is and this
   * device sends nothing about it, never a deletion. Lifting the exclusion resumes sync.
   */
  ignored: boolean;
  /** A trash was issued expecting this content; the next scan tells whether it happened. */
  trashing: string | null;
}

/**
 * One folder as this device knows it (Z9). Kept apart from files: the server stores paths flat,
 * so a folder only needs to exist, move and go away; files never depend on it.
 */
export interface FolderEntry {
  fileId: string;
  /** Canonical path on this device. */
  path: string;
  confirmed: boolean;
  remotePath: string | null;
  /** Journal position of the latest server state known (created, moved, deleted). */
  seq: number;
  /** Deleted on the server. */
  deleted: boolean;
  /** On disk at the last scan (or created by us since). */
  onDisk: boolean;
  /** Was on disk for this entry: only then a missing folder means "deleted here". */
  materialized: boolean;
  /** Effect in flight, persisted before it (write-ahead). */
  pending: "mkdir" | "rmdir" | null;
  /** Old local paths left behind by remote moves: removed once empty (their files move one by one). */
  leftovers: string[];
  /**
   * Merged by the server into this other folder ("d" and "D" on a case-sensitive disk): nothing to
   * send while that folder lives there; a real folder again once it moves or goes.
   */
  aliasOf?: string | null;
  blocked: ErrorCode | null;
}

export interface Durable {
  index: Record<string, Entry>;
  /** Absent in states saved before M1d. */
  folders: Record<string, FolderEntry>;
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
  /**
   * Start of a cycle (03 §8): full scan of the vault, then push and pull. `folders` = canonical
   * folder paths on disk; absent = this shell doesn't report folders (folder state untouched).
   */
  | { type: "sync"; scan: ScanItem[]; folders?: string[] }
  | { type: "folderDone"; fileId: string; op: "mkdir" | "rmdir" | "leftover"; ok: boolean }
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
  /** The pull's cursor is behind the compacted journal (03 §6.3): start again from the snapshot. */
  | { type: "resync"; requestId: string }
  /** `hash` = the content of the write effect this completes. */
  | { type: "written"; fileId: string; hash: string; ok: boolean }
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
  /** Create the folder (and its parents); a folder already there is fine. */
  | { type: "mkdir"; fileId: string; path: string }
  /** Remove the folder only if empty; `leftover` = an old path left by a remote move. */
  | { type: "rmdir"; fileId: string; path: string; leftover: boolean }
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
    durable: { index: {}, folders: {}, sent: [], cursor: 0, joined: false },
    vol: { phase: "idle", requestId: null, stopped: null },
  };
}

/** Exponential backoff with jitter, 1 s to 5 min (03 §8). `random` in [0, 1). */
export function retryDelay(attempt: number, random: number): number {
  // Jitter in [base/2, base]: it stays even at the 5-minute cap, so clients don't retry in lockstep.
  const base = Math.min(300_000, 1000 * 2 ** Math.min(attempt, 20));
  return Math.max(1000, Math.round(base * (0.5 + random / 2)));
}

/**
 * The whole client as a pure reducer. `persist` is always the first effect: the shell saves
 * `durable` before doing anything else (S-04, write-ahead).
 *
 * Shell contract: file effects (`write`, `rename`, `trash`) are performed in order and each
 * reports its event; a `sync` (with its scan) is only reported once every file effect issued so
 * far has completed. Network events may arrive at any time. After a crash, in-flight effects may
 * or may not have happened: the next scan tells.
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
  // States saved before M1d have no folders.
  if (!(s.durable as Partial<Durable>).folders) s.durable.folders = {};
  const c: Ctx = { s, env, fx: [] };
  switch (event.type) {
    case "sync":
      onSync(c, event.scan, event.folders);
      break;
    case "folderDone":
      onFolderDone(c, event.fileId, event.op, event.ok);
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
    case "resync":
      if (event.requestId === s.vol.requestId && s.vol.phase === "pulling") {
        idle(s);
        startSnapshot(c);
      }
      break;
    case "written":
      onWritten(c, event.fileId, event.hash, event.ok);
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
const excludedHere = (s: ClientState, path: string) =>
  classify(path, s.config.settings, caseInsensitive(s.config.platform)).excluded;

function idle(s: ClientState): void {
  s.vol.phase = "idle";
  s.vol.requestId = null;
}

/** Why a server path can't be used on this device, or null. */
function unavailableReason(s: ClientState, path: string): string | null {
  const r = isRepresentable(local(s, path), s.config.platform);
  if (!r.ok) return r.reason;
  return excludedHere(s, path) ? "excluded" : null;
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
    ignored: false,
    trashing: null,
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
    ignored: false,
    trashing: null,
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
  if (e.trashing || e.ignored) return;
  // Not on disk here: it lives at its server path (a local rename of a lost write doesn't count).
  if (e.remotePath !== null) e.path = e.remotePath;
  e.unavailable = unavailableReason(c.s, e.path);
  if (e.unavailable || ownerOf(c.s, e.path, e)) return;
  write(c, e);
}

/** Remote deletion of an unmodified file: to the trash, never a hard delete (03 §6.4). */
function trashIfClean(c: Ctx, e: Entry): void {
  if (!e.headDeleted || e.conflictId || e.pendingWrite || e.localHash === null) return;
  if (e.localHash !== e.baseHash || e.trashing || e.ignored) return; // the edit wins: the next put resurrects it
  trash(c, e);
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
  if (!e.pendingWrite && (!e.materialized || e.localHash === null)) {
    e.path = path;
    e.unavailable = unavailableReason(c.s, path);
    return;
  }
  if (e.ignored) return; // excluded here: the local file is left alone
  // A local move is pending: the server decides (first arrived wins). A rejection (seq null) has decided.
  if (seq !== null && previous !== null && e.path !== previous && !e.renaming) return;
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
  // A write in progress targets the old path: move only once it is done.
  if (e.trashing || e.ignored || e.pendingWrite) return;
  if (e.localHash === null && !e.pendingWrite) {
    // Nothing on disk to move: it simply lives at the server path.
    e.path = e.renaming.path;
    e.renaming = null;
    return;
  }
  const want = e.renaming.path;
  // Settings may have changed since the move arrived: re-check that the target can be used here.
  const reason = unavailableReason(c.s, want);
  if (reason) {
    e.unavailable = reason;
    e.renaming = null;
    retire(c, e);
    return;
  }
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

function onSync(c: Ctx, scan: ScanItem[], folderScan: string[] | undefined): void {
  const { s } = c;
  for (const e of entries(s)) e.blocked = null;
  for (const f of folderList(s)) f.blocked = null;
  applyScan(c, scan);
  if (folderScan) applyFolderScan(c, folderScan);
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
  // After the file effects above: a folder is removed once its files have left.
  pruneLeftovers(s);
  for (const f of folderList(s)) {
    materializeFolder(c, f);
    removeFolder(c, f);
    f.leftovers = f.leftovers.filter((p) => {
      const prefix = `${diskKey(s, p)}/`;
      const inside = entries(s).filter(
        (e) =>
          (e.localHash !== null || e.pendingWrite !== null) &&
          diskKey(s, e.path).startsWith(prefix),
      );
      const folders = folderList(s).filter(
        (g) => g.onDisk && !g.deleted && diskKey(s, g.path).startsWith(prefix),
      );
      if (inside.length === 0 && folders.length === 0) {
        c.fx.push({ type: "rmdir", fileId: f.fileId, path: local(s, p), leftover: true });
        return true;
      }
      // Its files are still on their way to the new folder: wait for them.
      if (folders.length === 0 && inside.some((e) => e.renaming)) return true;
      // It holds files of this device that stay: a folder of its own again.
      const id = c.env.newId();
      const g = newFolder(id, p, false);
      g.onDisk = true;
      g.materialized = true;
      s.durable.folders[id] = g;
      return false;
    });
  }
  if (!startPush(c)) startPull(c);
}

// ---------- folders (Z9) ----------

const folderList = (s: ClientState): FolderEntry[] => Object.values(s.durable.folders);

/** Folders never synced here: the configuration folder (its files carry their paths) and excluded areas. */
export function folderExcluded(path: string, settings: SyncSettings, ci: boolean): boolean {
  if (path === "{config}" || path.startsWith("{config}/")) return true;
  return classify(path, settings, ci).excluded || classify(`${path}/_`, settings, ci).excluded;
}

function folderSkipped(s: ClientState, path: string): boolean {
  if (folderExcluded(path, s.config.settings, caseInsensitive(s.config.platform))) return true;
  return !isRepresentable(local(s, path), s.config.platform).ok;
}

function newFolder(fileId: string, path: string, confirmed: boolean): FolderEntry {
  return {
    fileId,
    path,
    confirmed,
    remotePath: confirmed ? path : null,
    seq: 0,
    deleted: false,
    onDisk: false,
    materialized: false,
    pending: null,
    leftovers: [],
    aliasOf: null,
    blocked: null,
  };
}

/** Something on disk below `path`, as far as this device knows. */
function hasLocalDescendants(s: ClientState, path: string): boolean {
  const prefix = `${diskKey(s, path)}/`;
  return (
    entries(s).some(
      (e) =>
        (e.localHash !== null || e.pendingWrite !== null) && diskKey(s, e.path).startsWith(prefix),
    ) || folderList(s).some((f) => f.onDisk && diskKey(s, f.path).startsWith(prefix))
  );
}

/** Another live folder is at this path on this disk: a leftover there is no longer ours to remove. */
function pruneLeftovers(s: ClientState): void {
  const list = folderList(s);
  for (const f of list)
    f.leftovers = f.leftovers.filter(
      (p) =>
        !folderSkipped(s, p) &&
        !list.some((g) => (g === f || !g.deleted) && diskKey(s, g.path) === diskKey(s, p)),
    );
}

const inFlight = (s: ClientState, fileId: string) =>
  s.durable.sent.some((op) => op.fileId === fileId);

function applyFolderScan(c: Ctx, paths: string[]): void {
  const { s } = c;
  pruneLeftovers(s);
  const list = folderList(s);
  const onDisk = new Set(paths.map((p) => diskKey(s, p)));
  const seen = new Set<FolderEntry>();
  for (const path of paths) {
    if (folderSkipped(s, path)) continue;
    const key = diskKey(s, path);
    // Left behind by a remote move: on its way out, not a new folder.
    if (list.some((f) => f.leftovers.some((p) => diskKey(s, p) === key))) continue;
    // A tombstone isn't reused: a folder made again at that path is a new one.
    const matches = list.filter(
      (f) => diskKey(s, f.path) === key && !(f.deleted && !f.onDisk && !f.pending),
    );
    if (matches.length > 0) {
      for (const f of matches) {
        f.onDisk = true;
        f.materialized = true;
        f.path = path;
        seen.add(f);
      }
      continue;
    }
    const id = c.env.newId();
    const f = newFolder(id, path, false);
    f.onDisk = true;
    f.materialized = true;
    s.durable.folders[id] = f;
    list.push(f);
    seen.add(f);
  }
  for (const f of list) {
    f.leftovers = f.leftovers.filter((p) => onDisk.has(diskKey(s, p)));
    if (seen.has(f)) {
      // A mkdir happened (its event was lost) or an rmdir didn't (the folder wasn't empty).
      f.pending = null;
      continue;
    }
    if (f.pending === "mkdir") {
      f.pending = null; // didn't happen: retried
      continue;
    }
    if (f.pending === "rmdir") {
      f.pending = null; // happened; its event was lost
      f.onDisk = false;
      f.materialized = false;
      continue;
    }
    if (!f.onDisk || folderSkipped(s, f.path)) continue; // excluded here: never a deletion
    f.onDisk = false;
    // Made and removed here before the server ever knew it.
    if (!f.confirmed && !inFlight(s, f.fileId)) delete s.durable.folders[f.fileId];
  }
}

/** Create here a folder the server has and this device doesn't. */
function materializeFolder(c: Ctx, f: FolderEntry): void {
  if (!f.confirmed || f.deleted || f.onDisk || f.materialized || f.pending) return;
  if (folderSkipped(c.s, f.path)) return;
  f.pending = "mkdir";
  c.fx.push({ type: "mkdir", fileId: f.fileId, path: local(c.s, f.path) });
}

/** Deleted on the server: removed here once empty; with files of this device inside it comes back. */
function removeFolder(c: Ctx, f: FolderEntry): void {
  if (!f.deleted || !f.onDisk || f.pending || hasLocalDescendants(c.s, f.path)) return;
  if (folderSkipped(c.s, f.path)) return; // excluded here: left alone
  f.pending = "rmdir";
  c.fx.push({ type: "rmdir", fileId: f.fileId, path: local(c.s, f.path), leftover: false });
}

function onFolderDone(
  c: Ctx,
  fileId: string,
  op: "mkdir" | "rmdir" | "leftover",
  ok: boolean,
): void {
  const f = c.s.durable.folders[fileId];
  if (!f) return;
  if (op === "leftover") return; // the next scan tells whether it's gone
  if (f.pending !== op) return;
  f.pending = null;
  if (!ok) return; // retried at the next cycle
  f.onDisk = op === "mkdir";
  f.materialized = op === "mkdir";
}

/** A folder moved on disk by the user, with everything inside it (the server keeps paths flat). */
function renameFolderLocally(c: Ctx, from: string, to: string): void {
  const { s } = c;
  const key = diskKey(s, from);
  // The files move with the folder even if this device doesn't track the folder itself yet.
  const f = folderList(s).find((x) => x.onDisk && diskKey(s, x.path) === key) ?? null;
  const prefix = `${key}/`;
  const moved = (p: string) => to + p.slice(from.length);
  for (const e of entries(s))
    if (
      (e.localHash !== null || e.pendingWrite !== null) &&
      diskKey(s, e.path).startsWith(prefix)
    ) {
      e.path = moved(e.path);
      e.renaming = null;
      e.ignored = excludedHere(s, e.path);
    }
  for (const g of folderList(s))
    if (g.onDisk && (g === f || diskKey(s, g.path).startsWith(prefix))) {
      const to = moved(g.path);
      if (folderSkipped(s, to)) {
        // Into an area this device doesn't sync: gone from here (a folder holds no content; the
        // server refuses the deletion while files are still inside it).
        g.onDisk = false;
        continue;
      }
      g.path = to;
    }
}

/** Folder ops: deletes (deepest first), moves and mkdirs (shallowest first). */
function nextFolderOps(s: ClientState, env: ClientEnv) {
  const depth = (p: string) => p.split("/").length;
  const del: { op: Op; d: number }[] = [];
  const mov: { op: Op; d: number }[] = [];
  const mk: { op: Op; d: number }[] = [];
  for (const f of folderList(s)) {
    if (f.pending || f.blocked || folderSkipped(s, f.path)) continue;
    const d = depth(f.path);
    if (f.onDisk) {
      if (!f.confirmed || (f.deleted && hasLocalDescendants(s, f.path)))
        mk.push({ op: { type: "mkdir", opId: env.newId(), fileId: f.fileId, path: f.path }, d });
      else if (
        !f.deleted &&
        f.remotePath !== null &&
        diskKey(s, f.path) !== diskKey(s, f.remotePath)
      )
        mov.push({
          op: {
            type: "move",
            opId: env.newId(),
            fileId: f.fileId,
            fromPath: f.remotePath,
            toPath: f.path,
          },
          d,
        });
    } else if (f.confirmed && !f.deleted && f.materialized && !hasLocalDescendants(s, f.path))
      del.push({
        op: { type: "delete", opId: env.newId(), fileId: f.fileId, baseVersionId: null },
        d,
      });
  }
  const ops = (xs: { op: Op; d: number }[], dir: 1 | -1) =>
    xs.sort((a, b) => dir * (a.d - b.d)).map((x) => x.op);
  return { deletes: ops(del, -1), moves: ops(mov, 1), mkdirs: ops(mk, 1) };
}

const isFolderOp = (s: ClientState, op: Op) =>
  op.type === "mkdir" || (op.type !== "put" && s.durable.folders[op.fileId] !== undefined);

function onFolderAccepted(
  c: Ctx,
  op: Op,
  res: Pick<AcceptedResult, "seq" | "path" | "fileId">,
): void {
  const { s } = c;
  let f = s.durable.folders[op.fileId];
  if (op.type === "mkdir") {
    const existing = s.durable.folders[res.fileId];
    if (
      f &&
      res.fileId !== op.fileId &&
      diskKey(s, f.path) !== diskKey(s, res.path) &&
      collisionKey(f.path) !== collisionKey(res.path)
    )
      // Moved here since the mkdir left: still a new folder, sent again with its new path.
      return;
    if (f && res.fileId !== op.fileId && diskKey(s, f.path) !== diskKey(s, res.path)) {
      // The same folder for the server ("d" and "D"), two on this case-sensitive disk: this one
      // stays as it is and has nothing more to send (its files meet on the server as files do).
      f.confirmed = true;
      f.deleted = false;
      f.remotePath = f.path;
      f.seq = Math.max(f.seq, res.seq);
      f.aliasOf = res.fileId;
      return;
    }
    if (f && res.fileId !== op.fileId) {
      // Merged with a folder the server already had (03 §9.4): this device adopts its id.
      delete s.durable.folders[op.fileId];
      if (existing) {
        if (diskKey(s, existing.path) !== diskKey(s, f.path)) {
          // It thought itself elsewhere (an area excluded since): it is the folder on disk here.
          existing.path = f.path;
          existing.onDisk = f.onDisk;
          existing.materialized = f.materialized;
          existing.leftovers = [];
        }
        existing.onDisk ||= f.onDisk;
        existing.materialized ||= f.materialized;
        existing.confirmed = true;
        existing.deleted = false;
        existing.remotePath ??= res.path;
        return;
      }
      f = { ...f, fileId: res.fileId };
      s.durable.folders[res.fileId] = f;
    }
    f ??= existing;
    if (!f) return;
    f.confirmed = true;
    f.deleted = false;
    if (res.seq >= f.seq) {
      f.remotePath = res.path;
      f.seq = res.seq;
    }
    return;
  }
  if (!f) return;
  if (op.type === "move") {
    if (res.seq >= f.seq) {
      f.remotePath = res.path;
      f.seq = res.seq;
    }
  } else if (op.type === "delete") {
    // Defensive, as for files: an older result never undoes a newer state already known.
    if (res.seq < f.seq) return;
    f.deleted = true;
    f.seq = res.seq;
    if (!f.onDisk) f.materialized = false;
  }
}

function onFolderRejected(c: Ctx, op: Op, res: RejectedResult): void {
  const f = c.s.durable.folders[op.fileId];
  if (!f) return;
  f.blocked = res.code;
  switch (res.code) {
    case "modified_since":
      // The server still has files inside (changed or unknown here): the folder comes back.
      f.blocked = null;
      f.materialized = false;
      materializeFolder(c, f);
      return;
    case "not_found":
      // Already deleted on the server: with files of this device inside, a mkdir brings it back.
      f.blocked = null;
      f.deleted = true;
      if (!f.onDisk) f.materialized = false;
      return;
    case "moved_elsewhere":
      // Moved elsewhere first: at the next cycle this device moves it again from there.
      if (res.path !== undefined) f.remotePath = res.path;
      return;
    case "path_taken":
      if (op.type === "move" && f.remotePath !== null) {
        // Moved here onto a folder the server already has: they become one. The old one is gone
        // from this device (the server refuses the deletion while files are still inside it).
        f.blocked = null;
        f.path = f.remotePath;
        f.onDisk = false;
        return;
      }
      c.fx.push({ type: "notify", kind: "blocked", fileId: f.fileId, code: res.code });
      return;
    default:
      c.fx.push({ type: "notify", kind: "blocked", fileId: f.fileId, code: res.code });
  }
}

/** Journal entries about folders (03 §6.4). */
function onRemoteFolder(c: Ctx, entry: JournalEntry): void {
  const { s } = c;
  const f = s.durable.folders[entry.fileId];
  if (entry.type === "file_moved" || entry.type === "folder_deleted")
    for (const a of folderList(s))
      if (a.aliasOf === entry.fileId) {
        // Its twin moved or went: this folder needs its own place on the server.
        a.aliasOf = null;
        a.confirmed = false;
        a.remotePath = null;
      }
  switch (entry.type) {
    case "folder_created": {
      if (!f) {
        const key = diskKey(s, entry.path);
        const mine = folderList(s).find((x) => !x.confirmed && diskKey(s, x.path) === key);
        const e = newFolder(entry.fileId, mine?.path ?? entry.path, true);
        e.remotePath = entry.path;
        e.seq = entry.seq;
        if (mine) {
          e.onDisk = mine.onDisk;
          e.materialized = mine.materialized;
          // With its mkdir in flight, the result merges it.
          if (!inFlight(s, mine.fileId)) delete s.durable.folders[mine.fileId];
        }
        s.durable.folders[e.fileId] = e;
        materializeFolder(c, e);
        return;
      }
      if (entry.seq <= f.seq) return;
      f.seq = entry.seq;
      f.confirmed = true;
      f.deleted = false;
      f.remotePath = entry.path;
      if (!f.onDisk && !f.pending) {
        f.path = entry.path;
        f.materialized = false;
        materializeFolder(c, f);
      }
      return;
    }
    case "file_moved": {
      if (!f || entry.seq <= f.seq) return;
      f.seq = entry.seq;
      const previous = f.remotePath;
      f.remotePath = entry.path;
      if (diskKey(s, f.path) === diskKey(s, entry.path)) return;
      if (!f.onDisk && !f.pending) {
        f.path = entry.path;
        f.materialized = false;
        materializeFolder(c, f);
        return;
      }
      // A local move is pending: the server decides (first arrived wins).
      if (previous !== null && diskKey(s, f.path) !== diskKey(s, previous)) return;
      if (f.pending) return;
      // Not a rename on disk: its files follow one by one, then the old folder goes once empty.
      f.leftovers.push(f.path);
      f.path = entry.path;
      f.onDisk = false;
      f.materialized = false;
      materializeFolder(c, f);
      return;
    }
    case "folder_deleted": {
      if (!f || entry.seq <= f.seq) return;
      f.seq = entry.seq;
      f.deleted = true;
      if (!f.onDisk) {
        f.materialized = false;
        return;
      }
      removeFolder(c, f);
      return;
    }
  }
}

function applyScan(c: Ctx, scan: ScanItem[]): void {
  const { s } = c;
  const owners = new Map<string, Entry>();
  const byTarget = new Map<string, Entry>();
  const holders: Entry[] = [];
  const unignored = new Set<Entry>();
  for (const e of entries(s)) {
    if (e.localHash === null && !e.pendingWrite) continue;
    // C1: excluded here by this device's settings → left alone, never a deletion.
    const excluded = excludedHere(s, e.path);
    if (excluded) {
      e.ignored = true;
      continue;
    }
    if (e.ignored) {
      e.ignored = false;
      unignored.add(e);
    }
    holders.push(e);
    owners.set(diskKey(s, e.path), e);
    // A rename issued before a crash may have happened on disk without its event.
    if (e.renaming?.target) byTarget.set(diskKey(s, e.renaming.target), e);
  }
  const seen = new Set<Entry>();
  for (const item of scan) {
    if (excludedHere(s, item.path)) continue;
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
    if (seen.has(e)) {
      // Still there: an issued trash did not happen (retried) or the user changed it (synced).
      if (e.trashing) e.trashing = null;
      continue;
    }
    if (e.pendingWrite) {
      e.pendingWrite = null; // the write never happened
      continue;
    }
    if (e.trashing) {
      trashDone(c, e);
      continue;
    }
    if (unignored.has(e)) {
      // Gone while excluded here: that says nothing about the server copy, download it again.
      e.localHash = null;
      e.materialized = false;
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
  if (!e) {
    renameFolderLocally(c, from, to);
    return;
  }
  e.renaming = null; // the user's move wins over following the server
  // The rename succeeded, so whatever the index thought was at `to` is no longer on disk.
  const previous = ownerOf(c.s, to, e);
  if (previous) {
    previous.localHash = null;
    if (!previous.confirmed && !c.s.durable.sent.some((op) => op.fileId === previous.fileId))
      delete c.s.durable.index[previous.fileId];
  }
  e.path = to;
  // Moved into an area excluded here: this device stops syncing it, the server copy stays (C1).
  e.ignored = excludedHere(c.s, to);
}

// ---------- push ----------

/** Ops for every difference between this device and the server (Z8): one per file, deletes → moves → puts. */
export function nextOps(s: ClientState, env: ClientEnv): Op[] {
  if (s.durable.sent.length > 0) return s.durable.sent;
  const deletes: Op[] = [];
  const moves: Op[] = [];
  const puts: Op[] = [];
  for (const e of entries(s)) {
    if (e.conflictId || e.pendingWrite || e.blocked || e.trashing || e.ignored) continue;
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
  // Files leave a folder before it goes; a moved folder before its files; folders before files.
  const f = nextFolderOps(s, env);
  return [...deletes, ...f.deletes, ...f.moves, ...moves, ...f.mkdirs, ...puts].slice(
    0,
    s.config.batchSize,
  );
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
  // Ops without a result keep their outcome unknown: resent identical (I2).
  s.durable.sent = sent.filter((_, i) => results[i] === undefined);
  idle(s);
  sent.forEach((op, i) => {
    const r = results[i];
    if (r) applyResult(c, op, r);
  });
  if (!startPush(c)) startPull(c);
}

function applyResult(c: Ctx, op: Op, r: OpResult): void {
  const res = r.status === "duplicate" ? r.original : r;
  if (isFolderOp(c.s, op)) {
    if (res.status === "accepted") onFolderAccepted(c, op, res);
    else if (res.status === "rejected") onFolderRejected(c, op, res);
    return;
  }
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
  // A write already issued is not cancelled: when it lands, the file is trashed (headDeleted).
  e.base = null;
  e.baseHash = null;
}

function onRejected(c: Ctx, e: Entry, op: Op, res: RejectedResult): void {
  e.blocked = res.code;
  switch (res.code) {
    case "moved_elsewhere":
      if (res.path !== undefined) followRemotePath(c, e, res.path, null);
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
  if (own && isFolderOp(s, own)) {
    onFolderAccepted(c, own, { seq: entry.seq, path: entry.path, fileId: entry.fileId });
    return true;
  }
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
  if (entry.kind === "folder") {
    onRemoteFolder(c, entry);
    return true;
  }
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
  if (!e.confirmed && entry.deviceId === s.config.deviceId) {
    // Our own put, whose response was lost: its version is what our local content derives from.
    e.base = entry.versionId;
    e.baseHash = entry.contentHash;
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
  if (e.unavailable || e.trashing || e.ignored) return;
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

function onWritten(c: Ctx, fileId: string, hash: string, ok: boolean): void {
  const e = c.s.durable.index[fileId];
  // Only the write this entry is waiting for: an older one completing must not be adopted.
  if (!e?.pendingWrite || e.pendingWrite.hash !== hash) return;
  if (ok) {
    adoptWrite(e);
    follow(c, e); // a server move that arrived during the write
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
  if (e.localHash !== e.baseHash || e.trashing || e.ignored) return;
  trash(c, e);
}

/** Durable intent first (I1): until a scan or the event confirms it, nothing else moves this file. */
function trash(c: Ctx, e: Entry): void {
  if (e.localHash === null) return;
  e.trashing = e.localHash;
  c.fx.push({ type: "trash", fileId: e.fileId, path: local(c.s, e.path), expect: e.localHash });
}

/** The file left the disk through our trash. */
function trashDone(c: Ctx, e: Entry): void {
  e.trashing = null;
  if (e.headDeleted) {
    bury(e);
    return;
  }
  // Z10, or resurrected on the server meanwhile: it lives on the server; download it if allowed.
  e.localHash = null;
  e.materialized = false;
  e.base = null;
  e.baseHash = null;
  materialize(c, e);
}

function onTrashed(c: Ctx, fileId: string, ok: boolean): void {
  const e = c.s.durable.index[fileId];
  if (!e) return;
  if (!ok) {
    e.trashing = null; // changed meanwhile: the next scan sees the user's content
    return;
  }
  trashDone(c, e);
}

// ---------- joining (D-07, V-05) ----------

/**
 * A device that already knows the vault, back after the journal it missed was compacted: the
 * snapshot tells, for each file and folder it knows, what those entries would have said (same
 * rules as the journal, at the snapshot's position).
 */
function reconcileKnown(c: Ctx, snap: Snapshot): void {
  const { s } = c;
  const live = new Map(snap.files.map((f) => [f.fileId, f]));
  const at = { seq: snap.head, deviceId: "", at: new Date(0).toISOString() };
  for (const e of entries(s)) {
    if (!e.confirmed) {
      // Its put reached the server but the journal entry saying so was compacted.
      const r = live.get(e.fileId);
      if (!r || r.kind !== "file" || r.versionId === null || r.contentHash === null) continue;
      const mine = s.durable.sent.some(
        (op) => op.type === "put" && op.fileId === e.fileId && op.versionId === r.versionId,
      );
      onRemotePut(c, {
        ...at,
        deviceId: mine ? s.config.deviceId : "",
        type: "file_put",
        fileId: e.fileId,
        path: r.path,
        versionId: r.versionId,
        contentHash: r.contentHash,
        size: r.size,
        mtime: r.mtime,
      });
      if (e.localHash === null && e.base === null && !e.pendingWrite) {
        // Gone from here with no known base: in doubt it comes back rather than being deleted.
        e.materialized = false;
        materialize(c, e);
      }
      continue;
    }
    const r = live.get(e.fileId);
    if (r && r.kind === "file" && r.versionId !== null && r.contentHash !== null)
      onRemotePut(c, {
        ...at,
        type: "file_put",
        fileId: e.fileId,
        path: r.path,
        versionId: r.versionId,
        contentHash: r.contentHash,
        size: r.size,
        mtime: r.mtime,
      });
    else if (!r) onRemoteDelete(c, { ...at, type: "file_deleted", fileId: e.fileId, path: e.path });
  }
  for (const f of folderList(s)) {
    if (f.aliasOf) {
      // Its twin moved or went while this device was away: a real folder again.
      const twin = live.get(f.aliasOf);
      if (!twin || twin.kind !== "folder" || collisionKey(twin.path) !== collisionKey(f.path)) {
        f.aliasOf = null;
        f.confirmed = false;
        f.remotePath = null;
      }
      continue;
    }
    if (!f.confirmed) continue;
    const r = live.get(f.fileId);
    if (r && r.kind === "folder") {
      // Brought back while this device was away.
      if (f.deleted)
        onRemoteFolder(c, {
          ...at,
          type: "folder_created",
          kind: "folder",
          fileId: f.fileId,
          path: r.path,
        });
      else if (r.path !== f.remotePath)
        onRemoteFolder(c, {
          ...at,
          type: "file_moved",
          kind: "folder",
          fileId: f.fileId,
          path: r.path,
        });
    } else if (!r && !f.deleted)
      onRemoteFolder(c, {
        ...at,
        type: "folder_deleted",
        kind: "folder",
        fileId: f.fileId,
        path: f.path,
      });
  }
}

/** 03 §8.1 for a device without index: identical files align, different ones become conflicts, nothing is overwritten. */
function onSnapshot(c: Ctx, snap: Snapshot): void {
  const { s } = c;
  idle(s);
  reconcileKnown(c, snap);
  const remote = new Map<string, Snapshot["files"][number]>();
  for (const f of snap.files)
    if (
      f.kind === "file" &&
      f.versionId !== null &&
      f.contentHash !== null &&
      !s.durable.index[f.fileId]
    )
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
  for (const r of snap.files) {
    if (r.kind !== "folder" || s.durable.folders[r.fileId]) continue;
    const key = diskKey(s, r.path);
    const mine = folderList(s).find((x) => !x.confirmed && diskKey(s, x.path) === key);
    const f = newFolder(r.fileId, mine?.path ?? r.path, true);
    f.remotePath = r.path;
    f.seq = snap.head;
    if (mine) {
      f.onDisk = mine.onDisk;
      f.materialized = mine.materialized;
      delete s.durable.folders[mine.fileId];
    }
    s.durable.folders[f.fileId] = f;
    materializeFolder(c, f);
  }
  s.durable.cursor = snap.head;
  s.durable.joined = true;
  if (!startPush(c)) startPull(c);
}
