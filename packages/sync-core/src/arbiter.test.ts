import type { Op } from "@kamino/protocol";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "./store.js";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
let n = 0;
const id = () => `x${++n}`;
const put = (
  fileId: string,
  path: string,
  base: string | null,
  hash = H1,
  versionId = id(),
): Op => ({
  type: "put",
  opId: id(),
  fileId,
  versionId,
  path,
  baseVersionId: base,
  contentHash: hash,
  size: 1,
  mtime: 0,
});
function store() {
  const s = new MemoryStore();
  s.blobs.add(H1);
  s.blobs.add(H2);
  return s;
}
const one = (s: MemoryStore, op: Op, device = "d1") => s.commit([op], device).results[0]!;

describe("arbiter: put (03 §5.3)", () => {
  it("creates, updates, and repeats as duplicate", () => {
    const s = store();
    const create = put("f", "a.md", null);
    const r1 = one(s, create);
    expect(r1).toMatchObject({ status: "accepted", seq: 1, path: "a.md" });
    expect(one(s, create)).toEqual({ status: "duplicate", original: r1 });
    expect(s.head).toBe(1);
    const v1 = create.type === "put" ? create.versionId : "";
    expect(one(s, put("f", "a.md", v1, H2))).toMatchObject({ status: "accepted", seq: 2 });
  });

  it("blob first, canonical and allowed paths only", () => {
    const s = new MemoryStore();
    expect(one(s, put("f", "a.md", null))).toEqual({ status: "rejected", code: "blob_missing" });
    s.blobs.add(H1);
    expect(one(s, put("f", "é.md", null))).toEqual({ status: "rejected", code: "path_invalid" });
    expect(one(s, put("f", "a\u0001.md", null))).toEqual({
      status: "rejected",
      code: "path_invalid",
    });
    expect(one(s, put("f", "{config}/workspace.json", null))).toEqual({
      status: "rejected",
      code: "path_forbidden",
    });
  });

  it("rejections are not recorded: the same op succeeds later", () => {
    const s = new MemoryStore();
    const op = put("f", "a.md", null);
    expect(one(s, op).status).toBe("rejected");
    s.blobs.add(H1);
    expect(one(s, op).status).toBe("accepted");
  });

  it("both_created on a taken collision key; concurrent_edit on a stale base; candidates pile up", () => {
    const s = store();
    const a = put("f", "Nota.md", null);
    one(s, a);
    const both = one(s, put("g", "nota.md", null, H2));
    expect(both).toMatchObject({ status: "conflict" });
    const stale1 = one(s, put("f", "Nota.md", "old", H2));
    expect(stale1).toMatchObject({ status: "conflict" });
    if (both.status !== "conflict" || stale1.status !== "conflict") throw new Error();
    expect(stale1.conflictId).toBe(both.conflictId);
    expect(s.conflicts.get(both.conflictId)!.candidates).toHaveLength(2);
    expect([...s.versions.values()].filter((v) => v.hash === H2)).toHaveLength(2);
  });

  // rc.8: two devices wrote the same configuration ({}) on old bases; each put opened a conflict
  // that nothing could close for good. The same content as the head is no conflict.
  it("a stale put with the head's content is accepted as the head, without a conflict", () => {
    const s = store();
    const a = put("f", "a.md", null, H1, "v1");
    one(s, a);
    one(s, put("f", "a.md", "v1", H2, "v2"));
    const head = s.head;
    const r = one(s, put("f", "a.md", "v1", H2, "v3"), "d2");
    expect(r).toEqual({
      status: "accepted",
      seq: head,
      fileId: "f",
      versionId: "v2",
      path: "a.md",
    });
    expect(s.conflicts.size).toBe(0);
    expect(s.head).toBe(head);
    expect(s.files.get("f")).toMatchObject({ headVersionId: "v2", headHash: H2 });
    expect(s.versions.has("v3")).toBe(false);
  });

  // rc.9: Obsidian rewrites its configuration on every device; those conflicts never ended.
  describe("configuration folder: the last write wins, the other stays in the history", () => {
    it("a stale put on {config}/ becomes the head, no conflict", () => {
      const s = store();
      one(s, put("f", "{config}/app.json", null, H1, "v1"));
      one(s, put("f", "{config}/app.json", "v1", H2, "v2"));
      const r = one(s, put("f", "{config}/app.json", "v1", H1, "v3"), "d2");
      expect(r).toMatchObject({ status: "accepted", fileId: "f", versionId: "v3" });
      expect(s.conflicts.size).toBe(0);
      expect(s.files.get("f")).toMatchObject({ headVersionId: "v3", headHash: H1 });
      expect(s.versions.has("v2")).toBe(true);
    });

    it("an open conflict on {config}/ is closed by the next put", () => {
      const s = store();
      one(s, put("f", "{config}/app.json", null, H1, "v1"));
      one(s, put("f", "{config}/app.json", "v1", H2, "v2"));
      // Opened before this rule (rc.9): a resolution may not come any more.
      s.conflicts.set("c", {
        conflictId: "c",
        fileId: "f",
        kind: "concurrent_edit",
        baseVersionId: "v1",
        headVersionId: "v1",
        candidates: ["v2"],
        status: "open",
      });
      const r = one(s, put("f", "{config}/app.json", "v1", H1, "v3"));
      expect(r).toMatchObject({ status: "accepted", versionId: "v3" });
      expect(s.conflicts.get("c")!.status).not.toBe("open");
      expect(s.journal.at(-1)).toMatchObject({
        type: "conflict_resolved",
        conflictId: "c",
        versionId: "v3",
      });
    });

    it("a new {config}/ file at a taken path becomes a version of that file", () => {
      const s = store();
      one(s, put("f", "{config}/app.json", null, H1, "v1"));
      const r = one(s, put("g", "{config}/app.json", null, H2, "v2"), "d2");
      expect(r).toMatchObject({ status: "accepted", fileId: "f", versionId: "v2" });
      expect(s.files.has("g")).toBe(false);
      expect(s.files.get("f")).toMatchObject({ headVersionId: "v2", headHash: H2 });
    });

    it("notes still open conflicts", () => {
      const s = store();
      one(s, put("f", "a.md", null, H1, "v1"));
      one(s, put("f", "a.md", "v1", H2, "v2"));
      expect(one(s, put("f", "a.md", "v1", H1, "v3")).status).toBe("conflict");
    });
  });

  it("a new file at a taken path with the same content joins that file", () => {
    const s = store();
    one(s, put("f", "Nota.md", null, H1, "v1"));
    const head = s.head;
    const r = one(s, put("g", "nota.md", null, H1, "v2"), "d2");
    expect(r).toEqual({
      status: "accepted",
      seq: head,
      fileId: "f",
      versionId: "v1",
      path: "Nota.md",
    });
    expect(s.conflicts.size).toBe(0);
  });

  it("an edit resurrects a deleted file, next to it if the path was taken (C-06)", () => {
    const s = store();
    const a = put("f", "a.md", null);
    one(s, a);
    const v1 = a.type === "put" ? a.versionId : "";
    one(s, { type: "delete", opId: id(), fileId: "f", baseVersionId: v1 });
    one(s, put("g", "A.md", null));
    const r = one(s, put("f", "a.md", "whatever", H2));
    expect(r).toMatchObject({ status: "accepted", path: "a (1).md" });
    expect(s.journal.at(-1)!.type).toBe("file_restored");
  });
});

