/** Sync status levels, least to most severe. Order is the severity. */
export const LEVELS = ["safe", "working", "attention", "decision", "blocked"] as const;
export type Level = (typeof LEVELS)[number];

export function severity(level: Level): number {
  return LEVELS.indexOf(level);
}

export const STATUS_KEYS = [
  "safe",
  "working.syncing",
  "working.queued",
  "working.neverSynced",
  "attention.offline",
  "attention.stale",
  "attention.quota",
  "decision.conflicts",
  "blocked.quota",
  "blocked.revoked",
  "blocked.auth",
  "blocked.protocol",
  "note.unreachable",
] as const;
export type StatusKey = (typeof STATUS_KEYS)[number];

/** Lucide icon names (shared by lucide-react and Obsidian's setIcon). */
export type IconName =
  | "shield-check"
  | "refresh-cw"
  | "clock"
  | "cloud-off"
  | "triangle-alert"
  | "git-compare-arrows"
  | "octagon-alert";

export const MESSAGE_ICON: Record<StatusKey, IconName> = {
  safe: "shield-check",
  "working.syncing": "refresh-cw",
  "working.queued": "clock",
  "working.neverSynced": "clock",
  "attention.offline": "cloud-off",
  "attention.stale": "triangle-alert",
  "attention.quota": "triangle-alert",
  "decision.conflicts": "git-compare-arrows",
  "blocked.quota": "octagon-alert",
  "blocked.revoked": "octagon-alert",
  "blocked.auth": "octagon-alert",
  "blocked.protocol": "octagon-alert",
  "note.unreachable": "cloud-off",
};
