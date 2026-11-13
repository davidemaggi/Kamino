import { DEFAULT_SYNC_SETTINGS } from "@kamino/protocol";
import { conflictStamp } from "@kamino/sync-core";
import { describe, expect, it } from "vitest";
import { Engine, type EngineDeps, WEB_AUTHOR_ID } from "./engine.js";
import { MemoryFs } from "./memory-fs.js";
import { FakeServer } from "./testing/fake-server.js";

const DEV = "dev-a";
const NOW = Date.UTC(2026, 10, 13, 15, 30);
let ids = 0;
const deps = (server: FakeServer, fs: MemoryFs, dev = DEV): EngineDeps => ({
  fs,
  http: server.http(dev),
  clock: { now: () => NOW, sleep: () => new Promise(() => {}), random: () => 0.5 },
  newId: () => `id-${++ids}`,
  config: {
    deviceId: dev,
    platform: "linux",
    configDir: ".obsidian",
    settings: DEFAULT_SYNC_SETTINGS,
    batchSize: 7,
  },
  vaultId: "v",
  token: () => dev,
});
const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);
const enc = (s: string) => new TextEncoder().encode(s);

/** a.md synced on this device, then edited both here and on the phone: a conflict here. */
async function conflicted() {
  const server = new FakeServer();
  server.deviceNames.set("dev-b", "Phone");
  const fs = new MemoryFs();
  fs.put("a.md", "base");
  const e = await Engine.open(deps(server, fs));
  await e.syncNow();
  const f = server.store.snapshot().files.find((x) => x.path === "a.md")!;
  await server.remotePut(
    "dev-b",
    {
      opId: "rb",
      fileId: f.fileId,
      versionId: "vb",
      path: "a.md",
      baseVersionId: f.versionId,
      mtime: 5,
    },
    "theirs",
  );
  fs.put("a.md", "mine");
  e.localChange();
  await e.syncNow();
  const [c] = e.conflicts();
  return { server, fs, e, c: c! };
}

describe("engine conflict resolution (M3b, B3)", () => {
  it("lists the conflict and shows both sides, with the phone as the incoming author", async () => {
    const { e, c } = await conflicted();
    expect(c).toMatchObject({ path: "a.md", here: true });
    const d = (await e.conflictDetail(c.id, true))!;
    expect(d).toMatchObject({ kind: "concurrent_edit", head: "vb", path: "a.md" });
    expect(text(d.mine.bytes)).toBe("mine");
    expect(text(d.incoming.bytes)).toBe("theirs");
    expect(d.incoming.author).toEqual({ kind: "device", name: "Phone" });
    expect((await e.conflictDetail(c.id, false))!.mine.bytes).toBeNull();
  });

  it("keep mine: the local copy becomes the server's version", async () => {
    const { server, fs, e, c } = await conflicted();
    expect(await e.resolve([{ id: c.id, choice: "mine", head: "vb" }])).toEqual(["ok"]);
    expect(server.files().get("a.md")).toBe("mine");
    expect(fs.text("a.md")).toBe("mine");
    expect(e.conflicts()).toEqual([]);
  });

  it("keep incoming: the server's version comes down, the local one stays in history", async () => {
    const { server, fs, e, c } = await conflicted();
    expect(await e.resolve([{ id: c.id, choice: "incoming", head: "vb" }])).toEqual(["ok"]);
    await e.syncNow();
    expect(fs.text("a.md")).toBe("theirs");
    expect(server.files().get("a.md")).toBe("theirs");
    expect(
      server.store.hasContent(
        [...server.content.keys()].find((h) => text(server.content.get(h)!) === "mine")!,
      ),
    ).toBe(true);
    expect(e.conflicts()).toEqual([]);
  });

  it("keep both: the local copy goes next to the file, named after this device", async () => {
    const { server, fs, e, c } = await conflicted();
    const r = await e.resolve([
      { id: c.id, choice: "both", head: "vb", copy: { label: "conflict", device: "Mac" } },
    ]);
    expect(r).toEqual(["ok"]);
    await e.syncNow();
    const copy = `a (conflict - Mac - ${conflictStamp(new Date(NOW), false)}).md`;
    expect(server.files()).toEqual(
      new Map([
        ["a.md", "theirs"],
        [copy, "mine"],
      ]),
    );
    expect(fs.text("a.md")).toBe("theirs");
    expect(fs.text(copy)).toBe("mine");
  });

  it("manual merge: the text is written here, then kept", async () => {
    const { server, fs, e, c } = await conflicted();
    expect(
      await e.resolve([{ id: c.id, choice: "mine", head: "vb", text: enc("merged") }]),
    ).toEqual(["ok"]);
    expect(fs.text("a.md")).toBe("merged");
    expect(server.files().get("a.md")).toBe("merged");
  });

  it("a manual merge over a file changed since: stale, nothing written", async () => {
    const { fs, e, c } = await conflicted();
    const d = (await e.conflictDetail(c.id, false))!;
    fs.put("a.md", "typed meanwhile");
    // The engine has not scanned yet: the write must still refuse to replace unseen content.
    expect(
      await e.resolve([{ id: c.id, choice: "mine", head: d.head, text: enc("merged") }]),
    ).toEqual(["stale"]);
    expect(fs.text("a.md")).toBe("typed meanwhile");
  });

  it("stale when the server moved on since the user looked, gone when closed", async () => {
    const { server, e, c } = await conflicted();
    expect(await e.resolve([{ id: c.id, choice: "mine", head: "old" }])).toEqual(["stale"]);
    expect(await e.resolve([{ id: "nope", choice: "mine", head: "vb" }])).toEqual(["gone"]);
    void server;
  });

  it("resolved from the web app: the conflict goes away here, the web is the author", async () => {
    const { server, fs, e, c } = await conflicted();
    const f = server.store.snapshot().files.find((x) => x.path === "a.md")!;
    server.store.commit(
      [
        {
          type: "resolve",
          opId: "w1",
          conflictId: c.id,
          expectedHeadVersionId: f.versionId!,
          keep: { kind: "head" },
        },
      ],
      WEB_AUTHOR_ID,
    );
    await e.syncNow();
    expect(e.conflicts()).toEqual([]);
    // The local copy differs from what the web kept: it goes up as a new version, never lost.
    expect(
      server.store.hasContent(
        [...server.content.keys()].find((h) => text(server.content.get(h)!) === "mine")!,
      ),
    ).toBe(true);
    void fs;
  });

  it("the other device sees the conflict through the journal, not resolvable there", async () => {
    const { server, c } = await conflicted();
    const phone = await Engine.open(deps(server, new MemoryFs(), "dev-b"));
    await phone.syncNow();
    expect(phone.conflicts()).toEqual([{ id: c.id, fileId: c.fileId, path: "a.md", here: false }]);
    expect(await phone.conflictDetail(c.id, false)).toBeNull();
    expect(await phone.resolve([{ id: c.id, choice: "mine", head: "vb" }])).toEqual(["stale"]);
  });
});

