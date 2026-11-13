import type { SyncSnapshot } from "@kamino/status";

export type ConflictKind = "concurrent_edit" | "both_created";

export interface VersionInfo {
  device: string;
  /** epoch ms; null when not known on this device. */
  at: number | null;
}

export interface ConflictSummary {
  id: string;
  path: string;
  kind: ConflictKind;
  binary: boolean;
  mine: VersionInfo;
  incoming: VersionInfo;
  /** Not resolvable on this device (it has the server's side): from the other one or the web. */
  elsewhere?: boolean;
}

export interface BinaryInfo {
  size: number;
  mime: string;
  /** Only for images. */
  previewUrl: string | null;
}

export type ConflictDetail =
  | (ConflictSummary & { binary: false; mineText: string; incomingText: string })
  | (ConflictSummary & { binary: true; mineFile: BinaryInfo; incomingFile: BinaryInfo });

export interface PendingChange {
  path: string;
  op: "create" | "modify" | "delete" | "rename";
  since: number;
}

export interface DeferredFile {
  path: string;
  size: number;
  direction: "upload" | "download";
  /** Why it waits: a metered network (S-08), the in-memory limit, a failed read. */
  reason?: "network" | "size" | "unreadable";
}

export interface DeviceInfo {
  name: string;
  mode: "live" | "periodic" | "manual";
  /** Host only. */
  server: string;
}

export type Resolution =
  | { type: "keep_mine" }
  | { type: "keep_incoming" }
  | { type: "keep_both" }
  | { type: "manual"; text: string };

/** gone = already resolved elsewhere. */
export type ResolveOutcome = { ok: true } | { ok: false; reason: "stale" | "gone" };

export type BulkStrategy = "keep_mine" | "keep_incoming" | "keep_both";

export interface SyncStateSource {
  snapshot(): SyncSnapshot;
  conflicts(): ConflictSummary[];
  conflict(id: string): Promise<ConflictDetail | null>;
  pending(): PendingChange[];
  deferred(): DeferredFile[];
  device(): DeviceInfo;
  /** Returns the function that stops listening. */
  onChange(cb: () => void): () => void;
}

export interface ConflictActions {
  resolve(id: string, resolution: Resolution): Promise<ResolveOutcome>;
  /** Resolves only the given conflicts (the ones the user saw), if still open. */
  resolveAll(strategy: BulkStrategy, ids: readonly string[]): Promise<{ resolved: number }>;
  syncNow(): Promise<void>;
  /** Sends or fetches now a file deferred to Wi-Fi (direction from DeferredFile). */
  transferNow(path: string): Promise<void>;
  /** Sends the deletions held because too many files vanished at once (status "deletions"). */
  confirmDeletions?(): Promise<void>;
}
