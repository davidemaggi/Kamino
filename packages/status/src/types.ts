import type { IconName, Level, StatusKey } from "./levels.js";

export type BlockReason = "quota" | "revoked" | "auth" | "protocol";

/** Point-in-time sync state of one device. All times are epoch ms. */
export interface SyncSnapshot {
  queued: number;
  oldestQueuedAt: number | null;
  lastConfirmedAt: number | null;
  unreachableSince: number | null;
  syncing: boolean;
  conflicts: number;
  blocked: BlockReason | null;
  quotaRatio: number | null;
}

export interface Thresholds {
  staleQueueMs: number;
  unreachableMs: number;
  quotaWarnRatio: number;
}

const HOUR = 3_600_000;
export const DEFAULT_THRESHOLDS: Thresholds = {
  staleQueueMs: HOUR,
  unreachableMs: 24 * HOUR,
  quotaWarnRatio: 0.9,
};

export interface StatusMessage {
  key: StatusKey;
  params: Record<string, number>;
}

export interface StatusDescription {
  level: Level;
  message: StatusMessage;
  /** Other true conditions, most severe first. */
  secondary: StatusMessage[];
  icon: IconName;
  lastConfirmedAt: number | null;
}
