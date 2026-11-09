import type { Op, OpResult } from "@kamino/protocol";
import { describe, expect, it } from "vitest";
import {
  initialState,
  retryDelay,
  step,
  type ClientEvent,
  type ClientState,
  type Effect,
} from "./client.js";
import { DEFAULT_SETTINGS } from "./exclusions.js";
import { MemoryStore } from "./store.js";

let n = 0;
const env = { newId: () => `id${++n}` };
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const scanItem = (path: string, hash: string) => ({ path, hash, size: 1, mtime: 0 });

function client(platform: "linux" | "windows" = "linux"): ClientState {
  return initialState({
    deviceId: "dev",
    platform,
    configDir: ".obsidian",
    settings: DEFAULT_SETTINGS,
    batchSize: 500,
  });
}
function run(s: ClientState, e: ClientEvent) {
  return step(s, e, env);
}
const ofType = <T extends Effect["type"]>(fx: Effect[], t: T) =>
  fx.filter((f): f is Extract<Effect, { type: T }> => f.type === t);

/** Answers pull requests (from the store, or empty) until the client stops asking. */
function finishPulls(r: { state: ClientState; effects: Effect[] }, store?: MemoryStore) {
  let { state } = r;
  const effects = [...r.effects];
  let pull = ofType(r.effects, "pull")[0];
  while (pull) {
    const res = store ? store.changes(pull.after) : { entries: [], head: 0, hasMore: false };
    const next = run(state, { type: "pullResult", requestId: pull.requestId, ...res });
    state = next.state;
    effects.push(...next.effects);
    pull = ofType(next.effects, "pull")[0];
  }
  return { state, effects };
}

/** A joined client (empty snapshot already applied, first pull done). */
function joined(platform: "linux" | "windows" = "linux"): ClientState {
  const s = run(client(platform), { type: "sync", scan: [] }).state;
  const r = run(s, {
    type: "snapshotResult",
    requestId: s.vol.requestId!,
    snapshot: { head: 0, files: [], openConflicts: [] },
  });
  return finishPulls(r).state;
}

/** A full cycle against a store: scan, push, pull. */
function push(s: ClientState, store: MemoryStore, scan: ReturnType<typeof scanItem>[]) {
  const r1 = run(s, { type: "sync", scan });
  const p = ofType(r1.effects, "push")[0];
  if (!p) return { ...finishPulls(r1, store), ops: [] as Op[] };
  for (const h of p.hashes) store.blobs.add(h);
  const res = store.commit(p.ops, "dev");
  const r2 = run(r1.state, {
    type: "pushResult",
    requestId: p.requestId,
    results: res.results,
    head: res.head,
  });
  const done = finishPulls(r2, store);
  return { state: done.state, effects: [...r1.effects, ...done.effects], ops: p.ops };
}