/**
 * rc.4 bug: two new vaults each create their own "Benvenuto.md" (Obsidian's welcome note).
 * The second device gets a both_created conflict; "keep incoming" moved the local file to the
 * trash and never downloaded the server's version: the file was gone from this device.
 */
describe("both created on two devices, then keep incoming (rc.4)", () => {
  async function bothCreated() {
    const server = new FakeServer();
    server.deviceNames.set("dev-b", "Phone");
    const phoneFs = new MemoryFs();
    phoneFs.put("Benvenuto.md", "theirs");
    const phone = await Engine.open(deps(server, phoneFs, "dev-b"));
    await phone.syncNow();
    const fs = new MemoryFs();
    fs.put("Benvenuto.md", "mine");
    const e = await Engine.open(deps(server, fs));
    await e.syncNow();
    const [c] = e.conflicts();
    return { server, fs, e, c: c! };
  }

  it("the conflict is here, on the welcome note", async () => {
    const { c } = await bothCreated();
    expect(c).toMatchObject({ path: "Benvenuto.md", here: true });
  });

  it("keep incoming: the server's version is on disk, at the same path", async () => {
    const { server, fs, e, c } = await bothCreated();
    const d = (await e.conflictDetail(c.id, false))!;
    expect(await e.resolve([{ id: c.id, choice: "incoming", head: d.head }])).toEqual(["ok"]);
    await e.syncNow();
    await e.syncNow();
    expect(fs.text("Benvenuto.md")).toBe("theirs");
    expect(server.files().get("Benvenuto.md")).toBe("theirs");
    expect(e.conflicts()).toEqual([]);
  });

  it("keep mine and keep both leave a file at the path too", async () => {
    for (const choice of ["mine", "both"] as const) {
      const { fs, e, c } = await bothCreated();
      const d = (await e.conflictDetail(c.id, false))!;
      await e.resolve([{ id: c.id, choice, head: d.head }]);
      await e.syncNow();
      await e.syncNow();
      expect(fs.text("Benvenuto.md"), choice).not.toBeNull();
    }
  });
});

/**
 * rc.4 bug, the real cause: to replace a file the plugin sets the old one aside in its own
 * folder, and Obsidian reports that as a rename. The engine took it for the user moving the file
 * into an excluded area: it stopped following it, and the downloaded version that then appeared
 * at the path looked untracked, already on the server, so it went to the trash.
 */
describe("the plugin's own set-aside is not a user move (rc.4)", () => {
  const ASIDE = ".obsidian/plugins/kamino-sync/tmp/0123456789abcdef01234567.old";

  it("keep incoming with Obsidian's rename event: the file stays, with the server's version", async () => {
    const { server, fs, e, c } = await conflicted();
    expect(await e.resolve([{ id: c.id, choice: "incoming", head: "vb" }])).toEqual(["ok"]);
    await e.syncNow();
    expect(fs.text("a.md")).toBe("theirs");
    e.localRename("a.md", ASIDE); // reported by Obsidian after the replacement
    fs.put("a.md", "theirs"); // the new file at the path: a fresh mtime, hashed again
    e.localChange();
    await e.syncNow();
    await e.syncNow();
    expect(fs.text("a.md")).toBe("theirs");
    expect(fs.trashed).toEqual([]);
    expect(server.files().get("a.md")).toBe("theirs");
    expect(e.snapshot().queued).toBe(0);
    // Still the same file: an edit here goes up as a new version, no conflict.
    fs.put("a.md", "later");
    e.localChange();
    await e.syncNow();
    expect(server.files().get("a.md")).toBe("later");
    expect(e.conflicts()).toEqual([]);
  });
});
