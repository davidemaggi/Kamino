import { DEFAULT_SYNC_SETTINGS } from "@kamino/protocol";
import { describe, expect, it } from "vitest";
import { Engine, type EngineDeps } from "./engine.js";
import { MemoryFs } from "./memory-fs.js";
import { FakeServer } from "./testing/fake-server.js";

const NOW = Date.UTC(2026, 10, 14, 12, 51);
let ids = 0;
const settings = {
  ...DEFAULT_SYNC_SETTINGS,
  config: { base: true, appearance: true, hotkeys: true, pluginList: true, plugins: true },
};
const deps = (server: FakeServer, fs: MemoryFs, dev: string): EngineDeps => ({
  fs,
  http: server.http(dev),
  clock: { now: () => NOW, sleep: () => new Promise(() => {}), random: () => 0.5 },
  newId: () => `id-${++ids}`,
  config: { deviceId: dev, platform: "ios", configDir: ".obsidian", settings, batchSize: 7 },
  vaultId: "v",
  token: () => dev,
});

async function inSync() {
  const server = new FakeServer();
  const pcFs = new MemoryFs();
  pcFs.put(".obsidian/app.json", '{"pc":true}');
  const phoneFs = new MemoryFs();
  const pc = await Engine.open(deps(server, pcFs, "pc"));
  await pc.syncNow();
  const phone = await Engine.open(deps(server, phoneFs, "phone"));
  await phone.syncNow();
  expect(phoneFs.text(".obsidian/app.json")).toBe('{"pc":true}');
  return { server, pc, phone, pcFs, phoneFs };
}

describe("configuration files", () => {
  // rc.8: phones rewrote app.json as {} on old bases; every put opened a conflict that came
  // back as soon as it was resolved.
  it("the same content written on two devices is no conflict", async () => {
    const { server, pc, phone, pcFs, phoneFs } = await inSync();
    pcFs.put(".obsidian/app.json", "{}");
    pc.localChange();
    await pc.syncNow();
    phoneFs.put(".obsidian/app.json", "{}");
    phone.localChange();
    await phone.syncNow();
    expect(phone.conflicts()).toEqual([]);
    expect(server.files().get("{config}/app.json")).toBe("{}");
    // And the next edit on the phone goes up on a base the server knows.
    phoneFs.put(".obsidian/app.json", '{"phone":true}');
    phone.localChange();
    await phone.syncNow();
    await pc.syncNow();
    expect(phone.conflicts()).toEqual([]);
    expect(pc.conflicts()).toEqual([]);
    expect(pcFs.text(".obsidian/app.json")).toBe('{"phone":true}');
  });

  // rc.10: Obsidian rewrites community-plugins.json & co. with its own list on every device.
  it("different content on two devices: the last write wins, the other stays in the history", async () => {
    const server = new FakeServer();
    const pcFs = new MemoryFs();
    pcFs.put(".obsidian/community-plugins.json", '["a"]');
    const phoneFs = new MemoryFs();
    phoneFs.put(".obsidian/community-plugins.json", '["b"]');
    const pc = await Engine.open(deps(server, pcFs, "pc"));
    await pc.syncNow();
    const phone = await Engine.open(deps(server, phoneFs, "phone"));
    await phone.syncNow();
    expect(phone.conflicts()).toEqual([]);
    await pc.syncNow();
    expect(pc.conflicts()).toEqual([]);
    expect(server.files().get("{config}/community-plugins.json")).toBe('["b"]');
    expect(pcFs.text(".obsidian/community-plugins.json")).toBe('["b"]');
    // Both rewrite on an old base: still no conflict.
    pcFs.put(".obsidian/community-plugins.json", '["a"]');
    pc.localChange();
    phoneFs.put(".obsidian/community-plugins.json", '["c"]');
    phone.localChange();
    await pc.syncNow();
    await phone.syncNow();
    await pc.syncNow();
    expect(pc.conflicts()).toEqual([]);
    expect(phone.conflicts()).toEqual([]);
    expect(pcFs.text(".obsidian/community-plugins.json")).toBe('["c"]');
    expect(phoneFs.text(".obsidian/community-plugins.json")).toBe('["c"]');
  });

  it("notes still open a conflict", async () => {
    const server = new FakeServer();
    const pcFs = new MemoryFs();
    pcFs.put("Note.md", "pc");
    const phoneFs = new MemoryFs();
    phoneFs.put("Note.md", "phone");
    const pc = await Engine.open(deps(server, pcFs, "pc"));
    await pc.syncNow();
    const phone = await Engine.open(deps(server, phoneFs, "phone"));
    await phone.syncNow();
    expect(phone.conflicts()).toHaveLength(1);
  });
});

describe("blobs lost by the server", () => {
  // rc.10: a blob gone from storage left the other devices retrying a broken download forever.
  it("a device that has the content uploads it again, then the others get it", async () => {
    const server = new FakeServer();
    const pcFs = new MemoryFs();
    pcFs.put("Note.md", "hello");
    await (await Engine.open(deps(server, pcFs, "pc"))).syncNow();
    const hash = [...server.content.keys()][0]!;
    server.loseBlob(hash);
    const phoneFs = new MemoryFs();
    const phone = await Engine.open(deps(server, phoneFs, "phone"));
    await phone.syncNow();
    expect(phoneFs.text("Note.md")).toBeUndefined();
    // The next session on the pc puts it back.
    await (await Engine.open(deps(server, pcFs, "pc"))).syncNow();
    await phone.syncNow();
    expect(phoneFs.text("Note.md")).toBe("hello");
  });
});
