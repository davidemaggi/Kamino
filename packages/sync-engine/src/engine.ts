import {
  type ChangesResponse,
  ErrorCode,
  PROTOCOL_MIN_SUPPORTED,
  PROTOCOL_VERSION,
  type SyncSettings,
} from "@kamino/protocol";
import type { SyncSnapshot } from "@kamino/status";
import {
  conflictCopyPath,
  conflictHead,
  conflictStamp,
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
  type Entry,
  type ResolveChoice,
} from "@kamino/sync-core";
import { Api, ApiError } from "./api.js";
import { Realtime, type PairingMessage, type RealtimeEvent, type SocketFactory } from "./socket.js";
import { EchoGuard } from "./echo.js";
import type { Network } from "./network.js";
import { sha256Hex } from "./hash.js";
import type { Clock, Http, VaultFs } from "./ports.js";
import { Scanner, type StatCache } from "./scanner.js";
import {
  backlogOf,
  pendingChanges,
  pendingOps,
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
  /** S-08: the network, and the device's "large files only on Wi-Fi" option. */
  network?: Network;
  wifiOnly?: () => { enabled: boolean; thresholdBytes: number };
  /** S-02 mode of this device (default live, 15 minutes). */
  mode?: { mode: SyncMode; periodicMinutes: number };
  /** Realtime doorbell (M2b, F1): without it the engine works by cycles only. */
  socket?: SocketFactory;
  /** Sent in the socket's hello. */
  client?: { pluginVersion: string; platform: string };
  /** A `vault_settings_changed` entry arrived: the host reads the settings again (E10). */
  onSettingsChanged?: () => void;
  /** Pairing news from the socket (03 §10): the host shows it, the engine ignores it. */
  onPairing?: (message: PairingMessage) => void;
  /** Without streaming (`fs.streaming === false`), files over this size wait (E3, 100 MB). */
  limits?: { maxInMemoryBytes?: number };
}

export const DEFAULT_MAX_IN_MEMORY_BYTES = 100 * 1024 * 1024;

/** The transfer waits for a free network (already recorded). */
class Held extends Error {
  constructor() {
    super("held");
  }
}

/** The user paused (or the engine stopped) in the middle of a push. */
class Paused extends Error {
  constructor() {
    super("paused");
  }
}

/** The event of a file effect that was not performed. */
function skipped(fx: FileEffect): ClientEvent {
  switch (fx.type) {
    case "write":
      return { type: "written", fileId: fx.fileId, hash: fx.hash, ok: false };
    case "rename":
      return { type: "renamed", fileId: fx.fileId, to: fx.toPath, ok: false };
    case "trash":
      return { type: "trashed", fileId: fx.fileId, ok: false };
    case "mkdir":
      return { type: "folderDone", fileId: fx.fileId, op: "mkdir", ok: false };
    case "rmdir":
      return {
        type: "folderDone",
        fileId: fx.fileId,
        op: fx.leftover ? "leftover" : "rmdir",
        ok: false,
      };
  }
}

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

const MAX_AUTHORS = 10_000;

async function* one(b: Uint8Array): AsyncIterable<Uint8Array> {
  yield b;
}

/** The author of web app versions in the journal (the server's `WEB_AUTHOR`). */
export const WEB_AUTHOR_ID = "00000000-0000-0000-0000-000000000000";

/** An open conflict of the vault. `here`: this device has a side of it and can resolve it. */
export interface ConflictInfo {
  id: string;
  fileId: string;
  /** Local path, when this device knows the file. */
  path: string | null;
  here: boolean;
}

/** One side of a conflict. `bytes` only when asked for. */
export interface ConflictSide {
  /** epoch ms, when known. */
  at: number | null;
  /** Who wrote it, when known: a device name, or `web` for the web app. */
  author: { kind: "device"; name: string } | { kind: "web" } | null;
  size: number | null;
  bytes: Uint8Array | null;
}

export interface ConflictDetail {
  id: string;
  fileId: string;
  /** Local path. */
  path: string;
  kind: "concurrent_edit" | "both_created";
  /** The server version shown as "incoming": the one a resolution answers. */
  head: string;
  /** This device's copy; `bytes` null when the file is not on disk. */
  mine: ConflictSide;
  incoming: ConflictSide;
}

