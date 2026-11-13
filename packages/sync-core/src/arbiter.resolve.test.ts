import type { Op, ResolveKeep } from "@kamino/protocol";
import { describe, expect, it } from "vitest";
import { checkInvariants, MemoryStore } from "./store.js";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);
let n = 0;
const id = () => `r${++n}`;
const put = (fileId: string, path: string, base: string | null, hash: string, versionId = id()) =>
  ({
    type: "put",
    opId: id(),
    fileId,
    versionId,
    path,
    baseVersionId: base,
    contentHash: hash,
    size: 1,
    mtime: 0,
  }) satisfies Op;
const resolve = (conflictId: string, expectedHeadVersionId: string, keep: ResolveKeep): Op => ({
  type: "resolve",
  opId: id(),
  conflictId,
  expectedHeadVersionId,
  keep,
});
const one = (s: MemoryStore, op: Op, device = "d1") => s.commit([op], device).results[0]!;

/** A file at head v2 (H2) with an open conflict whose candidate is c1 (H3). */
function conflicted() {
  const s = new MemoryStore();
  for (const h of [H1, H2, H3]) s.blobs.add(h);
  one(s, put("f", "Nota.md", null, H1, "v1"));
  one(s, put("f", "Nota.md", "v1", H2, "v2"));
  const r = one(s, put("f", "Nota.md", "v1", H3, "c1"), "d2");
  if (r.status !== "conflict") throw new Error("expected a conflict");
  return { s, conflictId: r.conflictId };
}

