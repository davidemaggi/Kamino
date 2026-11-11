import { ErrorCode, type SyncSettings } from "@kamino/protocol";
import type { SyncSnapshot } from "@kamino/status";
import {
  initialState,
  localPath,
  normalizePath,
  retryDelay,
  step,
  type ClientConfig,
  type ClientEvent,
  type ClientState,
  type Durable,
  type Effect,
} from "@kamino/sync-core";
import { Api, ApiError } from "./api.js";
import { sha256Hex } from "./hash.js";
import type { Clock, Http, VaultFs } from "./ports.js";
import { Scanner, type StatCache } from "./scanner.js";
import {
  backlogOf,
  pendingChanges,
  type Backlog,
  snapshotOf,
  type DeferredFile,
  type PendingChange,
  type StopReason,
} from "./status.js";
import { SourceChanged, Transfers, type UploadSessions } from "./transfers.js";

export interface EngineDeps {
  fs: VaultFs;
  http: Http;
  clock: Clock;
  newId(): string;
  config: ClientConfig;
  vaultId: string;
  token: () => string | null;
  /** Codes only: never paths, names, contents or tokens. */
  log?: (code: string) => void;
  /** A `vault_settings_changed` entry arrived: the host reads the settings again (E10). */
  onSettingsChanged?: () => void;
  /** Without streaming (`fs.streaming === false`), files over this size wait (E3, 100 MB). */
  limits?: { maxInMemoryBytes?: number };
}

export const DEFAULT_MAX_IN_MEMORY_BYTES = 100 * 1024 * 1024;

/** The file is over the in-memory limit of an adapter without streaming. */
class TooLarge extends Error {
  constructor(readonly size: number) {
    super("too_large");
  }
}

/** Names of the engine's own state files (in the plugin folder). */
export const STATE_FILES = {
  durable: "durable",
  cache: "stat-cache",
  uploads: "uploads",
  meta: "meta",
} as const;

/** Pull period until the WebSocket of M2b (E6). */
export const PULL_PERIOD_MS = 60_000;

type FileEffect = Extract<Effect, { type: "write" | "rename" | "trash" | "mkdir" | "rmdir" }>;

async function loadJson<T>(fs: VaultFs, name: string, log: (c: string) => void): Promise<T | null> {
  const raw = await fs.loadState(name);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    log(`state_unreadable_${name}`);
    return null;
  }
}

/**
 * The shell of `step()` (E2): one step at a time, `persist` before any other effect (E5), file
 * effects in order each with its event (Z11), a scan only once they are done, network effects
 * with retries (E6), and the status derived from all of it (E8).
 */
export class Engine {
  private st: ClientState;
  private readonly api: Api;
  private readonly scanner: Scanner;
  private readonly transfers: Transfers;
  private readonly log: (code: string) => void;
  /** Serialises `step()`. */
  private chain: Promise<void> = Promise.resolve();
  /** Serialises file effects. */
  private fileChain: Promise<void> = Promise.resolve();
  private readonly inflight = new Set<Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private wanted = false;
  private closed = false;
  private pausedFlag = false;
  private periodic = false;
  private retrying = false;
  private netFailed = false;
  private attempt = 0;
  private stopReason: StopReason | null = null;
  private unreachableSince: number | null = null;
  private lastConfirmedAt: number | null;
  private oldestQueuedAt: number | null = null;
  private lastError: string | undefined;
  private openConflicts: { id: string; fileId: string }[] = [];
  private unreadable: string[] = [];
  /** Files waiting for streaming or a higher limit, by local path; rebuilt each cycle. */
  private readonly waiting = new Map<string, DeferredFile>();
  /** I1 (review): files that vanished in one scan, held until the user confirms. */
  private heldDeletions: number | null = null;
  /** I2 (review): renames reported while a scan runs wait for it, then the vault is scanned again. */
  private scanning = false;
  private readonly queuedRenames: ClientEvent[] = [];
  private allowDeletionsOnce = false;
  /** A local change was reported after the last scan. */
  private dirty = false;

  private constructor(
    private readonly d: EngineDeps,
    durable: Durable | null,
    cache: StatCache,
    sessions: UploadSessions,
    meta: { lastConfirmedAt?: number | null },
  ) {
    this.log = d.log ?? (() => {});
    this.st = initialState(d.config);
    if (durable) this.st = { ...this.st, durable };
    this.api = new Api(d.http, d.token);
    this.scanner = new Scanner(d.fs, d.config.configDir, cache);
    this.transfers = new Transfers(this.api, d.fs, sessions, (s) =>
      d.fs.saveState(STATE_FILES.uploads, JSON.stringify(s)),
    );
    this.lastConfirmedAt = meta.lastConfirmedAt ?? null;
  }

