import type { FileOp } from "@kamino/protocol";
import { describe, expect, it } from "vitest";
import { initialState, step, type ClientEvent, type ClientState, type Effect } from "./client.js";
import { ALL_CONFIG, DEFAULT_SETTINGS } from "./exclusions.js";
import { MemoryStore } from "./store.js";

let n = 0;
const env = { newId: () => `id${++n}` };
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const item = (path: string, hash: string) => ({ path, hash, size: 1, mtime: 0 });
type Item = ReturnType<typeof item>;

const run = (s: ClientState, e: ClientEvent) => step(s, e, env);
const ofType = <T extends Effect["type"]>(fx: Effect[], t: T) =>
  fx.filter((f): f is Extract<Effect, { type: T }> => f.type === t);

function finishPulls(r: { state: ClientState; effects: Effect[] }, store: MemoryStore) {
  let { state } = r;
  const effects = [...r.effects];
  let pull = ofType(r.effects, "pull")[0];
  while (pull) {
    const next = run(state, {
      type: "pullResult",
      requestId: pull.requestId,
      ...store.changes(pull.after),
    });
    state = next.state;
    effects.push(...next.effects);
    pull = ofType(next.effects, "pull")[0];
  }
  return { state, effects };
}

/** A joined client against `store`. */
function joined(store: MemoryStore, deviceId = "dev"): ClientState {
  const s0 = initialState({
    deviceId,
    platform: "linux",
    configDir: ".obsidian",
    settings: { ...DEFAULT_SETTINGS, config: ALL_CONFIG },
    batchSize: 500,
  });
  const s = run(s0, { type: "sync", scan: [], folders: [] }).state;
  const r = run(s, {
    type: "snapshotResult",
    requestId: s.vol.requestId!,
    snapshot: store.snapshot(),
  });
  return finishPulls(r, store).state;
}

/** A cycle: scan (files and folders), push to the store, pull. Returns every effect. */
function cycle(s: ClientState, store: MemoryStore, scan: Item[], folders: string[]) {
  const r1 = run(s, { type: "sync", scan, folders });
  const p = ofType(r1.effects, "push")[0];
  if (!p) return { ...finishPulls(r1, store), ops: [] as FileOp[] };
  for (const h of p.hashes) store.blobs.add(h);
  const res = store.commit(p.ops, s.config.deviceId);
  const r2 = run(r1.state, {
    type: "pushResult",
    requestId: p.requestId,
    results: res.results,
    head: res.head,
  });
  const done = finishPulls(r2, store);
  return { state: done.state, effects: [...r1.effects, ...done.effects], ops: p.ops };
}

const liveFolders = (store: MemoryStore) =>
  [...store.files.values()].filter((f) => f.kind === "folder" && !f.deleted).map((f) => f.path);