describe("arbiter: resolve (03 §9.3)", () => {
  it("keep head: closes the conflict, the head stays, conflict_resolved names it", () => {
    const { s, conflictId } = conflicted();
    const r = one(s, resolve(conflictId, "v2", { kind: "head" }));
    expect(r).toMatchObject({ status: "accepted", fileId: "f", versionId: "v2", path: "Nota.md" });
    expect(s.files.get("f")!.headVersionId).toBe("v2");
    expect(s.conflicts.get(conflictId)!.status).toBe("resolved");
    expect(s.journal.at(-1)).toMatchObject({
      type: "conflict_resolved",
      fileId: "f",
      conflictId,
      versionId: "v2",
      contentHash: H2,
    });
    expect(s.snapshot().openConflicts).toEqual([]);
    expect(checkInvariants(s)).toEqual([]);
  });

  it("keep head on a file deleted meanwhile brings it back: the kept content never sits in the trash", () => {
    const { s, conflictId } = conflicted();
    expect(one(s, { type: "delete", opId: id(), fileId: "f", baseVersionId: "v2" }).status).toBe(
      "accepted",
    );
    one(s, put("g", "Nota.md", null, H1, "g1"));
    const r = one(s, resolve(conflictId, "v2", { kind: "head" }));
    expect(r).toMatchObject({ status: "accepted", versionId: "v2", path: "Nota (1).md" });
    expect(s.files.get("f")).toMatchObject({ deleted: false, path: "Nota (1).md" });
    expect(s.journal.slice(-2).map((e) => [e.type, e.versionId, e.path])).toEqual([
      ["file_restored", "v2", "Nota (1).md"],
      ["conflict_resolved", "v2", "Nota (1).md"],
    ]);
    expect(checkInvariants(s)).toEqual([]);
  });

  it("keep candidate: a new head with the candidate's content, base = old head", () => {
    const { s, conflictId } = conflicted();
    const r = one(
      s,
      resolve(conflictId, "v2", { kind: "candidate", candidateVersionId: "c1", versionId: "v3" }),
    );
    expect(r).toMatchObject({ status: "accepted", versionId: "v3" });
    expect(s.files.get("f")).toMatchObject({ headVersionId: "v3", headHash: H3 });
    expect(s.versions.get("v3")).toMatchObject({ hash: H3 });
    expect(s.journal.slice(-2).map((e) => [e.type, e.versionId])).toEqual([
      ["file_put", "v3"],
      ["conflict_resolved", "v3"],
    ]);
    expect(checkInvariants(s)).toEqual([]);
  });

  it("keep content: a new head with uploaded content; the blob must be there", () => {
    const { s, conflictId } = conflicted();
    const H4 = "4".repeat(64);
    const keep: ResolveKeep = {
      kind: "content",
      versionId: "v3",
      contentHash: H4,
      size: 9,
      mtime: 5,
    };
    expect(one(s, resolve(conflictId, "v2", keep))).toEqual({
      status: "rejected",
      code: "blob_missing",
    });
    s.blobs.add(H4);
    expect(one(s, resolve(conflictId, "v2", keep))).toMatchObject({ status: "accepted" });
    expect(s.files.get("f")).toMatchObject({ headHash: H4, size: 9, mtime: 5 });
  });

  it("keep both: the head stays, the candidate becomes a new file, with a suffix if taken", () => {
    const { s, conflictId } = conflicted();
    s.blobs.add(H1);
    one(s, put("g", "Nota (copia).md", null, H1));
    const r = one(
      s,
      resolve(conflictId, "v2", {
        kind: "both",
        candidateVersionId: "c1",
        fileId: "sib",
        versionId: "s1",
        path: "nota (copia).md",
      }),
    );
    expect(r).toMatchObject({ status: "accepted", fileId: "f", versionId: "v2" });
    const sib = s.files.get("sib")!;
    expect(sib.path).not.toBe("nota (copia).md");
    expect(sib).toMatchObject({ headVersionId: "s1", headHash: H3, deleted: false });
    expect(s.journal.slice(-2).map((e) => [e.type, e.fileId])).toEqual([
      ["file_put", "sib"],
      ["conflict_resolved", "f"],
    ]);
    expect(checkInvariants(s)).toEqual([]);
  });

  it("stale: a head that moved on, or a conflict already closed", () => {
    const { s, conflictId } = conflicted();
    expect(one(s, resolve(conflictId, "v1", { kind: "head" }))).toEqual({
      status: "rejected",
      code: "stale_resolution",
    });
    one(s, resolve(conflictId, "v2", { kind: "head" }));
    expect(one(s, resolve(conflictId, "v2", { kind: "head" }))).toEqual({
      status: "rejected",
      code: "stale_resolution",
    });
  });

  it("idempotent by opId; unknown conflict or candidate rejected", () => {
    const { s, conflictId } = conflicted();
    const op = resolve(conflictId, "v2", { kind: "head" });
    const first = one(s, op);
    expect(one(s, op)).toEqual({ status: "duplicate", original: first });
    expect(one(s, resolve("nope", "v2", { kind: "head" }))).toEqual({
      status: "rejected",
      code: "not_found",
    });
    const c = conflicted();
    expect(
      one(
        c.s,
        resolve(c.conflictId, "v2", {
          kind: "candidate",
          candidateVersionId: "v1",
          versionId: "v9",
        }),
      ),
    ).toEqual({ status: "rejected", code: "invalid_request" });
    expect(
      one(
        c.s,
        resolve(c.conflictId, "v2", {
          kind: "candidate",
          candidateVersionId: "c1",
          versionId: "v1",
        }),
      ),
    ).toEqual({ status: "rejected", code: "invalid_request" });
  });

  it("a new conflict can open after one is resolved", () => {
    const { s, conflictId } = conflicted();
    one(s, resolve(conflictId, "v2", { kind: "head" }));
    const again = one(s, put("f", "Nota.md", "v1", H1));
    expect(again).toMatchObject({ status: "conflict" });
    if (again.status !== "conflict") throw new Error();
    expect(again.conflictId).not.toBe(conflictId);
    expect(checkInvariants(s)).toEqual([]);
  });

  it("on a file deleted meanwhile: keep candidate brings it back", () => {
    const { s, conflictId } = conflicted();
    one(s, { type: "delete", opId: id(), fileId: "f", baseVersionId: "v2" });
    const r = one(
      s,
      resolve(conflictId, "v2", { kind: "candidate", candidateVersionId: "c1", versionId: "v3" }),
    );
    expect(r).toMatchObject({ status: "accepted", path: "Nota.md" });
    expect(s.files.get("f")).toMatchObject({ deleted: false, headVersionId: "v3" });
    expect(s.journal.slice(-2).map((e) => e.type)).toEqual(["file_restored", "conflict_resolved"]);
  });
});