describe("arbiter: forced sync (ADR-0019)", () => {
  const forced = (op: Op): Op => ({ ...op, force: true }) as Op;
  const archived = (op: Op): Op => ({ ...op, archive: true }) as Op;
  const openOn = (s: MemoryStore, fileId: string, cand: string) =>
    s.conflicts.set("c", {
      conflictId: "c",
      fileId,
      kind: "concurrent_edit",
      baseVersionId: "v1",
      headVersionId: "v1",
      candidates: [cand],
      status: "open",
    });

  it("a forced stale put on a note becomes the head and closes the open conflict", () => {
    const s = store();
    one(s, put("f", "a.md", null, H1, "v1"));
    one(s, put("f", "a.md", "v1", H2, "v2"));
    openOn(s, "f", "v2");
    const r = one(s, forced(put("f", "a.md", "v1", H1, "v3")), "src");
    expect(r).toMatchObject({ status: "accepted", fileId: "f", versionId: "v3" });
    expect(s.files.get("f")).toMatchObject({ headVersionId: "v3", headHash: H1 });
    expect(s.conflicts.get("c")!.status).not.toBe("open");
    expect(s.versions.has("v2")).toBe(true);
  });

  it("a forced put with the head's content still closes the open conflict", () => {
    const s = store();
    one(s, put("f", "a.md", null, H1, "v1"));
    one(s, put("x", "b.md", null, H2, "vx"));
    s.versions.set("v2", { ...s.versions.get("vx")!, fileId: "f" });
    openOn(s, "f", "v2");
    const r = one(s, forced(put("f", "a.md", "v1", H1, "v3")), "src");
    expect(r).toMatchObject({ status: "accepted", fileId: "f", versionId: "v1" });
    expect(s.conflicts.get("c")!.status).not.toBe("open");
    expect(s.journal.at(-1)).toMatchObject({ type: "conflict_resolved", versionId: "v1" });
  });

  it("a forced new note at a taken path becomes a version of that file", () => {
    const s = store();
    one(s, put("f", "a.md", null, H1, "v1"));
    const r = one(s, forced(put("g", "a.md", null, H2, "v2")), "src");
    expect(r).toMatchObject({ status: "accepted", fileId: "f", versionId: "v2" });
    expect(s.files.get("f")).toMatchObject({ headVersionId: "v2", headHash: H2 });
  });

  it("an archive put goes to the history and leaves the head alone", () => {
    const s = store();
    one(s, put("f", "a.md", null, H1, "v1"));
    const head = s.head;
    const r = one(s, archived(put("f", "a.md", "v1", H2, "v2")), "dst");
    expect(r).toEqual({
      status: "accepted",
      seq: head,
      fileId: "f",
      versionId: "v1",
      path: "a.md",
    });
    expect(s.files.get("f")).toMatchObject({ headVersionId: "v1", headHash: H1 });
    expect(s.versions.get("v2")).toMatchObject({ fileId: "f", hash: H2 });
    expect(s.head).toBe(head);
  });

  it("an archive put of a new file at a taken path goes to that file's history", () => {
    const s = store();
    one(s, put("f", "a.md", null, H1, "v1"));
    const r = one(s, archived(put("g", "A.md", null, H2, "v2")), "dst");
    expect(r).toMatchObject({ status: "accepted", fileId: "f", versionId: "v1" });
    expect(s.versions.get("v2")).toMatchObject({ fileId: "f" });
    expect(s.files.has("g")).toBe(false);
  });

  it("an archive put with nothing at its path creates the file", () => {
    const s = store();
    const r = one(s, archived(put("g", "a.md", null, H2, "v2")), "dst");
    expect(r).toMatchObject({ status: "accepted", fileId: "g", versionId: "v2" });
  });
});