/** What the user chose for one conflict, against the server version they saw. */
export interface ResolveRequest {
  id: string;
  choice: ResolveChoice;
  head: string;
  /** A manual merge: written to the local file first, then kept as "mine". */
  text?: Uint8Array;
  /** "Keep both": label and device name of the copy's name (03 §9.3). */
  copy?: { label: string; device: string };
}

/**
 * ok = confirmed by the server (or closed meanwhile); queued = waiting for the server (offline);
 * stale = the server moved on or the local file changed, look again; gone = not open any more.
 */
export type ResolveResult = "ok" | "queued" | "stale" | "gone";

/** S-02. Live: socket + quick sends; Periodic: a cycle every N minutes; Manual: on request. */
export type SyncMode = "live" | "periodic" | "manual";
/** Live with the socket down: a pull this often until it is back (spec F3). */
export const LIVE_FALLBACK_MS = 300_000;
/** S-08 on iOS: an answer to the metered-network question holds this long (review I5). */
export const ASK_WINDOW_MS = 30 * 60_000;

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
  private started = false;
  private mode: SyncMode;
  private periodicMinutes: number;
  /** Each mode's timer belongs to one generation: switching mode ends the old one. */
  private timerGen = 0;
  private retrying = false;
  private netFailed = false;
  private attempt = 0;
  private stopReason: StopReason | null = null;
  private unreachableSince: number | null = null;
  private lastConfirmedAt: number | null;
  private oldestQueuedAt: number | null = null;
  private lastError: string | undefined;
  private openConflicts: { id: string; fileId: string }[] = [];
  /** Who wrote the server versions seen in the journal (memory only, best effort). */
  private readonly authors = new Map<string, { deviceId: string; at: number }>();
  private deviceNames: Map<string, string> | null = null;
  private unreadable: string[] = [];
  /** Files waiting for streaming or a higher limit, by local path; rebuilt each cycle. */
  private readonly waiting = new Map<string, DeferredFile>();
  /** I1 (review): files that vanished in one scan, held until the user confirms. */
  private heldDeletions: number | null = null;
  private realtime: Realtime | null = null;
  /** S-08 on iOS (review I5): the answer to the metered question holds for a while. */
  private meteredUntil = 0;
  private deniedUntil = 0;
  private asking = false;
  /** Paths the user asked to transfer now ("carica/scarica ora"): let through once. */
  private readonly allowOnce = new Set<string>();
  /** F4: what the engine just did to the vault, to tell its own events apart. */
  private readonly echo: EchoGuard;
  /** I7: the state has changes not saved yet (outcomes of file effects only). */
  private unsaved = false;
  private notifyQueued = false;
  private pendingMemo: { st: ClientState; count: number } | null = null;
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
    this.scanner = new Scanner(d.fs, d.config.configDir, cache, {
      settings: () => this.st.config.settings,
      caseInsensitive: d.config.platform !== "linux",
      now: () => d.clock.now(),
      maxHashBytes: () =>
        d.fs.streaming ? Infinity : (d.limits?.maxInMemoryBytes ?? DEFAULT_MAX_IN_MEMORY_BYTES),
    });
    this.transfers = new Transfers(this.api, d.fs, sessions, (s) =>
      d.fs.saveState(STATE_FILES.uploads, JSON.stringify(s)),
    );
    this.lastConfirmedAt = meta.lastConfirmedAt ?? null;
    this.echo = new EchoGuard(() => d.clock.now());
    this.mode = d.mode?.mode ?? "live";
    this.periodicMinutes = d.mode?.periodicMinutes ?? 15;
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

  /** A vault event that only reflects what the engine itself just did (F4). */
  isEcho(path: string, stat: { size: number; mtime: number } | null): boolean {
    return this.echo.isEcho(path, stat);
  }

  /** Remembers what a completed file effect left on disk. */
  private async noteEcho(fx: FileEffect, ok: boolean): Promise<void> {
    if (!ok) return;
    const st = async (p: string) => {
      const s = await this.d.fs.stat(p).catch(() => null);
      return s ? { size: s.size, mtime: s.mtime } : null;
    };
    switch (fx.type) {
      case "write":
      case "mkdir":
        this.echo.record(fx.path, await st(fx.path));
        return;
      case "rename":
        this.echo.record(fx.from, null);
        this.echo.record(fx.to, await st(fx.to));
        return;
      case "trash":
      case "rmdir":
        this.echo.record(fx.path, null);
        return;
    }
  }

  get realtimeConnected(): boolean {
    return this.realtime?.connected ?? false;
  }

  /** Opens the realtime doorbell (F1): notifications trigger pulls, data stays REST. */
  private openRealtime(): void {
    if (!this.d.socket || this.realtime || this.closed || this.stopReason) return;
    this.realtime = new Realtime({
      socket: this.d.socket,
      clock: this.d.clock,
      log: this.log,
      hello: () => ({
        type: "hello",
        deviceToken: this.d.token() ?? "",
        protocol: { min: PROTOCOL_MIN_SUPPORTED, max: PROTOCOL_VERSION },
        // The durable cursor: what this device has applied (spec §6.1).
        cursor: this.st.durable.cursor,
        pluginVersion: this.d.client?.pluginVersion ?? "",
        platform: this.d.client?.platform ?? "",
      }),
      onEvent: (e) => this.onRealtime(e),
    });
    this.realtime.start();
  }

  /**
   * I1/I2: a socket closed with 4401/4403/4404 may mean a slow hello, a revoked device, a
   * blocked user or a vault that is gone. A vault route tells which; only a confirmed answer stops.
   */
  private async verifyAccess(): Promise<void> {
    try {
      await this.api.changes(this.d.vaultId, this.st.durable.cursor);
    } catch (e) {
      if (e instanceof ApiError && e.kind === "http" && e.status === 404) this.halt("vault_gone");
      else if (e instanceof ApiError && (e.kind === "revoked" || e.kind === "blocked"))
        this.failure(e);
    }
  }

  private closeRealtime(): void {
    this.realtime?.stop();
    this.realtime = null;
  }

  private onRealtime(e: RealtimeEvent): void {
    switch (e.type) {
      case "connected":
        // Anything missed while disconnected: one cycle catches up (not while a REST retry is
        // already scheduled: that would bypass its backoff, review I3).
        if (!this.retrying) void this.kick();
        break;
      case "changes":
        if (e.head > this.st.durable.cursor) void this.kick();
        break;
      case "settings":
        this.d.onSettingsChanged?.();
        break;
      case "pairing":
        this.d.onPairing?.(e.message);
        break;
      case "revoked":
      case "blocked":
      case "protocol":
        this.halt(e.type);
        break;
      case "resync":
        void this.kick(); // the pull meets cursor_too_old and resyncs
        break;
      case "check":
        void this.verifyAccess();
        break;
      case "disconnected":
        break;
    }
    this.changed();
  }

  get stopped(): StopReason | null {
    return this.stopReason;
  }

  /** A cycle now (S-03), then whatever the mode asks for. */
  start(): void {
    this.started = true;
    this.applyMode();
    void this.kick();
  }

  /** Applied at once; work in progress finishes, the socket closes with 1000 (spec §6.4). */
  setMode(mode: SyncMode, periodicMinutes: number): void {
    const same = mode === this.mode && periodicMinutes === this.periodicMinutes;
    this.mode = mode;
    this.periodicMinutes = periodicMinutes;
    if (this.started && !same) this.applyMode();
  }

  private applyMode(): void {
    const gen = ++this.timerGen;
    if (this.mode === "live") this.openRealtime();
    else this.closeRealtime();
    if (this.mode === "manual") return;
    void (async () => {
      for (;;) {
        const live = this.mode === "live";
        await this.d.clock.sleep(live ? LIVE_FALLBACK_MS : this.periodicMinutes * 60_000);
        if (gen !== this.timerGen || this.closed || this.stopReason) return;
        if (!live || !this.realtimeConnected) void this.kick();
      }
    })();
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.timerGen++;
    this.closeRealtime();
    await this.running;
    await this.settled();
    await this.flush();
  }

  /** Saves what the coalesced steps changed (I7). */
  private async flush(): Promise<void> {
    if (!this.unsaved) return;
    await (this.chain = this.chain.then(async () => {
      if (!this.unsaved) return;
      try {
        await this.d.fs.saveState(STATE_FILES.durable, JSON.stringify(this.st.durable));
        this.unsaved = false;
      } catch {
        this.log("persist_failed");
      }
    }));
  }

  /** Resolves when the cycle it asked for is over and idle. */
  async syncNow(): Promise<void> {
    do await this.kick();
    while (this.wanted && !this.closed && !this.stopReason && !this.pausedFlag);
  }

  /**
   * Something changed on disk (the caller debounces). Live: a cycle follows. Periodic and
   * Manual: it waits for the next cycle (the queue derives from the index then, S-04).
   */
  localChange(): void {
    this.dirty = true;
    this.changed();
    if (this.mode === "live" || !this.started) void this.kick();
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
      if (!this.waiting.has(path))
        out.push({ path, size: 0, direction: "upload", reason: "unreadable" });
    return out;
  }

  /**
   * S-08: a file over the threshold waits on a metered network, unless the user asked to send
   * it now. On an unknown network (iOS) the user is asked once per cycle; "yes" holds.
   */
  private async networkHolds(path: string, size: number): Promise<boolean> {
    const w = this.d.wifiOnly?.();
    if (!w?.enabled || size <= w.thresholdBytes) return false;
    if (this.allowOnce.delete(path)) return false;
    const kind = this.d.network?.kind() ?? "free";
    if (kind === "free") return false;
    if (kind === "metered") return true;
    // Unknown network (iOS): never wait for the answer; the file waits while it's pending.
    const now = this.d.clock.now();
    if (now < this.meteredUntil) return false;
    if (now < this.deniedUntil || this.asking) return true;
    this.asking = true;
    void this.d.network!.ask().then(
      (yes) => {
        this.asking = false;
        const t = this.d.clock.now();
        if (yes) {
          this.meteredUntil = t + ASK_WINDOW_MS;
          void this.kick();
        } else this.deniedUntil = t + ASK_WINDOW_MS;
      },
      () => (this.asking = false),
    );
    return true;
  }

  /** "Carica/scarica ora" on a waiting file: let it through once (S-08). */
  async transferNow(path: string): Promise<void> {
    this.allowOnce.add(path);
    await this.syncNow();
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
  conflicts(): ConflictInfo[] {
    const index = this.st.durable.index;
    const pathOf = (fileId: string) => {
      const e = index[fileId];
      return e ? localPath(e.path, this.d.config.configDir) : null;
    };
    const out = new Map<string, ConflictInfo>(
      this.openConflicts.map((c) => [c.id, { ...c, path: pathOf(c.fileId), here: false }] as const),
    );
    for (const e of Object.values(index))
      if (e.conflictId)
        out.set(e.conflictId, {
          id: e.conflictId,
          fileId: e.fileId,
          path: pathOf(e.fileId),
          here: !e.ignored,
        });
    return [...out.values()];
  }

  /** The entry of this device's side of the conflict, if it can resolve it. */
  private conflictEntry(id: string): Entry | null {
    return (
      Object.values(this.st.durable.index).find((e) => e.conflictId === id && !e.ignored) ?? null
    );
  }

  /**
   * B3: "mine" = this device's copy, "incoming" = the server's current version. Contents only
   * with `content` (the caller decides what it can show); null when not resolvable here.
   */
  async conflictDetail(id: string, content: boolean): Promise<ConflictDetail | null> {
    const e = this.conflictEntry(id);
    const head = e ? conflictHead(this.st, e.fileId) : null;
    if (!e || !head) return null;
    const path = localPath(e.path, this.d.config.configDir);
    const collect = async (parts: AsyncIterable<Uint8Array>) => {
      const chunks: Uint8Array[] = [];
      for await (const p of parts) chunks.push(p);
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    };
    const mineBytes = content && e.localHash !== null ? await collect(this.d.fs.read(path)) : null;
    let incomingSize: number | null = this.st.durable.index[head.fileId]?.size ?? null;
    const incomingBytes = content
      ? await collect(
          this.transfers.download(
            this.d.vaultId,
            head.hash,
            () => {},
            (n) => (incomingSize = n),
          ),
        )
      : null;
    const by = this.authors.get(head.versionId);
    return {
      id,
      fileId: e.fileId,
      path,
      kind: e.confirmed ? "concurrent_edit" : "both_created",
      head: head.versionId,
      mine: {
        at: e.localHash !== null ? e.mtime : null,
        author: null,
        size: e.localHash !== null ? e.size : null,
        bytes: mineBytes,
      },
      incoming: {
        at: by?.at ?? null,
        author: by ? await this.authorOf(by.deviceId) : null,
        size: incomingSize,
        bytes: incomingBytes,
      },
    };
  }

  private async authorOf(deviceId: string): Promise<ConflictSide["author"]> {
    if (deviceId === WEB_AUTHOR_ID) return { kind: "web" };
    if (!this.deviceNames?.has(deviceId)) {
      try {
        const list = await this.api.vaultDevices();
        this.deviceNames = new Map(list.map((d) => [d.id, d.name]));
      } catch {
        return null;
      }
    }
    const name = this.deviceNames?.get(deviceId);
    return name === undefined ? null : { kind: "device", name };
  }

  /**
   * Resolves conflicts of this device (B3), then runs a cycle so the server confirms them. A
   * manual merge is written to the local file first (only if it is still what the user saw).
   */
  async resolve(requests: readonly ResolveRequest[]): Promise<ResolveResult[]> {
    const out: (ResolveResult | null)[] = [];
    const sent: { id: string; i: number }[] = [];
    for (const r of requests) {
      const e = this.conflictEntry(r.id);
      if (!e) {
        out.push(this.conflicts().some((c) => c.id === r.id) ? "stale" : "gone");
        continue;
      }
      if (conflictHead(this.st, e.fileId)?.versionId !== r.head) {
        out.push("stale");
        continue;
      }
      let choice = r.choice;
      if (r.text) {
        const want = await sha256Hex(one(r.text));
        const path = localPath(e.path, this.d.config.configDir);
        if ((await this.d.fs.write(path, one(r.text), e.localHash, want)) !== "ok") {
          out.push("stale");
          continue;
        }
        this.dirty = true;
        choice = "mine";
      }
      const ev: ClientEvent = { type: "resolve", fileId: e.fileId, choice, head: r.head };
      if (r.copy)
        ev.copyPath = conflictCopyPath(
          e.path,
          r.copy.label,
          r.copy.device,
          conflictStamp(new Date(this.d.clock.now()), false),
        );
      await this.dispatch(ev);
      sent.push({ id: r.id, i: out.length });
      out.push(null);
    }
    if (sent.length > 0) await this.syncNow();
    for (const { id, i } of sent) {
      const e = Object.values(this.st.durable.index).find((x) => x.conflictId === id);
      out[i] = !e ? "ok" : e.resolving ? "queued" : "stale";
    }
    return out.map((r) => r ?? "stale");
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
    if (
      this.holdsDeletions(scan.files, [...scan.unreadable, ...scan.tooLarge.map((f) => f.path)])
    ) {
      this.changed();
      return;
    }
    // C1 (review): unreadable files are present with unknown content, never taken for deleted.
    // I4: files too big to hash here are present too, and wait as deferred.
    for (const f of scan.tooLarge)
      this.waiting.set(f.path, { path: f.path, size: f.size, direction: "upload", reason: "size" });
    const unreadable = [...scan.unreadable, ...scan.tooLarge.map((f) => f.path)].flatMap((p) => {
      const n = normalizePath(p, this.d.config.configDir);
      return n.ok ? [n.path] : [];
    });
    await this.dispatch({ type: "sync", scan: scan.files, folders: scan.folders, unreadable });
    await this.settled();
    await this.flush();
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

  /** Conflicts opened and closed, and who wrote each version (for the conflict view). */
  private learn(entries: ChangesResponse["entries"]): void {
    for (const e of entries) {
      if (e.versionId) {
        this.authors.set(e.versionId, { deviceId: e.deviceId, at: Date.parse(e.at) });
        if (this.authors.size > MAX_AUTHORS) {
          const first = this.authors.keys().next();
          if (!first.done) this.authors.delete(first.value);
        }
      }
      if (e.type === "conflict_opened" && e.conflictId) {
        const id = e.conflictId;
        if (!this.openConflicts.some((c) => c.id === id))
          this.openConflicts.push({ id, fileId: e.fileId });
      } else if (e.type === "conflict_resolved" && e.conflictId) {
        this.openConflicts = this.openConflicts.filter((c) => c.id !== e.conflictId);
      }
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
    // I7 (review): the outcome of a file effect with nothing to do next is saved with the next
    // step that has effects or at the end of the cycle; lost in a crash, the scan recovers it.
    const outcome =
      ev.type === "written" ||
      ev.type === "renamed" ||
      ev.type === "trashed" ||
      ev.type === "folderDone";
    if (outcome && effects.every((fx) => fx.type === "persist")) {
      this.st = state;
      this.unsaved = true;
      this.changed();
      return;
    }
    // E5: write-ahead. The new state exists only once saved; nothing else happens before.
    try {
      await this.d.fs.saveState(STATE_FILES.durable, JSON.stringify(state.durable));
    } catch {
      // I3 (review): the step is dropped. Back to idle so the next cycle can run: pending ops are
      // resent identical, a lost file event is recovered by the scan.
      this.log("persist_failed");
      this.st = { ...this.st, vol: { ...this.st.vol, phase: "idle", requestId: null } };
      this.netFailed = true;
      this.changed();
      return;
    }
    this.st = state;
    this.unsaved = false;
    for (const fx of effects) if (fx.type !== "persist") this.perform(fx);
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
            this.learn(r.entries);
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
      if (e instanceof Paused) {
        ev = { type: "networkError", requestId };
      } else if (e instanceof ApiError && e.kind === "cursor_too_old") {
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
    this.closeRealtime();
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
        // Paused or stopped: the batch waits, resent identical later (I6).
        if (this.pausedFlag || this.closed) throw new Paused();
        // Not on disk any more: the commit answers blob_missing, the next cycle decides.
        if (!src) continue;
        if (await this.networkHolds(src.path, src.size)) {
          this.waiting.set(src.path, {
            path: src.path,
            size: src.size,
            direction: "upload",
            reason: "network",
          });
          continue;
        }
        if (this.tooBig(src.size)) {
          // Never lost: it stays on disk and in the queue (blob_missing), shown as deferred.
          this.waiting.set(src.path, {
            path: src.path,
            size: src.size,
            direction: "upload",
            reason: "size",
          });
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
    // I6 (review): closed = like a crash (the scan recovers); paused = done without doing it,
    // retried at the next cycle.
    if (this.closed) return;
    if (this.pausedFlag) {
      await this.dispatch(skipped(fx));
      return;
    }
    let ev: ClientEvent;
    switch (fx.type) {
      case "write": {
        let ok = false;
        try {
          // S-08: a large download on a metered network waits (the index keeps it).
          const remoteSize = this.st.durable.index[fx.fileId]?.size ?? 0;
          if (await this.networkHolds(fx.path, remoteSize)) {
            this.waiting.set(fx.path, {
              path: fx.path,
              size: remoteSize,
              direction: "download",
              reason: "network",
            });
            throw new Held();
          }
          // I4: replacing a local file too big to check here waits, unread.
          const local = fs.streaming ? null : await fs.stat(fx.path).catch(() => null);
          if (local && this.tooBig(local.size)) throw new TooLarge(local.size);
          const parts = this.transfers.download(
            this.d.vaultId,
            fx.hash,
            () => {},
            (total) => {
              if (this.tooBig(total)) throw new TooLarge(total);
            },
          );
          const out = await fs.write(fx.path, parts, fx.expect, fx.hash);
          ok = out === "ok";
          // M3: the file isn't what the cache says: hash it again at the next scan.
          if (out === "changed") delete this.scanner.cache[fx.path];
        } catch (e) {
          if (e instanceof Held) {
            // already recorded as waiting
          } else if (e instanceof TooLarge)
            this.waiting.set(fx.path, {
              path: fx.path,
              size: e.size,
              direction: "download",
              reason: "size",
            });
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
        // Only if the file still holds the content the client decided about; unchanged size and
        // mtime since the scan mean the hash is known without reading the file (I4).
        const st = await fs.stat(fx.path).catch(() => null);
        const known = this.scanner.cache[fx.path];
        const cur =
          st && known && known.size === st.size && known.mtime === st.mtime
            ? known.hash
            : await sha256Hex(fs.read(fx.path)).catch(() => null);
        if (cur !== fx.expect) delete this.scanner.cache[fx.path]; // M3
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
    await this.noteEcho(fx, "ok" in ev && ev.ok);
    await this.dispatch(ev);
  }

  /** Computed once per state (I7: it walks the whole index). */
  private queued(): number {
    if (this.pendingMemo?.st !== this.st)
      this.pendingMemo = { st: this.st, count: pendingOps(this.st).length };
    // Waiting files are never safe (spec §6.3). A waiting upload stops being a pending op once
    // the server answered blob_missing: count it here unless it still is one.
    let waiting = 0;
    if (this.waiting.size > 0) {
      const pendingPaths = new Set(
        pendingChanges(this.st, 0).map((p) => localPath(p.path, this.d.config.configDir)),
      );
      for (const w of this.waiting.values()) if (!pendingPaths.has(w.path)) waiting++;
    }
    const n = this.pendingMemo.count + waiting;
    return n > 0 ? n : this.dirty ? 1 : 0;
  }

  /** Listeners are told once per burst of changes (I7). */
  private changed(): void {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      this.notify();
    });
  }

  private notify(): void {
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
