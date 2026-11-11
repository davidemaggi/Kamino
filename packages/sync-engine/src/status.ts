import type { BlockReason, SyncSnapshot } from "@kamino/status";
import type { Op } from "@kamino/protocol";
import { nextOps, type ClientState } from "@kamino/sync-core";

/** `vault_gone`: the vault was deleted or suspended on the server (re-link to another one). */
export type StopReason = "revoked" | "blocked" | "protocol" | "update_required" | "vault_gone";

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
  /** Why it waits: a metered network (S-08), the in-memory limit (E3), a failed read. */
  reason?: "network" | "size" | "unreadable";
}

/** Every op the client would still send: the unconfirmed batch first, then the rest. */
export function pendingOps(s: ClientState): Op[] {
  const all = { ...s.config, batchSize: Number.MAX_SAFE_INTEGER };
  const sentIds = new Set(s.durable.sent.map((op) => op.fileId));
  const rest = nextOps(
    { ...s, config: all, durable: { ...s.durable, sent: [] } },
    { newId: () => "" },
  ).filter((op) => !sentIds.has(op.fileId));
  return [...s.durable.sent, ...rest];
}

export interface Backlog {
  up: { files: number; bytes: number };
  down: { files: number; bytes: number };
}

/** What is left to send and to receive (initial transfer, E7). */
export function backlogOf(s: ClientState): Backlog {
  const up = { files: 0, bytes: 0 };
  for (const op of pendingOps(s))
    if (op.type === "put") {
      up.files++;
      up.bytes += op.size;
    }
  const down = { files: 0, bytes: 0 };
  for (const e of Object.values(s.durable.index))
    if (
      e.confirmed &&
      !e.materialized &&
      !e.headDeleted &&
      e.head !== null &&
      !e.unavailable &&
      !e.ignored &&
      !e.conflictId
    ) {
      down.files++;
      down.bytes += e.size;
    }
  return { up, down };
}

/** Every change the client would still send, for the status panel. */
export function pendingChanges(s: ClientState, fallbackSince: number): PendingChange[] {
  return pendingOps(s).map((op) => {
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
  vault_gone: "revoked",
};

export function snapshotOf(x: {
  queued: number;
  oldestQueuedAt: number | null;
  lastConfirmedAt: number | null;
  unreachableSince: number | null;
  syncing: boolean;
  conflicts: number;
  stopped: StopReason | null;
  heldDeletions?: number | null;
}): SyncSnapshot {
  const held = !x.stopped && x.heldDeletions != null;
  return {
    queued: held ? x.heldDeletions! : x.queued,
    oldestQueuedAt: x.queued > 0 ? x.oldestQueuedAt : null,
    lastConfirmedAt: x.lastConfirmedAt,
    unreachableSince: x.unreachableSince,
    syncing: x.syncing,
    conflicts: x.conflicts,
    blocked: x.stopped ? BLOCK[x.stopped] : held ? "deletions" : null,
    quotaRatio: null,
    linked: true,
  };
}
