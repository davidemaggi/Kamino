import type { SyncSnapshot } from "@kamino/status";
import type {
  ConflictDetail as EngineConflictDetail,
  ConflictInfo,
  ConflictSide,
  ResolveRequest,
  ResolveResult,
} from "@kamino/sync-engine";
import type {
  BulkStrategy,
  ConflictActions,
  ConflictDetail,
  ConflictSummary,
  DeferredFile,
  DeviceInfo,
  PendingChange,
  Resolution,
  ResolveOutcome,
  SyncStateSource,
  VersionInfo,
} from "./types.js";

/** What the views need from the engine. */
export interface StateEngine {
  snapshot(): SyncSnapshot;
  conflicts(): ConflictInfo[];
  conflictDetail(id: string, content: boolean): Promise<EngineConflictDetail | null>;
  resolve(requests: readonly ResolveRequest[]): Promise<ResolveResult[]>;
  pending(): PendingChange[];
  deferred(): DeferredFile[];
  syncNow(): Promise<void>;
  confirmDeletions(): Promise<void>;
  transferNow(path: string): Promise<void>;
  onChange(cb: () => void): () => void;
}

export interface EngineStateOptions {
  engine: () => StateEngine | null;
  /** The engine is created or replaced (link, unlink). */
  onHostChange: (cb: () => void) => () => void;
  device: () => DeviceInfo;
  notice: (message: string) => void;
  /** Texts the state needs (the views have the rest). */
  labels: {
    /** Word in the name of a "keep both" copy (`conflict`, `conflitto`). */
    copy: string;
    webApp: string;
    otherDevice: string;
    failed: string;
  };
}

