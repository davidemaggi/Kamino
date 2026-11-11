import type { Op } from "@kamino/protocol";
import { describe, expect, it } from "vitest";
import { initialState, step, type ClientEvent, type ClientState, type Effect } from "./client.js";
import { ALL_CONFIG, DEFAULT_SETTINGS } from "./exclusions.js";
import { MemoryStore } from "./store.js";

let n = 0;
const env = { newId: () => `r${++n}` };
const H = (c: string) => c.repeat(64);
const item = (path: string, hash: string) => ({ path, hash, size: 1, mtime: 0 });
const run = (s: ClientState, e: ClientEvent) => step(s, e, env);
const ofType = <T extends Effect["type"]>(fx: Effect[], t: T) =>
  fx.filter((f): f is Extract<Effect, { type: T }> => f.type === t);

function finish(r: { state: ClientState; effects: Effect[] }, store: MemoryStore) {
  let { state } = r;
  const effects = [...r.effects];
  for (;;) {
    const pull = ofType(effects, "pull").pop();
    const snap = ofType(effects, "snapshot").pop();
    if (snap && state.vol.requestId === snap.requestId) {
      const next = run(state, {
        type: "snapshotResult",
        requestId: snap.requestId,
        snapshot: store.snapshot(),
      });
      state = next.state;
      effects.push(...next.effects.filter((f) => f.type !== "snapshot" || f !== snap));
      continue;
    }
    if (!pull || state.vol.requestId !== pull.requestId) break;
    const next = run(state, {
      type: "pullResult",
      requestId: pull.requestId,
      ...store.changes(pull.after),
    });
    state = next.state;
    effects.push(...next.effects);
    if (!ofType(next.effects, "pull").length && !ofType(next.effects, "snapshot").length) break;
  }
  return { state, effects };
}

function cycle(s: ClientState, store: MemoryStore, scan: ReturnType<typeof item>[]) {
  const r1 = run(s, { type: "sync", scan, folders: [] });
  const p = ofType(r1.effects, "push")[0];
  if (!p) return finish(r1, store);
  for (const h of p.hashes) store.blobs.add(h);
  const res = store.commit(p.ops, s.config.deviceId);
  return finish(
    {
      state: run(r1.state, { type: "pushResult", requestId: p.requestId, ...res }).state,
      effects: r1.effects,
    },
    store,
  );
}

const put = (
  fileId: string,
  versionId: string,
  path: string,
  hash: string,
  base: string | null,
): Op => ({
  type: "put",
  opId: `o-${versionId}`,
  fileId,
  versionId,
  path,
  baseVersionId: base,
  contentHash: hash,
  size: 1,
  mtime: 1,
});

