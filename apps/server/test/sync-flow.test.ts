import { ChangesResponse, CommitResponse, Snapshot } from "@kamino/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { linkDevice, uploadContent, user } from "./helpers/sync.js";

describe.skipIf(dockerUnavailable)("sync flow: two devices", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let n = 0;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => pg?.stop());
  beforeEach(async () => {
    await t?.close();
    t = await testApp(await pg.createDatabase(`flow_${++n}`));
  });

  it("upload, commit, pull, download, edit, conflict, snapshot, ack, isolation", async () => {
    const enroll = await user(t, "mario");
    const a = await linkDevice(t, enroll, undefined, "Mac");
    const b = await linkDevice(t, enroll, a.vaultId, "iPhone");
    const base = `/vaults/${a.vaultId}`;

    // A creates a.md.
    const v1 = Buffer.from("first version of the note");
    const h1 = await uploadContent(a, v1);
    const put1 = {
      type: "put",
      opId: "o1",
      fileId: "f1",
      versionId: "v1",
      path: "notes/a.md",
      baseVersionId: null,
      contentHash: h1,
      size: v1.length,
      mtime: 1,
    };
    const c1 = CommitResponse.parse(
      (await a.call("POST", `${base}/commits`, { ops: [put1] })).json(),
    );
    expect(c1.results[0]).toMatchObject({ status: "accepted", seq: 1, path: "notes/a.md" });
    // Repeating the same op is a duplicate (idempotence).
    expect(
      CommitResponse.parse((await a.call("POST", `${base}/commits`, { ops: [put1] })).json())
        .results[0]!.status,
    ).toBe("duplicate");

    // B pulls and downloads it.
    const ch = ChangesResponse.parse((await b.call("GET", `${base}/changes?after=0`)).json());
    expect(ch.entries).toMatchObject([
      {
        seq: 1,
        type: "file_put",
        fileId: "f1",
        path: "notes/a.md",
        contentHash: h1,
        opId: "o1",
        deviceId: a.deviceId,
      },
    ]);
    expect((await b.call("GET", `${base}/blobs/${h1}`)).rawPayload.equals(v1)).toBe(true);

    // B edits on the current base → accepted; A edits on the old base → conflict.
    const v2 = Buffer.from("edited on the phone");
    const h2 = await uploadContent(b, v2);
    const okB = await b.call("POST", `${base}/commits`, {
      ops: [
        {
          ...put1,
          opId: "o2",
          versionId: "v2",
          baseVersionId: "v1",
          contentHash: h2,
          size: v2.length,
        },
      ],
    });
    expect(okB.json().results[0]).toMatchObject({ status: "accepted", seq: 2 });
    const v3 = Buffer.from("edited on the mac meanwhile");
    const h3 = await uploadContent(a, v3);
    const conflictA = await a.call("POST", `${base}/commits`, {
      ops: [
        {
          ...put1,
          opId: "o3",
          versionId: "v3",
          baseVersionId: "v1",
          contentHash: h3,
          size: v3.length,
        },
      ],
    });
    expect(conflictA.json().results[0]).toMatchObject({ status: "conflict", headVersionId: "v2" });
    // Every version keeps its declared base, conflict candidates included (05 §5).
    const bases = await t.db.$client<
      { id: string; base_version_id: string | null }[]
    >`select id, base_version_id from file_versions order by id`;
    expect(bases).toEqual([
      { id: "v1", base_version_id: null },
      { id: "v2", base_version_id: "v1" },
      { id: "v3", base_version_id: "v1" },
    ]);

    // Snapshot: the current version and the open conflict; nothing lost.
    const snap = Snapshot.parse((await b.call("GET", `${base}/snapshot`)).json());
    expect(snap.head).toBe(3);
    expect(snap.files).toMatchObject([
      { fileId: "f1", path: "notes/a.md", versionId: "v2", contentHash: h2 },
    ]);
    expect(snap.openConflicts).toHaveLength(1);

    // Ack moves the cursor forward only, up to the head.
    expect((await b.call("POST", `${base}/ack`, { seq: 3 })).statusCode).toBe(204);
    await b.call("POST", `${base}/ack`, { seq: 1 });
    await b.call("POST", `${base}/ack`, { seq: 99 });
    const [row] = await t.db.$client<
      { cursor_seq: string }[]
    >`select cursor_seq from devices where id = ${b.deviceId}`;
    expect(Number(row!.cursor_seq)).toBe(3);

    // Status reports are stored (codes only).
    expect(
      (
        await b.call("POST", `${base}/status`, {
          pendingOps: 2,
          pendingBytes: 10,
          deferredFiles: 0,
          lastErrorCode: "quota_exceeded",
        })
      ).statusCode,
    ).toBe(204);

    // Another user's device can't touch this vault.
    const other = await linkDevice(t, await user(t, "luigi"));
    expect((await other.call("GET", `${base}/changes?after=0`)).statusCode).toBe(404);
    expect((await other.call("POST", `${base}/commits`, { ops: [put1] })).statusCode).toBe(404);
  });

  it("a cursor below the journal floor gets 410 cursor_too_old; commits notify", async () => {
    const a = await linkDevice(t, await user(t, "mario"));
    const base = `/vaults/${a.vaultId}`;
    await t.db.$client`update vaults set journal_floor = 5, head_seq = 5 where id = ${a.vaultId}`;
    const old = await a.call("GET", `${base}/changes?after=4`);
    expect(old.statusCode).toBe(410);
    expect(old.json().error.code).toBe("cursor_too_old");
    expect((await a.call("GET", `${base}/changes?after=5`)).statusCode).toBe(200);
    await t.db.$client`update vaults set journal_floor = 0, head_seq = 0 where id = ${a.vaultId}`;
    // Beyond the head is not in the journal either (e.g. a server restored from a backup).
    expect((await a.call("GET", `${base}/changes?after=1`)).statusCode).toBe(410);

    const heard: string[] = [];
    const sub = await t.db.$client.listen("kamino_vault", (p) => heard.push(p));
    const content = Buffer.from("x");
    const h = await uploadContent(a, content);
    await a.call("POST", `${base}/commits`, {
      ops: [
        {
          type: "put",
          opId: "o1",
          fileId: "f1",
          versionId: "v1",
          path: "a.md",
          baseVersionId: null,
          contentHash: h,
          size: 1,
          mtime: 1,
        },
      ],
    });
    await expect.poll(() => heard).toEqual([`${a.vaultId}:1`]);
    await sub.unlisten();
  });

  it("paths and hashes are encrypted at rest", async () => {
    const a = await linkDevice(t, await user(t, "mario"));
    const content = Buffer.from("secret note");
    const h = await uploadContent(a, content);
    await a.call("POST", `/vaults/${a.vaultId}/commits`, {
      ops: [
        {
          type: "put",
          opId: "o1",
          fileId: "f1",
          versionId: "v1",
          path: "Diario/segreto.md",
          baseVersionId: null,
          contentHash: h,
          size: content.length,
          mtime: 1,
        },
      ],
    });
    // Bytes as text (JSON would turn Buffers into number lists and hide any plaintext).
    const asText = (rows: Record<string, unknown>[]) =>
      rows
        .map((r) =>
          Object.values(r)
            .map((v) => (Buffer.isBuffer(v) ? v.toString("latin1") : String(v)))
            .join("|"),
        )
        .join("\n");
    const dump = [
      asText(await t.db.$client`select * from files`),
      asText(await t.db.$client`select * from journal`),
      asText(await t.db.$client`select * from file_versions`),
    ].join("\n");
    expect(dump.length).toBeGreaterThan(100);
    expect(dump).not.toContain("segreto");
    expect(dump).not.toContain(h);
  });
});
