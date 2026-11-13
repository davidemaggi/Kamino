import type { FinalResult } from "@kamino/protocol";
import type { ArbiterView, ConflictRecord, FileRecord, OpenConflict } from "@kamino/sync-core";

export type Need =
  | { kind: "recorded"; opId: string }
  | { kind: "file"; fileId: string }
  | { kind: "liveAt"; key: string }
  | { kind: "conflict"; fileId: string }
  | { kind: "conflictById"; conflictId: string }
  | { kind: "descendants"; path: string }
  | { kind: "version"; versionId: string }
  | { kind: "blob"; hash: string };

/** Thrown by the view when decide() reads something not loaded yet (C3). */
export class NeedData extends Error {
  constructor(readonly need: Need) {
    super("need data");
  }
}

/** A synchronous ArbiterView over data loaded from the DB; misses ask for more. */
export class PrefetchedView implements ArbiterView {
  readonly recordedMap = new Map<string, FinalResult | null>();
  readonly files = new Map<string, FileRecord | null>();
  readonly live = new Map<string, FileRecord | null>();
  readonly conflicts = new Map<string, OpenConflict | null>();
  readonly conflictsById = new Map<string, ConflictRecord | null>();
  readonly descendants = new Map<string, boolean>();
  readonly versions = new Map<string, boolean>();
  readonly blobs = new Map<string, boolean>();

  private get<K, V>(m: Map<K, V>, k: K, need: Need): V {
    if (!m.has(k)) throw new NeedData(need);
    return m.get(k) as V;
  }
  recorded(opId: string) {
    return this.get(this.recordedMap, opId, { kind: "recorded", opId }) ?? undefined;
  }
  file(fileId: string) {
    return this.get(this.files, fileId, { kind: "file", fileId }) ?? undefined;
  }
  liveAt(key: string) {
    return this.get(this.live, key, { kind: "liveAt", key }) ?? undefined;
  }
  openConflict(fileId: string) {
    return this.get(this.conflicts, fileId, { kind: "conflict", fileId }) ?? undefined;
  }
  conflict(conflictId: string) {
    return (
      this.get(this.conflictsById, conflictId, { kind: "conflictById", conflictId }) ?? undefined
    );
  }
  hasLiveDescendants(path: string) {
    return this.get(this.descendants, path, { kind: "descendants", path });
  }
  versionExists(versionId: string) {
    return this.get(this.versions, versionId, { kind: "version", versionId });
  }
  blobPresent(hash: string) {
    return this.get(this.blobs, hash, { kind: "blob", hash });
  }
}