describe("arbiter: version ids", () => {
  // fast-check counterexample (store.test.ts): two puts with the same versionId overwrote a stored version.
  it("a version id is never reused by another op", () => {
    const s = store();
    one(s, put("f", "a.md", null, H1, "v1"));
    expect(one(s, put("f", "a.md", null, H2, "v1"))).toEqual({
      status: "rejected",
      code: "invalid_request",
    });
    expect(s.versions.get("v1")!.hash).toBe(H1);
  });
});

describe("arbiter: move, delete, mkdir", () => {
  it("move: first arrived wins, taken path rejected, case-only rename accepted", () => {
    const s = store();
    one(s, put("f", "a.md", null));
    one(s, put("g", "b.md", null));
    expect(
      one(s, { type: "move", opId: id(), fileId: "f", fromPath: "a.md", toPath: "c.md" }),
    ).toMatchObject({ status: "accepted", path: "c.md" });
    expect(
      one(s, { type: "move", opId: id(), fileId: "f", fromPath: "a.md", toPath: "d.md" }),
    ).toEqual({ status: "rejected", code: "moved_elsewhere", path: "c.md" });
    expect(
      one(s, { type: "move", opId: id(), fileId: "f", fromPath: "c.md", toPath: "B.md" }),
    ).toEqual({ status: "rejected", code: "path_taken", path: "b.md" });
    expect(
      one(s, { type: "move", opId: id(), fileId: "f", fromPath: "c.md", toPath: "C.md" }),
    ).toMatchObject({ status: "accepted", path: "C.md" });
  });

  it("delete: idempotent; stale base refused", () => {
    const s = store();
    const a = put("f", "a.md", null);
    one(s, a);
    expect(one(s, { type: "delete", opId: id(), fileId: "f", baseVersionId: "old" })).toEqual({
      status: "rejected",
      code: "modified_since",
    });
    const v1 = a.type === "put" ? a.versionId : "";
    expect(one(s, { type: "delete", opId: id(), fileId: "f", baseVersionId: v1 })).toMatchObject({
      status: "accepted",
    });
    const head = s.head;
    expect(one(s, { type: "delete", opId: id(), fileId: "f", baseVersionId: v1 })).toMatchObject({
      status: "accepted",
      seq: head,
    });
    expect(s.head).toBe(head);
  });

  it("mkdir: same folder twice merges; a folder with live files can't be deleted", () => {
    const s = store();
    expect(one(s, { type: "mkdir", opId: id(), fileId: "d1", path: "D" })).toMatchObject({
      status: "accepted",
      fileId: "d1",
    });
    expect(one(s, { type: "mkdir", opId: id(), fileId: "d2", path: "d" })).toMatchObject({
      status: "accepted",
      fileId: "d1",
      path: "D",
    });
    one(s, put("f", "D/a.md", null));
    expect(one(s, { type: "delete", opId: id(), fileId: "d1", baseVersionId: null })).toEqual({
      status: "rejected",
      code: "modified_since",
    });
    expect(one(s, put("g", "d", null))).toEqual({
      status: "rejected",
      code: "path_taken",
      path: "D",
    });
  });
});