describe("client", () => {
  it("persist always comes first (write-ahead)", () => {
    const r = run(joined(), { type: "sync", scan: [scanItem("a.md", H1)] });
    expect(r.effects[0]).toEqual({ type: "persist" });
  });

  it("joining an empty server uploads everything (V-05)", () => {
    let s = client();
    let r = run(s, { type: "sync", scan: [scanItem("a.md", H1)] });
    const snap = ofType(r.effects, "snapshot")[0]!;
    r = run(r.state, {
      type: "snapshotResult",
      requestId: snap.requestId,
      snapshot: { head: 0, files: [], openConflicts: [] },
    });
    const p = ofType(r.effects, "push")[0]!;
    expect(p.ops).toMatchObject([
      { type: "put", path: "a.md", baseVersionId: null, contentHash: H1 },
    ]);
    s = r.state;
    expect(s.durable.sent).toHaveLength(1);
  });

  it("new, modified, renamed and deleted files become ops; accepted results update the index", () => {
    const store = new MemoryStore();
    let { state: s, ops } = push(joined(), store, [scanItem("a.md", H1)]);
    expect(ops).toMatchObject([{ type: "put", baseVersionId: null }]);
    const fileId = ops[0]!.fileId;
    expect(s.durable.index[fileId]).toMatchObject({
      confirmed: true,
      baseHash: H1,
      remotePath: "a.md",
    });
    expect(s.durable.sent).toEqual([]);

    const firstVersion = s.durable.index[fileId]!.base;
    ({ state: s, ops } = push(s, store, [scanItem("a.md", H2)]));
    expect(ops).toMatchObject([{ type: "put", baseVersionId: firstVersion }]);
    expect(store.files.get(fileId)!.headHash).toBe(H2);

    s = run(s, { type: "localRename", from: "a.md", to: "b.md" }).state;
    ({ state: s, ops } = push(s, store, [scanItem("b.md", H2)]));
    expect(ops).toMatchObject([{ type: "move", fromPath: "a.md", toPath: "b.md" }]);

    ({ state: s, ops } = push(s, store, []));
    expect(ops).toMatchObject([{ type: "delete" }]);
    expect(s.durable.index[fileId]).toMatchObject({
      headDeleted: true,
      localHash: null,
      materialized: false,
    });
    expect(store.files.get(fileId)!.deleted).toBe(true);
  });

  it("an op with unknown outcome is resent identical (same opId)", () => {
    const store = new MemoryStore();
    const r1 = run(joined(), { type: "sync", scan: [scanItem("a.md", H1)] });
    const p1 = ofType(r1.effects, "push")[0]!;
    const s = run(r1.state, { type: "networkError", requestId: p1.requestId }).state;
    const r2 = run(s, { type: "sync", scan: [scanItem("a.md", H2)] });
    const p2 = ofType(r2.effects, "push")[0]!;
    expect(p2.ops).toEqual(p1.ops);
    store.blobs.add(H1);
    const res = store.commit(p2.ops, "dev");
    // As soon as the first version is confirmed, the newer content goes out (same response).
    const after = run(r2.state, {
      type: "pushResult",
      requestId: p2.requestId,
      results: res.results,
      head: res.head,
    });
    const again = ofType(after.effects, "push")[0]!;
    expect(again.ops).toMatchObject([{ type: "put", contentHash: H2 }]);
  });

  it("a conflict marks the file and never overwrites the local copy", () => {
    let s = joined();
    const r = run(s, { type: "sync", scan: [scanItem("a.md", H1)] });
    const p = ofType(r.effects, "push")[0]!;
    const conflict: OpResult = { status: "conflict", conflictId: "c1", headVersionId: "vx" };
    s = run(r.state, {
      type: "pushResult",
      requestId: p.requestId,
      results: [conflict],
      head: 5,
    }).state;
    const e = Object.values(s.durable.index)[0]!;
    expect(e.conflictId).toBe("c1");
    const pull = run(s, { type: "sync", scan: [scanItem("a.md", H2)] });
    expect(ofType(pull.effects, "push")).toEqual([]);
    const req = pull.state.vol.requestId!;
    const after = run(pull.state, {
      type: "pullResult",
      requestId: req,
      hasMore: false,
      head: 6,
      entries: [
        {
          seq: 6,
          type: "file_put",
          fileId: e.fileId,
          versionId: "v9",
          path: "a.md",
          contentHash: H1,
          deviceId: "other",
          at: "",
        },
      ],
    });
    expect(ofType(after.effects, "write")).toEqual([]);
  });

  it("remote put: written when unmodified (expect = local hash), held back when modified", () => {
    const store = new MemoryStore();
    const { state } = push(joined(), store, [scanItem("a.md", H1)]);
    const e = Object.values(state.durable.index)[0]!;
    const entry = {
      seq: 9,
      type: "file_put",
      fileId: e.fileId,
      versionId: "v9",
      path: "a.md",
      contentHash: H2,
      deviceId: "other",
      at: "",
    };
    const pullFrom = (s: ClientState, scan: ReturnType<typeof scanItem>[]) => {
      const r = run(s, { type: "sync", scan });
      return run(r.state, {
        type: "pullResult",
        requestId: r.state.vol.requestId!,
        entries: [entry],
        head: 9,
        hasMore: false,
      });
    };
    const clean = pullFrom(state, [scanItem("a.md", H1)]);
    expect(ofType(clean.effects, "write")).toMatchObject([{ path: "a.md", hash: H2, expect: H1 }]);
    expect(clean.state.durable.index[e.fileId]!.pendingWrite).toEqual({
      versionId: "v9",
      hash: H2,
    });
    const written = run(clean.state, { type: "written", fileId: e.fileId, ok: true }).state;
    expect(written.durable.index[e.fileId]).toMatchObject({
      localHash: H2,
      baseHash: H2,
      base: "v9",
      pendingWrite: null,
    });
    expect(ofType(clean.effects, "ack")).toEqual([{ type: "ack", seq: 9 }]);

    // Modified here, not yet pushed: the remote version must not be written over it.
    const edited: ClientState = {
      ...state,
      vol: { phase: "pulling", requestId: "r1", stopped: null },
      durable: {
        ...state.durable,
        index: { [e.fileId]: { ...state.durable.index[e.fileId]!, localHash: "3".repeat(64) } },
      },
    };
    const held = run(edited, {
      type: "pullResult",
      requestId: "r1",
      entries: [entry],
      head: 9,
      hasMore: false,
    });
    expect(ofType(held.effects, "write")).toEqual([]);
    expect(held.state.durable.index[e.fileId]).toMatchObject({
      localHash: "3".repeat(64),
      headHash: H2,
    });
  });

  it("remote delete: trash only if unmodified, with expect", () => {
    const store = new MemoryStore();
    const { state } = push(joined(), store, [scanItem("a.md", H1)]);
    const e = Object.values(state.durable.index)[0]!;
    const r = run(state, { type: "sync", scan: [scanItem("a.md", H1)] });
    const del = {
      seq: 4,
      type: "file_deleted",
      fileId: e.fileId,
      path: "a.md",
      deviceId: "other",
      at: "",
    };
    const out = run(r.state, {
      type: "pullResult",
      requestId: r.state.vol.requestId!,
      entries: [del],
      head: 4,
      hasMore: false,
    });
    expect(ofType(out.effects, "trash")).toMatchObject([{ path: "a.md", expect: H1 }]);
    const done = run(out.state, { type: "trashed", fileId: e.fileId, ok: true }).state;
    expect(done.durable.index[e.fileId]).toMatchObject({
      headDeleted: true,
      localHash: null,
      materialized: false,
    });
  });

  it("remote file on a path not representable here is never written", () => {
    const s = joined("windows");
    const r = run(s, { type: "sync", scan: [] });
    const entry = {
      seq: 1,
      type: "file_put",
      fileId: "f",
      versionId: "v",
      path: "con.md",
      contentHash: H1,
      deviceId: "other",
      at: "",
    };
    const out = run(r.state, {
      type: "pullResult",
      requestId: r.state.vol.requestId!,
      entries: [entry],
      head: 1,
      hasMore: false,
    });
    expect(ofType(out.effects, "write")).toEqual([]);
    expect(out.state.durable.index["f"]!.unavailable).toBe("reserved_name");
  });

  it("unknown journal types: skipped when ignorable, otherwise sync stops", () => {
    const s = joined();
    const r = run(s, { type: "sync", scan: [] });
    const base = { fileId: "f", path: "a.md", deviceId: "other", at: "" };
    const ok = run(r.state, {
      type: "pullResult",
      requestId: r.state.vol.requestId!,
      entries: [{ ...base, seq: 1, type: "future", ignorable: true }],
      head: 1,
      hasMore: false,
    });
    expect(ok.state.durable.cursor).toBe(1);
    const r2 = run(s, { type: "sync", scan: [] });
    const stop = run(r2.state, {
      type: "pullResult",
      requestId: r2.state.vol.requestId!,
      entries: [{ ...base, seq: 1, type: "future" }],
      head: 1,
      hasMore: false,
    });
    expect(stop.state.durable.cursor).toBe(0);
    expect(stop.state.vol.stopped).toBe("update_required");
  });

  it("D-07: joining with local content never overwrites", () => {
    let s = client();
    const r = run(s, {
      type: "sync",
      scan: [scanItem("same.md", H1), scanItem("diff.md", H1), scanItem("mine.md", H1)],
    });
    const snap = ofType(r.effects, "snapshot")[0]!;
    const f = (fileId: string, path: string, hash: string) => ({
      fileId,
      kind: "file" as const,
      path,
      versionId: `v-${fileId}`,
      contentHash: hash,
      size: 1,
      mtime: 0,
    });
    const out = run(r.state, {
      type: "snapshotResult",
      requestId: snap.requestId,
      snapshot: {
        head: 3,
        files: [f("s", "same.md", H1), f("d", "diff.md", H2), f("t", "theirs.md", H2)],
        openConflicts: [],
      },
    });
    s = out.state;
    expect(s.durable.index["s"]).toMatchObject({ confirmed: true, baseHash: H1, localHash: H1 });
    expect(ofType(out.effects, "write")).toMatchObject([
      { path: "theirs.md", hash: H2, expect: null },
    ]);
    const push1 = ofType(out.effects, "push")[0]!;
    expect(push1.ops.map((o) => (o.type === "put" ? o.path : ""))).toEqual(["diff.md", "mine.md"]);
    expect(s.durable.cursor).toBe(3);
  });

  it("retryDelay: exponential with jitter, 1 s to 5 min", () => {
    expect(retryDelay(0, 0)).toBe(1000);
    expect(retryDelay(3, 0)).toBe(8000);
    expect(retryDelay(30, 0.999)).toBeLessThanOrEqual(300_000);
    expect(retryDelay(2, 0.5)).toBeGreaterThan(retryDelay(2, 0));
  });
});
