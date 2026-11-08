import { MESSAGE_ICON, severity, type Level } from "./levels.js";
import type { StatusDescription, StatusMessage, SyncSnapshot, Thresholds } from "./types.js";

interface Finding {
  level: Level;
  message: StatusMessage;
  note?: true;
}

/**
 * Pure mapping snapshot -> status. Time enters only through `now`.
 * Rules: docs/superpowers/specs/2026-11-07-ui-fondamenta-design.md §3.3.
 */
export function describeStatus(s: SyncSnapshot, th: Thresholds, now: number): StatusDescription {
  const found: Finding[] = [];
  const add = (level: Level, key: StatusMessage["key"], params: Record<string, number> = {}) =>
    found.push({ level, message: { key, params } });

  if (s.blocked !== null) add("blocked", `blocked.${s.blocked}`, { count: s.queued });
  if (s.conflicts > 0) add("decision", "decision.conflicts", { count: s.conflicts });

  const unreachableMs = s.unreachableSince === null ? null : now - s.unreachableSince;
  if (unreachableMs !== null && unreachableMs >= th.unreachableMs) {
    add("attention", "attention.offline", { ageMs: unreachableMs, count: s.queued });
  }
  if (s.queued > 0 && s.oldestQueuedAt !== null && now - s.oldestQueuedAt >= th.staleQueueMs) {
    add("attention", "attention.stale", { count: s.queued, ageMs: now - s.oldestQueuedAt });
  }
  if (s.quotaRatio !== null && s.quotaRatio >= th.quotaWarnRatio) {
    add("attention", "attention.quota", { percent: Math.round(s.quotaRatio * 100) });
  }
  if (s.queued > 0) {
    add("working", s.syncing ? "working.syncing" : "working.queued", { count: s.queued });
  } else if (s.lastConfirmedAt === null) {
    add("working", "working.neverSynced");
  }
  if (unreachableMs !== null && unreachableMs < th.unreachableMs) {
    found.push({
      level: "safe",
      message: { key: "note.unreachable", params: { ageMs: unreachableMs } },
      note: true,
    });
  }

  // Stable sort: within a level, insertion order above is the priority.
  found.sort((a, b) => severity(b.level) - severity(a.level));
  const primary = found.find((f) => !f.note);
  const message: StatusMessage = primary?.message ?? { key: "safe", params: {} };
  return {
    level: primary?.level ?? "safe",
    message,
    secondary: found.filter((f) => f !== primary).map((f) => f.message),
    icon: MESSAGE_ICON[message.key],
    lastConfirmedAt: s.lastConfirmedAt,
  };
}
