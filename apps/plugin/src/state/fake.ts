import type { SyncSnapshot } from "@kamino/status";
import { INITIAL_SNAPSHOT } from "../ui/StatusIndicator.js";
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

export interface Scenario {
  snapshot: SyncSnapshot;
  conflicts: ConflictDetail[];
  pending: PendingChange[];
  deferred: DeferredFile[];
}

/**
 * In-memory stand-in for the sync engine (until M1/M3). Actions really change the
 * state, so views and the indicator react as they will with real data.
 */
export class FakeSyncState implements SyncStateSource, ConflictActions {
  private snap: SyncSnapshot = { ...INITIAL_SNAPSHOT };
  private items: ConflictDetail[] = [];
  private pendingList: PendingChange[] = [];
  private deferredList: DeferredFile[] = [];
  private readonly listeners = new Set<() => void>();
  private staleNext = false;

  constructor(
    private readonly deviceInfo: DeviceInfo,
    private readonly clock: () => number,
  ) {}

  snapshot(): SyncSnapshot {
    return { ...this.snap };
  }
  conflicts(): ConflictSummary[] {
    return this.items.map(({ id, path, kind, binary, mine, incoming }) => ({
      id,
      path,
      kind,
      binary,
      mine,
      incoming,
    }));
  }
  conflict(id: string): Promise<ConflictDetail | null> {
    return Promise.resolve(this.items.find((c) => c.id === id) ?? null);
  }
  pending(): PendingChange[] {
    return [...this.pendingList];
  }
  deferred(): DeferredFile[] {
    return [...this.deferredList];
  }
  device(): DeviceInfo {
    return this.deviceInfo;
  }
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  setSnapshot(s: SyncSnapshot): void {
    this.snap = { ...s };
    this.emit();
  }
  loadScenario(sc: Scenario): void {
    this.snap = { ...sc.snapshot };
    this.items = [...sc.conflicts];
    this.pendingList = [...sc.pending];
    this.deferredList = [...sc.deferred];
    this.emit();
  }
  /** Test/dev helper: the next resolve() answers "stale" and a newer version arrives. */
  nextResolveStale(): void {
    this.staleNext = true;
  }

  resolve(id: string, resolution: Resolution): Promise<ResolveOutcome> {
    void resolution;
    const index = this.items.findIndex((c) => c.id === id);
    const item = this.items[index];
    if (!item) return Promise.resolve({ ok: false, reason: "gone" });
    if (this.staleNext) {
      this.staleNext = false;
      const incoming = { ...item.incoming, at: this.clock() };
      this.items[index] = item.binary
        ? { ...item, incoming }
        : { ...item, incoming, incomingText: `${item.incomingText}- newer line\n` };
      this.emit();
      return Promise.resolve({ ok: false, reason: "stale" });
    }
    this.items.splice(index, 1);
    this.snap = { ...this.snap, conflicts: Math.max(0, this.snap.conflicts - 1) };
    this.emit();
    return Promise.resolve({ ok: true });
  }

  resolveAll(strategy: BulkStrategy): Promise<{ resolved: number }> {
    void strategy;
    const resolved = this.items.length;
    this.items = [];
    this.snap = { ...this.snap, conflicts: 0 };
    this.emit();
    return Promise.resolve({ resolved });
  }

  syncNow(): Promise<void> {
    if (this.snap.unreachableSince === null) {
      this.pendingList = [];
      this.snap = { ...this.snap, queued: 0, oldestQueuedAt: null, lastConfirmedAt: this.clock() };
    }
    this.emit();
    return Promise.resolve();
  }

  uploadNow(path: string): Promise<void> {
    this.deferredList = this.deferredList.filter((d) => d.path !== path);
    this.emit();
    return Promise.resolve();
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb();
  }
}
