import type { BlockReason, SyncSnapshot } from "@kamino/status";
import { nextOps, type ClientState } from "@kamino/sync-core";

export type StopReason = "revoked" | "blocked" | "protocol" | "update_required";

/** A local change not yet confirmed by the server (canonical path). */
export interface PendingChange {
  path: string;
  op: "create" | "modify" | "delete" | "rename";
  since: number;
}

/** A file that can't be transferred on this device for now (E3); never lost. */
export interface DeferredFile {
  path: string;
  size: number;
  direction: "upload" | "download";
}

/** Every change the client would still send: the unconfirmed batch first, then the rest. */
export function pendingChanges(s: ClientState, fallbackSince: number): PendingChange[] {
  const all = { ...s.config, batchSize: Number.MAX_SAFE_INTEGER };
  const sentIds = new Set(s.durable.sent.map((op) => op.fileId));
  const rest = nextOps(
    { ...s, config: all, durable: { ...s.durable, sent: [] } },
    { newId: () => "" },
  ).filter((op) => !sentIds.has(op.fileId));
  return [...s.durable.sent, ...rest].map((op) => {
    const e = s.durable.index[op.fileId];
    switch (op.type) {
      case "put":
        return {
          path: op.path,
          op: op.baseVersionId === null && !e?.confirmed ? "create" : "modify",
          since: op.mtime || fallbackSince,
        };
      case "move":
        return { path: op.toPath, op: "rename", since: fallbackSince };
      case "delete":
        return { path: e?.path ?? "", op: "delete", since: fallbackSince };
      case "mkdir":
        return { path: op.path, op: "create", since: fallbackSince };
    }
  });
}

const BLOCK: Record<StopReason, BlockReason> = {
  revoked: "revoked",
  blocked: "auth",
  protocol: "protocol",
  update_required: "protocol",
};

export function snapshotOf(x: {
  queued: number;
  oldestQueuedAt: number | null;
  lastConfirmedAt: number | null;
  unreachableSince: number | null;
  syncing: boolean;
  conflicts: number;
  stopped: StopReason | null;
}): SyncSnapshot {
  return {
    queued: x.queued,
    oldestQueuedAt: x.queued > 0 ? x.oldestQueuedAt : null,
    lastConfirmedAt: x.lastConfirmedAt,
    unreachableSince: x.unreachableSince,
    syncing: x.syncing,
    conflicts: x.conflicts,
    blocked: x.stopped ? BLOCK[x.stopped] : null,
    quotaRatio: null,
    linked: true,
  };
}
