import { describe, expect, it } from "vitest";
import { ChangesResponse, CommitRequest, JournalEntry, Op, OpResult, Snapshot } from "./index.js";

const H = "a".repeat(64);

describe("sync contract", () => {
  it("ops are discriminated by type", () => {
    const put = {
      type: "put",
      opId: "o1",
      fileId: "f1",
      versionId: "v1",
      path: "a.md",
      baseVersionId: null,
      contentHash: H,
      size: 1,
      mtime: 0,
    };
    expect(Op.parse(put).type).toBe("put");
    expect(Op.safeParse({ ...put, contentHash: "XYZ" }).success).toBe(false);
    expect(
      Op.safeParse({ type: "move", opId: "o", fileId: "f", fromPath: "a", toPath: "b" }).success,
    ).toBe(true);
    expect(
      Op.safeParse({ type: "delete", opId: "o", fileId: "f", baseVersionId: null }).success,
    ).toBe(true);
  });

  it("commit batches hold 1 to 500 ops", () => {
    const op = { type: "mkdir", opId: "o", fileId: "f", path: "d" };
    expect(CommitRequest.safeParse({ ops: [] }).success).toBe(false);
    expect(CommitRequest.safeParse({ ops: Array(500).fill(op) }).success).toBe(true);
    expect(CommitRequest.safeParse({ ops: Array(501).fill(op) }).success).toBe(false);
  });

  it("results, including duplicates of the original", () => {
    const accepted = { status: "accepted", seq: 3, fileId: "f", versionId: "v", path: "a.md" };
    expect(OpResult.parse({ status: "duplicate", original: accepted }).status).toBe("duplicate");
    expect(
      OpResult.safeParse({ status: "rejected", code: "path_taken", path: "b.md" }).success,
    ).toBe(true);
    expect(OpResult.safeParse({ status: "rejected", code: "nope" }).success).toBe(false);
  });

  it("journal entries accept unknown types (03 §13)", () => {
    const e = {
      seq: 1,
      type: "something_new",
      fileId: "f",
      path: "a.md",
      deviceId: "d",
      at: "2026-01-01T00:00:00.000Z",
      ignorable: true,
    };
    expect(JournalEntry.parse(e).type).toBe("something_new");
    expect(ChangesResponse.parse({ entries: [e], head: 1, hasMore: false }).head).toBe(1);
  });

  it("snapshot", () => {
    const s = {
      head: 2,
      files: [
        {
          fileId: "f",
          kind: "file",
          path: "a.md",
          versionId: "v",
          contentHash: H,
          size: 1,
          mtime: 0,
        },
      ],
      openConflicts: [],
    };
    expect(Snapshot.parse(s).files).toHaveLength(1);
  });
});