  /** Loads the durable state, the stat cache and the upload sessions saved by a previous run. */
  static async open(d: EngineDeps): Promise<Engine> {
    const log = d.log ?? (() => {});
    return new Engine(
      d,
      await loadJson<Durable>(d.fs, STATE_FILES.durable, log),
      (await loadJson<StatCache>(d.fs, STATE_FILES.cache, log)) ?? {},
      (await loadJson<UploadSessions>(d.fs, STATE_FILES.uploads, log)) ?? {},
      (await loadJson<{ lastConfirmedAt?: number | null }>(d.fs, STATE_FILES.meta, log)) ?? {},
    );
  }

  /** Paused by the user (initial transfer): no cycle runs until `resume()`. */
  get paused(): boolean {
    return this.pausedFlag;
  }

  pause(): void {
    this.pausedFlag = true;
    this.changed();
  }

  resume(): void {
    this.pausedFlag = false;
    this.changed();
    void this.kick();
  }

  backlog(): Backlog {
    return backlogOf(this.st);
  }

  get stopped(): StopReason | null {
    return this.stopReason;
  }

  /** First cycle now, then a pull every minute. */
  start(): void {
    void this.kick();
    if (this.periodic) return;
    this.periodic = true;
    void (async () => {
      while (!this.closed) {
        await this.d.clock.sleep(PULL_PERIOD_MS);
        if (this.closed) break;
        void this.kick();
      }
    })();
  }

  async stop(): Promise<void> {
    this.closed = true;
    await this.running;
    await this.settled();
  }

  /** Resolves when the cycle it asked for is over and idle. */
  async syncNow(): Promise<void> {
    do await this.kick();
    while (this.wanted && !this.closed && !this.stopReason && !this.pausedFlag);
  }

  /** Something changed on disk (the caller debounces): a cycle with a full scan follows. */
  localChange(): void {
    this.dirty = true;
    this.changed();
    void this.kick();
  }

  /** A rename seen by the watcher (local paths). */
  localRename(from: string, to: string): void {
    const f = normalizePath(from, this.d.config.configDir);
    const t = normalizePath(to, this.d.config.configDir);
    if (f.ok && t.ok) {
      const ev: ClientEvent = { type: "localRename", from: f.path, to: t.path };
      if (this.scanning) this.queuedRenames.push(ev);
      else void this.dispatch(ev);
    }
    this.localChange();
  }

  setSettings(settings: SyncSettings): void {
    this.chain = this.chain.then(() => {
      this.st = { ...this.st, config: { ...this.st.config, settings } };
    });
    void this.kick();
  }

  snapshot(): SyncSnapshot {
    return snapshotOf({
      queued: this.queued(),
      oldestQueuedAt: this.oldestQueuedAt,
      lastConfirmedAt: this.lastConfirmedAt,
      unreachableSince: this.unreachableSince,
      syncing: this.running !== null || this.inflight.size > 0,
      conflicts: this.conflicts().length,
      stopped: this.stopReason,
      heldDeletions: this.heldDeletions,
    });
  }

  /** Local paths. */
  pending(): PendingChange[] {
    const since = this.oldestQueuedAt ?? this.d.clock.now();
    return pendingChanges(this.st, since).map((p) => ({
      ...p,
      path: localPath(p.path, this.d.config.configDir),
    }));
  }

  /** Files waiting (no streaming, over the limit) and files that couldn't be read this time. */
  deferred(): DeferredFile[] {
    const out = [...this.waiting.values()];
    for (const path of this.unreadable)
      if (!this.waiting.has(path)) out.push({ path, size: 0, direction: "upload" });
    return out;
  }

  /** Over the limit for an adapter that holds whole files in memory. */
  private tooBig(size: number): boolean {
    if (this.d.fs.streaming) return false;
    return size > (this.d.limits?.maxInMemoryBytes ?? DEFAULT_MAX_IN_MEMORY_BYTES);
  }

  /** Local paths that couldn't be read at the last scan. */
  unreadableFiles(): string[] {
    return [...this.unreadable];
  }

