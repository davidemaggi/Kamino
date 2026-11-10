import type { Vault } from "@kamino/protocol";

export type Level = Vault["level"];

/** What a device's level depends on (03 §12, S-06, D-06). */
export interface DeviceFacts {
  cursor: number;
  pending: number;
  deferred: number;
  lastSync: Date | null;
  lastAck: Date | null;
  error: string | null;
  revoked: boolean;
}

/** "Safe" only when caught up with the head, nothing queued, and synced at least once. */
export function deviceLevel(d: DeviceFacts, headSeq: number): Level {
  if (d.revoked) return "blocked";
  if (d.error !== null) return "attention";
  if (
    d.cursor < headSeq ||
    d.pending > 0 ||
    d.deferred > 0 ||
    (d.lastSync === null && d.lastAck === null)
  )
    return "working";
  return "safe";
}

/** Worst first: a decision to take, then attention, then work in progress (also: no device yet). */
export function vaultLevel(openConflicts: number, devices: DeviceFacts[], headSeq: number): Level {
  if (openConflicts > 0) return "decision";
  const levels = devices.filter((d) => !d.revoked).map((d) => deviceLevel(d, headSeq));
  if (levels.includes("attention")) return "attention";
  if (levels.length === 0 || levels.includes("working")) return "working";
  return "safe";
}