describe("client folders (Z9)", () => {
  it("a new local folder, even empty, is created on the server once", () => {
    const store = new MemoryStore();
    let s = joined(store);
    const r = cycle(s, store, [], ["d"]);
    expect(r.ops).toEqual([expect.objectContaining({ type: "mkdir", path: "d" })]);
    expect(liveFolders(store)).toEqual(["d"]);
    s = r.state;
    expect(cycle(s, store, [], ["d"]).ops).toEqual([]);
  });

  it("a folder removed here goes after its files, in the same batch", () => {
    const store = new MemoryStore();
    let s = joined(store);
    s = cycle(s, store, [item("d/a.md", H1)], ["d"]).state;
    const r = cycle(s, store, [], []);
    expect(r.ops.map((o) => o.type)).toEqual(["delete", "delete"]);
    expect(r.ops[0]).toMatchObject({ fileId: expect.any(String) });
    expect(store.files.get((r.ops[1] as FileOp).fileId)?.kind).toBe("folder");
    expect(liveFolders(store)).toEqual([]);
  });

  it("a folder with a file still here is not deleted", () => {
    const store = new MemoryStore();
    let s = joined(store);
    s = cycle(s, store, [item("d/a.md", H1)], ["d"]).state;
    // The listing missed the folder but its file is there.
    const r = cycle(s, store, [item("d/a.md", H1)], []);
    expect(r.ops).toEqual([]);
  });

  it("a watched folder rename moves the folder and every file in it", () => {
    const store = new MemoryStore();
    let s = joined(store);
    s = cycle(s, store, [item("d/a.md", H1), item("d/e/b.md", H2)], ["d", "d/e"]).state;
    s = run(s, { type: "localRename", from: "d", to: "x" }).state;
    const r = cycle(s, store, [item("x/a.md", H1), item("x/e/b.md", H2)], ["x", "x/e"]);
    expect(r.ops.every((o) => o.type === "move")).toBe(true);
    expect(r.ops).toHaveLength(4);
    expect(r.ops[0]).toMatchObject({ fromPath: "d", toPath: "x" });
    expect(liveFolders(store).sort()).toEqual(["x", "x/e"]);
    const files = [...store.files.values()].filter((f) => f.kind === "file" && !f.deleted);
    expect(files.map((f) => f.path).sort()).toEqual(["x/a.md", "x/e/b.md"]);
  });

  it("a watched folder rename moves its files even before the folder is tracked (regression)", () => {
    const store = new MemoryStore();
    let s = joined(store);
    // A shell cycle without folders: only the files are known.
    const r0 = run(s, { type: "sync", scan: [item("d/a.md", H1)] });
    const p = ofType(r0.effects, "push")[0]!;
    store.blobs.add(H1);
    const res = store.commit(p.ops, "dev");
    s = finishPulls(
      run(r0.state, { type: "pushResult", requestId: p.requestId, ...res }),
      store,
    ).state;
    s = run(s, { type: "localRename", from: "d", to: "x" }).state;
    const r = cycle(s, store, [item("x/a.md", H1)], ["x"]);
    expect(r.ops.filter((o) => o.type !== "mkdir")).toEqual([
      expect.objectContaining({ type: "move", fromPath: "d/a.md", toPath: "x/a.md" }),
    ]);
  });

  it("a file that can't be read is present, never deleted (review C1)", () => {
    const store = new MemoryStore();
    let s = joined(store);
    s = cycle(s, store, [item("d/a.md", H1)], ["d"]).state;
    const r = run(s, { type: "sync", scan: [], folders: ["d"], unreadable: ["d/a.md"] });
    expect(ofType(r.effects, "push")).toEqual([]);
    expect(Object.values(r.state.durable.index)[0]!.localHash).toBe(H1);
  });

  it("a remote folder is created here; once done nothing more happens", () => {
    const store = new MemoryStore();
    store.commit([{ type: "mkdir", opId: "o1", fileId: "F", path: "d" }], "other");
    let s = joined(new MemoryStore()); // joined before the folder existed
    const r = cycle(s, store, [], []);
    const mk = ofType(r.effects, "mkdir");
    expect(mk).toEqual([{ type: "mkdir", fileId: "F", path: "d" }]);
    s = run(r.state, { type: "folderDone", fileId: "F", op: "mkdir", ok: true }).state;
    const again = cycle(s, store, [], ["d"]);
    expect(again.ops).toEqual([]);
    expect(ofType(again.effects, "mkdir")).toEqual([]);
  });

  it("a remote deletion removes an empty folder, never one holding a file of this device", () => {
    const store = new MemoryStore();
    let s = joined(store);
    s = cycle(s, store, [], ["d", "k"]).state;
    s = cycle(s, store, [item("k/mine.md", H1)], ["d", "k"]).state;
    const ids = Object.fromEntries(Object.values(s.durable.folders).map((f) => [f.path, f.fileId]));
    // Another device deletes d (empty) and k (the server thinks k/mine.md is gone too).
    const kFile = Object.values(s.durable.index).find((e) => e.path === "k/mine.md")!;
    store.commit(
      [
        { type: "delete", opId: "x1", fileId: kFile.fileId, baseVersionId: kFile.base },
        { type: "delete", opId: "x2", fileId: ids.d!, baseVersionId: null },
        { type: "delete", opId: "x3", fileId: ids.k!, baseVersionId: null },
      ],
      "other",
    );
    // Here k/mine.md was edited meanwhile: it stays, and so does k.
    const r = cycle(s, store, [item("k/mine.md", H2)], ["d", "k"]);
    const rm = ofType(r.effects, "rmdir");
    expect(rm).toEqual([{ type: "rmdir", fileId: ids.d, path: "d", leftover: false }]);
    // The edit resurrects the file and k comes back on the server.
    s = run(r.state, { type: "folderDone", fileId: ids.d!, op: "rmdir", ok: true }).state;
    cycle(s, store, [item("k/mine.md", H2)], ["k"]);
    expect(liveFolders(store)).toEqual(["k"]);
  });

  it("a remote folder move creates the new folder and removes the old one once empty", () => {
    const store = new MemoryStore();
    let s = joined(store);
    s = cycle(s, store, [item("d/a.md", H1)], ["d"]).state;
    const folder = Object.values(s.durable.folders)[0]!;
    const file = Object.values(s.durable.index)[0]!;
    store.commit(
      [
        { type: "move", opId: "m1", fileId: folder.fileId, fromPath: "d", toPath: "x" },
        { type: "move", opId: "m2", fileId: file.fileId, fromPath: "d/a.md", toPath: "x/a.md" },
      ],
      "other",
    );
    const r = cycle(s, store, [item("d/a.md", H1)], ["d"]);
    expect(ofType(r.effects, "mkdir")).toEqual([
      { type: "mkdir", fileId: folder.fileId, path: "x" },
    ]);
    expect(ofType(r.effects, "rename")).toEqual([
      expect.objectContaining({ from: "d/a.md", to: "x/a.md" }),
    ]);
    s = run(r.state, { type: "folderDone", fileId: folder.fileId, op: "mkdir", ok: true }).state;
    s = run(s, { type: "renamed", fileId: file.fileId, to: "x/a.md", ok: true }).state;
    // The old folder, now empty, is a leftover: removed, never sent as a new folder.
    const next = cycle(s, store, [item("x/a.md", H1)], ["d", "x"]);
    expect(next.ops).toEqual([]);
    expect(ofType(next.effects, "rmdir")).toEqual([
      { type: "rmdir", fileId: folder.fileId, path: "d", leftover: true },
    ]);
    const after = cycle(next.state, store, [item("x/a.md", H1)], ["x"]);
    expect(ofType(after.effects, "rmdir")).toEqual([]);
    expect(liveFolders(store)).toEqual(["x"]);
  });

  it("two devices creating the same folder end up with one (03 §9.4)", () => {
    const store = new MemoryStore();
    let a = joined(store, "a");
    let b = joined(store, "b");
    a = cycle(a, store, [], ["d"]).state;
    const r = cycle(b, store, [], ["d"]);
    b = r.state;
    expect(liveFolders(store)).toEqual(["d"]);
    expect(Object.keys(b.durable.folders)).toEqual(Object.keys(a.durable.folders));
    expect(cycle(b, store, [], ["d"]).ops).toEqual([]);
  });

  it("a shell that doesn't report folders leaves them alone", () => {
    const store = new MemoryStore();
    let s = joined(store);
    s = cycle(s, store, [], ["d"]).state;
    const r = run(s, { type: "sync", scan: [] });
    expect(ofType(r.effects, "push")).toEqual([]);
    expect(Object.values(r.state.durable.folders)[0]!.onDisk).toBe(true);
  });

  it("folders of the configuration area are never synced", () => {
    const store = new MemoryStore();
    const s = joined(store);
    expect(cycle(s, store, [], ["{config}", "{config}/plugins"]).ops).toEqual([]);
  });

  it("states saved before folders existed still load", () => {
    const store = new MemoryStore();
    const s = joined(store);
    const legacy = { ...s, durable: { ...s.durable } } as ClientState;
    delete (legacy.durable as Partial<ClientState["durable"]>).folders;
    expect(cycle(legacy, store, [], ["d"]).ops).toHaveLength(1);
  });
});