  /** Open conflicts, with the local path when this device knows the file. */
  conflicts(): { id: string; fileId: string; path: string | null }[] {
    const index = this.st.durable.index;
    const pathOf = (fileId: string) => {
      const e = index[fileId];
      return e ? localPath(e.path, this.d.config.configDir) : null;
    };
    const out = new Map(
      this.openConflicts.map((c) => [c.id, { ...c, path: pathOf(c.fileId) }] as const),
    );
    for (const e of Object.values(index))
      if (e.conflictId)
        out.set(e.conflictId, { id: e.conflictId, fileId: e.fileId, path: pathOf(e.fileId) });
    return [...out.values()];
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ---------- cycles ----------

  private kick(): Promise<void> {
    this.wanted = true;
    if (this.running) return this.running;
    const ref: { run?: Promise<void> } = {};
    const run: Promise<void> = (async () => {
      // Yield first: `running` must be set before the loop can end (a paused engine ends at once).
      await null;
      try {
        while (this.wanted && !this.closed && !this.stopReason && !this.pausedFlag) {
          this.wanted = false;
          await this.cycle();
        }
      } finally {
        if (this.running === ref.run) this.running = null;
        this.changed();
      }
    })();
    ref.run = run;
    this.running = run;
    // A change reported while the loop was ending gets its own cycle.
    void run.then(() => {
      if (this.wanted && !this.closed && !this.stopReason && !this.pausedFlag) void this.kick();
    });
    return run;
  }

  private async cycle(): Promise<void> {
    // Z11: the scan only once every file effect issued so far is done.
    await this.settled();
    if (this.closed || this.stopReason) return;
    this.netFailed = false;
    let scan;
    this.scanning = true;
    try {
      // A rename during the scan may or may not be in it: apply it, then scan again.
      for (let i = 0; ; i++) {
        scan = await this.scanner.scan();
        if (this.queuedRenames.length === 0 || i >= 3) break;
        for (const ev of this.queuedRenames.splice(0)) await this.dispatch(ev);
      }
    } catch {
      this.log("scan_failed");
      this.netFailed = true;
      this.scheduleRetry();
      return;
    } finally {
      this.scanning = false;
      for (const ev of this.queuedRenames.splice(0)) void this.dispatch(ev);
    }
    this.unreadable = scan.unreadable;
    this.dirty = false;
    this.waiting.clear();
    await this.d.fs.saveState(STATE_FILES.cache, JSON.stringify(this.scanner.cache));
    if (this.holdsDeletions(scan.files, scan.unreadable)) {
      this.changed();
      return;
    }
    // C1 (review): unreadable files are present with unknown content, never taken for deleted.
    const unreadable = scan.unreadable.flatMap((p) => {
      const n = normalizePath(p, this.d.config.configDir);
      return n.ok ? [n.path] : [];
    });
    await this.dispatch({ type: "sync", scan: scan.files, folders: scan.folders, unreadable });
    await this.settled();
    if (this.stopReason) return;
    await this.report();
    if (this.netFailed) this.scheduleRetry();
    else this.attempt = 0;
  }

  /**
   * I1 (review): an empty or partial listing (unmounted disk, revoked permission) must not delete
   * the vault everywhere. When too many confirmed files vanish at once, the cycle stops before
   * anything is sent and waits for `confirmDeletions()`.
   */
  private holdsDeletions(files: { path: string }[], unreadable: string[]): boolean {
    const ci = this.d.config.platform !== "linux";
    const key = (p: string) => (ci ? p.toLowerCase() : p);
    const present = new Set(files.map((f) => key(f.path)));
    for (const p of unreadable) {
      const n = normalizePath(p, this.d.config.configDir);
      if (n.ok) present.add(key(n.path));
    }
    let tracked = 0;
    let vanished = 0;
    for (const e of Object.values(this.st.durable.index)) {
      if (!e.confirmed || e.localHash === null || e.ignored || e.pendingWrite || e.trashing)
        continue;
      tracked++;
      if (!present.has(key(e.path))) vanished++;
    }
    const mass =
      (tracked >= 5 && vanished === tracked) || (vanished > 50 && vanished * 4 > tracked);
    if (!mass || this.allowDeletionsOnce) {
      this.allowDeletionsOnce = false;
      this.heldDeletions = null;
      return false;
    }
    if (this.heldDeletions === null) this.log("deletions_held");
    this.heldDeletions = vanished;
    return true;
  }

  /** The user confirmed the deletions held by the brake: the next cycle sends them. */
  async confirmDeletions(): Promise<void> {
    this.allowDeletionsOnce = true;
    this.heldDeletions = null;
    await this.syncNow();
  }

  private scheduleRetry(): void {
    if (this.retrying || this.closed || this.stopReason) return;
    this.retrying = true;
    const delay = retryDelay(this.attempt++, this.d.clock.random());
    void this.d.clock.sleep(delay).then(() => {
      this.retrying = false;
      if (!this.closed) void this.kick();
    });
  }

  /** Waits until no effect is in flight and no step is queued. */
  private async settled(): Promise<void> {
    for (;;) {
      await this.chain;
      if (this.inflight.size === 0) return;
      await Promise.allSettled([...this.inflight]);
    }
  }

  private track(p: Promise<void>): void {
    const t = p.catch(() => this.log("effect_failed"));
    this.inflight.add(t);
    void t.finally(() => this.inflight.delete(t));
  }

  /** 03 §12: counts and error codes only. */
  private async report(): Promise<void> {
    const pend = pendingChanges(this.st, 0);
    // The batch in flight; the rest is counted in pendingOps.
    const pendingBytes = this.st.durable.sent.reduce(
      (n, op) => n + (op.type === "put" ? op.size : 0),
      0,
    );
    const code = ErrorCode.safeParse(this.lastError);
    try {
      await this.api.status(this.d.vaultId, {
        pendingOps: pend.length,
        pendingBytes,
        deferredFiles: this.deferred().length,
        ...(code.success ? { lastErrorCode: code.data } : {}),
      });
    } catch (e) {
      this.failure(e);
    }
    await this.d.fs
      .saveState(STATE_FILES.meta, JSON.stringify({ lastConfirmedAt: this.lastConfirmedAt }))
      .catch(() => this.log("meta_save_failed"));
  }

  // ---------- step and effects ----------

  private dispatch(ev: ClientEvent): Promise<void> {
    const run = this.chain.then(() => this.apply(ev));
    this.chain = run.catch(() => this.log("step_failed"));
    return run;
  }

  private async apply(ev: ClientEvent): Promise<void> {
    if (this.stopReason) return;
    const { state, effects } = step(this.st, ev, { newId: this.d.newId });
    this.st = state;
    for (const fx of effects) {
      // E5: write-ahead, before any other effect of this step.
      if (fx.type === "persist")
        await this.d.fs.saveState(STATE_FILES.durable, JSON.stringify(state.durable));
      else this.perform(fx);
    }
    if (state.vol.stopped) this.halt(state.vol.stopped);
    this.changed();
  }

  private perform(fx: Exclude<Effect, { type: "persist" }>): void {
    const { api } = this;
    const vaultId = this.d.vaultId;
    switch (fx.type) {
      case "write":
      case "rename":
      case "trash":
      case "mkdir":
      case "rmdir": {
        const p = this.fileChain.then(() => this.fileEffect(fx));
        this.fileChain = p.catch(() => {});
        this.track(p);
        return;
      }
      case "push":
        this.track(this.net(fx.requestId, () => this.push(fx)));
        return;
      case "pull":
        this.track(
          this.net(fx.requestId, async () => {
            const r = await api.changes(vaultId, fx.after);
            if (r.entries.some((e) => e.type === "vault_settings_changed"))
              this.d.onSettingsChanged?.();
            this.lastConfirmedAt = this.d.clock.now();
            return { type: "pullResult", requestId: fx.requestId, ...r };
          }),
        );
        return;
      case "snapshot":
        this.track(
          this.net(fx.requestId, async () => {
            const snapshot = await api.snapshot(vaultId);
            this.openConflicts = snapshot.openConflicts.map((c) => ({
              id: c.conflictId,
              fileId: c.fileId,
            }));
            return { type: "snapshotResult", requestId: fx.requestId, snapshot };
          }),
        );
        return;
      case "ack":
        this.track(api.ack(vaultId, fx.seq).catch((e: unknown) => this.failure(e)));
        return;
      case "notify":
        if (fx.kind === "update_required") this.halt("update_required");
        this.log(`notify_${fx.kind}${fx.code ? `_${fx.code}` : ""}`);
        return;
    }
  }

  /** A network effect: its result event, or `networkError` (retried with backoff). */
  private async net(requestId: string, f: () => Promise<ClientEvent>): Promise<void> {
    let ev: ClientEvent;
    try {
      ev = await f();
      this.unreachableSince = null;
    } catch (e) {
      if (e instanceof ApiError && e.kind === "cursor_too_old") {
        // 03 §6.3: start again from the snapshot, reconciled with what this device knows.
        this.log("cursor_too_old");
        ev = { type: "resync", requestId };
      } else {
        this.failure(e);
        ev = { type: "networkError", requestId };
      }
    }
    if (this.stopReason) return;
    await this.dispatch(ev);
  }

  private failure(e: unknown): void {
    if (!(e instanceof ApiError)) {
      this.log("unexpected_error");
      this.netFailed = true;
      return;
    }
    if (e.kind === "revoked" || e.kind === "blocked" || e.kind === "protocol") {
      this.halt(e.kind);
      return;
    }
    if (e.kind === "network") this.unreachableSince ??= this.d.clock.now();
    if (e.code) this.lastError = e.code;
    this.netFailed = true;
  }

  private halt(reason: StopReason): void {
    if (this.stopReason) return;
    this.stopReason = reason;
    this.log(`stopped_${reason}`);
    this.changed();
  }

  /** blobs/check → upload of what's missing → commit (03 §5). */
  private async push(fx: Extract<Effect, { type: "push" }>): Promise<ClientEvent> {
    const vaultId = this.d.vaultId;
    const missing = fx.hashes.length > 0 ? await this.api.missing(vaultId, fx.hashes) : [];
    if (missing.length > 0) {
      const byHash = new Map<string, { path: string; size: number }>();
      for (const [path, c] of Object.entries(this.scanner.cache))
        byHash.set(c.hash, { path, size: c.size });
      for (const hash of missing) {
        const src = byHash.get(hash);
        // Not on disk any more: the commit answers blob_missing, the next cycle decides.
        if (!src) continue;
        if (this.tooBig(src.size)) {
          // Never lost: it stays on disk and in the queue (blob_missing), shown as deferred.
          this.waiting.set(src.path, { path: src.path, size: src.size, direction: "upload" });
          continue;
        }
        try {
          await this.transfers.upload(vaultId, src.path, hash, src.size, () => {});
        } catch (e) {
          if (e instanceof SourceChanged) continue;
          if (e instanceof ApiError && e.kind === "http") {
            this.log(`upload_failed_${e.code ?? e.status ?? ""}`);
            if (e.code) this.lastError = e.code;
            continue;
          }
          if (!(e instanceof ApiError)) {
            // The file couldn't be read: the next scan reports it.
            this.log("upload_read_failed");
            continue;
          }
          throw e;
        }
      }
    }
    const r = await this.api.commit(vaultId, fx.ops);
    this.lastConfirmedAt = this.d.clock.now();
    return { type: "pushResult", requestId: fx.requestId, results: r.results, head: r.head };
  }

  private async fileEffect(fx: FileEffect): Promise<void> {
    const { fs } = this.d;
    let ev: ClientEvent;
    switch (fx.type) {
      case "write": {
        let ok = false;
        try {
          const parts = this.transfers.download(
            this.d.vaultId,
            fx.hash,
            () => {},
            (total) => {
              if (this.tooBig(total)) throw new TooLarge(total);
            },
          );
          ok = (await fs.write(fx.path, parts, fx.expect, fx.hash)) === "ok";
        } catch (e) {
          if (e instanceof TooLarge)
            this.waiting.set(fx.path, { path: fx.path, size: e.size, direction: "download" });
          else if (e instanceof ApiError) this.failure(e);
          else this.log("write_failed");
        }
        ev = { type: "written", fileId: fx.fileId, hash: fx.hash, ok };
        break;
      }
      case "rename": {
        const ok = await fs.rename(fx.from, fx.to).catch(() => false);
        ev = { type: "renamed", fileId: fx.fileId, to: fx.toPath, ok };
        break;
      }
      case "trash": {
        // Only if the file still holds the content the client decided about.
        const cur = await sha256Hex(fs.read(fx.path)).catch(() => null);
        const ok = cur === fx.expect && (await fs.trash(fx.path).catch(() => false));
        ev = { type: "trashed", fileId: fx.fileId, ok };
        break;
      }
      case "mkdir": {
        const ok = await fs.mkdir(fx.path).then(
          () => true,
          () => false,
        );
        ev = { type: "folderDone", fileId: fx.fileId, op: "mkdir", ok };
        break;
      }
      case "rmdir": {
        const ok = await fs.rmdirIfEmpty(fx.path).catch(() => false);
        ev = { type: "folderDone", fileId: fx.fileId, op: fx.leftover ? "leftover" : "rmdir", ok };
        break;
      }
    }
    if (this.stopReason) return;
    await this.dispatch(ev);
  }

  private queued(): number {
    const n = pendingChanges(this.st, 0).length;
    return n > 0 ? n : this.dirty ? 1 : 0;
  }

  private changed(): void {
    if (this.queued() > 0) this.oldestQueuedAt ??= this.d.clock.now();
    else this.oldestQueuedAt = null;
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        this.log("listener_failed");
      }
    }
  }
}