/** Shown as text with a diff; anything else is a file card (no content loaded). */
const TEXT = /\.(md|txt|canvas|json|css|js|base|csv|html|xml|yml|yaml)$/i;
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};
const mimeOf = (path: string) =>
  MIME[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

const choiceOf = (s: BulkStrategy | Resolution["type"]): ResolveRequest["choice"] =>
  s === "keep_mine" || s === "manual" ? "mine" : s === "keep_incoming" ? "incoming" : "both";

const NOT_LINKED: SyncSnapshot = {
  queued: 0,
  oldestQueuedAt: null,
  lastConfirmedAt: null,
  unreachableSince: null,
  syncing: false,
  conflicts: 0,
  blocked: null,
  quotaRatio: null,
  linked: false,
};

/** The real `SyncStateSource` (E8): everything comes from the engine, never invented. */
export class EngineState implements SyncStateSource, ConflictActions {
  private readonly listeners = new Set<() => void>();
  private offEngine: (() => void) | null = null;
  /** Who wrote the incoming version and when, per conflict, once asked for (no contents). */
  private readonly meta = new Map<
    string,
    { head: string; kind: ConflictSummary["kind"]; mine: VersionInfo; incoming: VersionInfo }
  >();
  private readonly loading = new Set<string>();

  constructor(private readonly o: EngineStateOptions) {
    o.onHostChange(() => {
      this.follow();
      this.emit();
    });
    this.follow();
  }

  private follow(): void {
    this.offEngine?.();
    this.offEngine = this.o.engine()?.onChange(() => this.emit()) ?? null;
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb();
  }

  snapshot(): SyncSnapshot {
    return this.o.engine()?.snapshot() ?? NOT_LINKED;
  }

  /** Listed from the engine; who and when arrive a moment later (then the views refresh). */
  conflicts(): ConflictSummary[] {
    const e = this.o.engine();
    if (!e) return [];
    const unknown: VersionInfo = { device: this.o.labels.otherDevice, at: null };
    return e.conflicts().map((c) => {
      const m = this.meta.get(c.id);
      if (!m && c.here) this.loadMeta(e, c.id);
      return {
        id: c.id,
        path: c.path ?? c.id,
        kind: m?.kind ?? "concurrent_edit",
        binary: c.path !== null && !TEXT.test(c.path),
        mine: m?.mine ?? { device: this.o.device().name, at: null },
        incoming: m?.incoming ?? unknown,
        ...(c.here ? {} : { elsewhere: true }),
      };
    });
  }

  private loadMeta(e: StateEngine, id: string): void {
    if (this.loading.has(id)) return;
    this.loading.add(id);
    void e
      .conflictDetail(id, false)
      .then((d) => {
        if (d) this.meta.set(id, this.metaOf(d));
        if (d) this.emit();
      })
      .catch(() => {})
      .finally(() => this.loading.delete(id));
  }

  private author(side: ConflictSide): string {
    const a = side.author;
    return a === null
      ? this.o.labels.otherDevice
      : a.kind === "web"
        ? this.o.labels.webApp
        : a.name;
  }

  private metaOf(d: EngineConflictDetail) {
    return {
      head: d.head,
      kind: d.kind,
      mine: { device: this.o.device().name, at: d.mine.at },
      incoming: { device: this.author(d.incoming), at: d.incoming.at },
    };
  }

  async conflict(id: string): Promise<ConflictDetail | null> {
    const e = this.o.engine();
    const c = e?.conflicts().find((x) => x.id === id);
    if (!e || !c?.here) return null;
    const binary = c.path !== null && !TEXT.test(c.path);
    let d: EngineConflictDetail | null;
    try {
      d = await e.conflictDetail(id, !binary);
    } catch {
      this.o.notice(this.o.labels.failed);
      return null;
    }
    if (!d) return null;
    const meta = this.metaOf(d);
    this.meta.set(id, meta);
    const base = { id, path: d.path, kind: d.kind, mine: meta.mine, incoming: meta.incoming };
    if (!binary) {
      const dec = new TextDecoder();
      return {
        ...base,
        binary: false,
        mineText: d.mine.bytes ? dec.decode(d.mine.bytes) : "",
        incomingText: d.incoming.bytes ? dec.decode(d.incoming.bytes) : "",
      };
    }
    const file = (side: ConflictSide) => ({
      size: side.size ?? 0,
      mime: mimeOf(d.path),
      previewUrl: null,
    });
    return { ...base, binary: true, mineFile: file(d.mine), incomingFile: file(d.incoming) };
  }

  pending(): PendingChange[] {
    return this.o.engine()?.pending() ?? [];
  }

  deferred(): DeferredFile[] {
    return this.o.engine()?.deferred() ?? [];
  }

  device(): DeviceInfo {
    return this.o.device();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** The choice against the incoming version the user saw (stale if it changed since). */
  async resolve(id: string, resolution: Resolution): Promise<ResolveOutcome> {
    const e = this.o.engine();
    const head = this.meta.get(id)?.head;
    if (!e || !e.conflicts().some((c) => c.id === id)) return { ok: false, reason: "gone" };
    if (!head) return { ok: false, reason: "stale" };
    const [r] = await e.resolve([this.request(id, head, resolution.type, resolution)]);
    this.meta.delete(id);
    this.emit();
    if (r === "ok" || r === "queued") return { ok: true };
    return { ok: false, reason: r === "gone" ? "gone" : "stale" };
  }

  /** Only the conflicts the user saw, against the versions shown then; the rest are skipped. */
  async resolveAll(strategy: BulkStrategy, ids: readonly string[]): Promise<{ resolved: number }> {
    const e = this.o.engine();
    if (!e) return { resolved: 0 };
    const reqs = ids.flatMap((id) => {
      const head = this.meta.get(id)?.head;
      return head ? [this.request(id, head, strategy, null)] : [];
    });
    if (reqs.length === 0) return { resolved: 0 };
    const out = await e.resolve(reqs);
    for (const r of reqs) this.meta.delete(r.id);
    this.emit();
    return { resolved: out.filter((r) => r === "ok" || r === "queued").length };
  }

  private request(
    id: string,
    head: string,
    type: BulkStrategy | Resolution["type"],
    resolution: Resolution | null,
  ): ResolveRequest {
    const choice = choiceOf(type);
    return {
      id,
      head,
      choice,
      ...(resolution?.type === "manual" ? { text: new TextEncoder().encode(resolution.text) } : {}),
      ...(choice === "both"
        ? { copy: { label: this.o.labels.copy, device: this.o.device().name } }
        : {}),
    };
  }

  async syncNow(): Promise<void> {
    await this.o.engine()?.syncNow();
  }

  async confirmDeletions(): Promise<void> {
    await this.o.engine()?.confirmDeletions();
  }

  /** "Carica/scarica ora" on a waiting file: the engine lets it through once (S-08). */
  async transferNow(path: string): Promise<void> {
    await this.o.engine()?.transferNow(path);
  }
}
