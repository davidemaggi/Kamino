import type { Level, StatusKey } from "./levels.js";
import type { SyncSnapshot } from "./types.js";

export interface ExampleSnapshot {
  id: string;
  snapshot: SyncSnapshot;
  expected: { level: Level; key: StatusKey };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const base: SyncSnapshot = {
  queued: 0,
  oldestQueuedAt: null,
  lastConfirmedAt: null,
  unreachableSince: null,
  syncing: false,
  conflicts: 0,
  blocked: null,
  quotaRatio: 0.4,
};

/** Named snapshots for galleries and example tests, relative to `now`. */
export function exampleSnapshots(now: number): ExampleSnapshot[] {
  const synced = { ...base, lastConfirmedAt: now - 2 * MIN };
  return [
    { id: "safe", snapshot: synced, expected: { level: "safe", key: "safe" } },
    {
      id: "never-synced",
      snapshot: base,
      expected: { level: "working", key: "working.neverSynced" },
    },
    {
      id: "not-linked",
      snapshot: { ...base, linked: false },
      expected: { level: "working", key: "working.notLinked" },
    },
    {
      id: "queued",
      snapshot: { ...synced, queued: 3, oldestQueuedAt: now - 10_000 },
      expected: { level: "working", key: "working.queued" },
    },
    {
      id: "syncing",
      snapshot: { ...synced, queued: 3, oldestQueuedAt: now - 10_000, syncing: true },
      expected: { level: "working", key: "working.syncing" },
    },
    {
      id: "offline-below-threshold",
      snapshot: { ...synced, unreachableSince: now - 3 * HOUR },
      expected: { level: "safe", key: "safe" },
    },
    {
      id: "offline-2-days",
      snapshot: {
        ...synced,
        lastConfirmedAt: now - 2 * DAY,
        unreachableSince: now - 2 * DAY,
        queued: 14,
        oldestQueuedAt: now - 2 * DAY,
      },
      expected: { level: "attention", key: "attention.offline" },
    },
    {
      id: "stale-queue",
      snapshot: { ...synced, queued: 5, oldestQueuedAt: now - 2 * HOUR },
      expected: { level: "attention", key: "attention.stale" },
    },
    {
      id: "quota-95",
      snapshot: { ...synced, quotaRatio: 0.95 },
      expected: { level: "attention", key: "attention.quota" },
    },
    {
      id: "one-conflict",
      snapshot: { ...synced, conflicts: 1 },
      expected: { level: "decision", key: "decision.conflicts" },
    },
    {
      id: "conflicts-and-offline",
      snapshot: { ...synced, conflicts: 3, unreachableSince: now - 2 * DAY },
      expected: { level: "decision", key: "decision.conflicts" },
    },
    {
      id: "quota-full",
      snapshot: {
        ...synced,
        blocked: "quota",
        queued: 12,
        oldestQueuedAt: now - HOUR,
        quotaRatio: 1,
      },
      expected: { level: "blocked", key: "blocked.quota" },
    },
    {
      id: "revoked",
      snapshot: { ...synced, blocked: "revoked" },
      expected: { level: "blocked", key: "blocked.revoked" },
    },
    {
      id: "auth-expired",
      snapshot: { ...synced, blocked: "auth", queued: 2, oldestQueuedAt: now - 5 * MIN },
      expected: { level: "blocked", key: "blocked.auth" },
    },
    {
      id: "protocol-incompatible",
      snapshot: { ...synced, blocked: "protocol" },
      expected: { level: "blocked", key: "blocked.protocol" },
    },
  ];
}