describe("resync after cursor_too_old (03 §6.3)", () => {
  it("catches up from the snapshot: edits, moves, deletions and new files, nothing lost", () => {
    const store = new MemoryStore();
    for (const h of ["1", "2", "3", "4", "5"]) store.blobs.add(H(h));
    store.commit(
      [
        put("fa", "va1", "a.md", H("1"), null),
        put("fb", "vb1", "b.md", H("2"), null),
        put("fc", "vc1", "c.md", H("3"), null),
      ],
      "other",
    );
    let s = initialState({
      deviceId: "me",
      platform: "linux",
      configDir: ".obsidian",
      settings: { ...DEFAULT_SETTINGS, config: ALL_CONFIG },
      batchSize: 50,
    });
    // Join: everything written here.
    s = cycle(s, store, []).state;
    for (const e of Object.values(s.durable.index))
      s = run(s, { type: "written", fileId: e.fileId, hash: e.pendingWrite!.hash, ok: true }).state;
    // While this device is away: a edited, b moved, c deleted, d created; the journal is compacted.
    store.commit(
      [
        put("fa", "va2", "a.md", H("4"), "va1"),
        { type: "move", opId: "m", fileId: "fb", fromPath: "b.md", toPath: "x/b.md" },
        { type: "delete", opId: "d", fileId: "fc", baseVersionId: "vc1" },
        put("fd", "vd1", "d.md", H("5"), null),
      ],
      "other",
    );
    // Back: the pull says cursor_too_old.
    const scan = [item("a.md", H("1")), item("b.md", H("2")), item("c.md", H("3"))];
    const r1 = run(s, { type: "sync", scan, folders: [] });
    const pull = ofType(r1.effects, "pull")[0]!;
    const r2 = run(r1.state, { type: "resync", requestId: pull.requestId });
    const snap = ofType(r2.effects, "snapshot")[0]!;
    const r3 = run(r2.state, {
      type: "snapshotResult",
      requestId: snap.requestId,
      snapshot: store.snapshot(),
    });
    const fx = r3.effects;
    expect(ofType(fx, "write").map((w) => [w.path, w.hash, w.expect])).toEqual(
      expect.arrayContaining([
        ["a.md", H("4"), H("1")],
        ["d.md", H("5"), null],
      ]),
    );
    expect(ofType(fx, "rename").map((r) => [r.from, r.to])).toEqual([["b.md", "x/b.md"]]);
    expect(ofType(fx, "trash").map((t) => [t.path, t.expect])).toEqual([["c.md", H("3")]]);
    expect(r3.state.durable.cursor).toBe(store.head);
    expect(r3.state.durable.joined).toBe(true);
    // No op sent back: nothing was changed here.
    expect(ofType(fx, "push")).toEqual([]);
  });

  it("a folder deleted here but brought back while away comes back (regression)", () => {
    const store = new MemoryStore();
    store.commit([{ type: "mkdir", opId: "m1", fileId: "F", path: "d" }], "other");
    let s = initialState({
      deviceId: "me",
      platform: "linux",
      configDir: ".obsidian",
      settings: { ...DEFAULT_SETTINGS, config: ALL_CONFIG },
      batchSize: 50,
    });
    s = cycle(s, store, []).state;
    s = run(s, { type: "folderDone", fileId: "F", op: "mkdir", ok: true }).state;
    store.commit([{ type: "delete", opId: "x1", fileId: "F", baseVersionId: null }], "other");
    let r = run(s, { type: "sync", scan: [], folders: ["d"] });
    r = finish(r, store);
    s = run(r.state, { type: "folderDone", fileId: "F", op: "rmdir", ok: true }).state;
    expect(s.durable.folders["F"]).toMatchObject({ deleted: true, onDisk: false });
    // Brought back elsewhere; the journal that said so is compacted.
    store.commit([{ type: "mkdir", opId: "m2", fileId: "F", path: "e" }], "other");
    const r1 = run(s, { type: "sync", scan: [], folders: [] });
    const pull = ofType(r1.effects, "pull")[0]!;
    const r2 = run(r1.state, { type: "resync", requestId: pull.requestId });
    const snap = ofType(r2.effects, "snapshot")[0]!;
    const r3 = run(r2.state, {
      type: "snapshotResult",
      requestId: snap.requestId,
      snapshot: store.snapshot(),
    });
    expect(r3.state.durable.folders["F"]).toMatchObject({ deleted: false, path: "e" });
    expect(ofType(r3.effects, "mkdir")).toEqual([{ type: "mkdir", fileId: "F", path: "e" }]);
  });

  it("a case twin whose server folder went while away becomes a folder of its own (regression)", () => {
    const store = new MemoryStore();
    store.commit([{ type: "mkdir", opId: "m1", fileId: "BIG", path: "D" }], "other");
    let s = initialState({
      deviceId: "me",
      platform: "linux",
      configDir: ".obsidian",
      settings: { ...DEFAULT_SETTINGS, config: ALL_CONFIG },
      batchSize: 50,
    });
    s = run(s, { type: "sync", scan: [], folders: ["d"] }).state;
    // Joined with an empty snapshot: the server's "D" is unknown here, "d" is new.
    const join = run(s, {
      type: "snapshotResult",
      requestId: s.vol.requestId!,
      snapshot: { head: 0, files: [], openConflicts: [] },
    });
    const p = ofType(join.effects, "push")[0]!;
    const res = store.commit(p.ops, "me"); // merged into "D"
    const afterPush = run(join.state, { type: "pushResult", requestId: p.requestId, ...res });
    s = afterPush.state;
    const alias = Object.values(s.durable.folders).find((f) => f.path === "d")!;
    expect(alias.aliasOf).toBe("BIG");
    store.commit([{ type: "delete", opId: "x", fileId: "BIG", baseVersionId: null }], "other");
    // The pull that follows the push meets cursor_too_old.
    const pull = ofType(afterPush.effects, "pull")[0]!;
    const r2 = run(s, { type: "resync", requestId: pull.requestId });
    const snap = ofType(r2.effects, "snapshot")[0]!;
    const r3 = run(r2.state, {
      type: "snapshotResult",
      requestId: snap.requestId,
      snapshot: store.snapshot(),
    });
    const push = ofType(r3.effects, "push")[0];
    expect(push?.ops).toEqual([expect.objectContaining({ type: "mkdir", path: "d" })]);
  });

  it("an unconfirmed file the snapshot has is recognised; a missing copy comes back (regression)", () => {
    const store = new MemoryStore();
    store.blobs.add(H("1"));
    let s = initialState({
      deviceId: "me",
      platform: "linux",
      configDir: ".obsidian",
      settings: { ...DEFAULT_SETTINGS, config: ALL_CONFIG },
      batchSize: 50,
    });
    s = cycle(s, store, []).state;
    // a.md is sent; the server accepts it but the response is lost.
    const r1 = run(s, { type: "sync", scan: [item("a.md", H("1"))], folders: [] });
    const p = ofType(r1.effects, "push")[0]!;
    store.commit(p.ops, "me");
    s = run(r1.state, { type: "networkError", requestId: p.requestId }).state;
    // State reached by the simulator (crashes, truncated responses): the entry is unconfirmed,
    // no op is pending, the copy left the disk, and the journal saying it was accepted is compacted.
    const id = Object.keys(s.durable.index)[0]!;
    s = {
      ...s,
      durable: {
        ...s.durable,
        sent: [],
        index: { [id]: { ...s.durable.index[id]!, localHash: null, materialized: true } },
      },
    };
    const r2 = run(s, { type: "sync", scan: [], folders: [] });
    const pull = ofType(r2.effects, "pull")[0]!;
    const r3 = run(r2.state, { type: "resync", requestId: pull.requestId });
    const snap = ofType(r3.effects, "snapshot")[0]!;
    const r4 = run(r3.state, {
      type: "snapshotResult",
      requestId: snap.requestId,
      snapshot: store.snapshot(),
    });
    const e = Object.values(r4.state.durable.index).find((x) => x.path === "a.md")!;
    expect(e.confirmed).toBe(true);
    expect(ofType(r4.effects, "write").map((w) => w.path)).toEqual(["a.md"]);
  });

  it("a local edit of a file deleted meanwhile is kept and sent (C-06)", () => {
    const store = new MemoryStore();
    store.blobs.add(H("1"));
    store.commit([put("fa", "va1", "a.md", H("1"), null)], "other");
    let s = initialState({
      deviceId: "me",
      platform: "linux",
      configDir: ".obsidian",
      settings: { ...DEFAULT_SETTINGS, config: ALL_CONFIG },
      batchSize: 50,
    });
    s = cycle(s, store, []).state;
    s = run(s, { type: "written", fileId: "fa", hash: H("1"), ok: true }).state;
    store.commit([{ type: "delete", opId: "d", fileId: "fa", baseVersionId: "va1" }], "other");
    const r1 = run(s, { type: "sync", scan: [item("a.md", H("9"))], folders: [] });
    // The edit goes out first (push), then the pull meets cursor_too_old.
    const push = ofType(r1.effects, "push")[0]!;
    expect(push.ops[0]).toMatchObject({ type: "put", contentHash: H("9") });
    const r2 = run(r1.state, { type: "resync", requestId: push.requestId });
    // A resync answer to a push request is ignored: only a pull can be too old.
    expect(ofType(r2.effects, "snapshot")).toEqual([]);
  });
});
