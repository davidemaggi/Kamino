import type { SyncSnapshot } from "@kamino/status";
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
} from "./types.js";

/** What the views need from the engine. */
export interface StateEngine {
  snapshot(): SyncSnapshot;
  conflicts(): { id: string; fileId: string; path: string | null }[];
  pending(): PendingChange[];
  deferred(): DeferredFile[];
  syncNow(): Promise<void>;
  confirmDeletions(): Promise<void>;
  onChange(cb: () => void): () => void;
}

export interface EngineStateOptions {
  engine: () => StateEngine | null;
  /** The engine is created or replaced (link, unlink). */
  onHostChange: (cb: () => void) => () => void;
  device: () => DeviceInfo;
  notice: (message: string) => void;
  /** "Coming soon" text for conflict resolution (M3). */
  comingSoon: string;
}

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

  /** Listed from the engine; details and resolution arrive with M3. */
  conflicts(): ConflictSummary[] {
    const e = this.o.engine();
    if (!e) return [];
    return e.conflicts().map((c) => ({
      id: c.id,
      path: c.path ?? c.id,
      kind: "concurrent_edit",
      binary: c.path !== null && !/\.(md|txt|canvas|json|css|js|base)$/i.test(c.path),
      mine: { device: "", at: 0 },
      incoming: { device: "", at: 0 },
    }));
  }

  conflict(id: string): Promise<ConflictDetail | null> {
    void id;
    return Promise.resolve(null);
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

  resolve(id: string, resolution: Resolution): Promise<ResolveOutcome> {
    void id;
    void resolution;
    this.o.notice(this.o.comingSoon);
    return Promise.resolve({ ok: false, reason: "stale" });
  }

  resolveAll(strategy: BulkStrategy, ids: readonly string[]): Promise<{ resolved: number }> {
    void strategy;
    void ids;
    this.o.notice(this.o.comingSoon);
    return Promise.resolve({ resolved: 0 });
  }

  async syncNow(): Promise<void> {
    await this.o.engine()?.syncNow();
  }

  async confirmDeletions(): Promise<void> {
    await this.o.engine()?.confirmDeletions();
  }

  /** Wi-Fi-only deferral arrives with M2b: for now a cycle tries everything again. */
  async transferNow(path: string): Promise<void> {
    void path;
    await this.syncNow();
  }
}
