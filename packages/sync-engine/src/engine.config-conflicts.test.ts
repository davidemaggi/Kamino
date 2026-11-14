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

  // rc.10 on iOS: the phone got the list with a new plugin, then Obsidian rewrote the file from
  // the list it held in memory since startup, and the last write won (ADR-0020).
  it("Obsidian rewriting a JSON file from a stale memory merges with what arrived", async () => {
    const server = new FakeServer();
    const pcFs = new MemoryFs();
    pcFs.put(".obsidian/community-plugins.json", '["kamino"]');
    const phoneFs = new MemoryFs();
    phoneFs.put(".obsidian/community-plugins.json", '["kamino"]');
    const pc = await Engine.open(deps(server, pcFs, "pc"));
    await pc.syncNow();
    let reloads = 0;
    const phoneDeps = () => ({
      ...deps(server, phoneFs, "phone"),
      onConfigApplied: () => reloads++,
    });
    let phone = await Engine.open(phoneDeps());
    await phone.syncNow();
    const sync = async (e: Engine) => {
      e.localChange();
      await e.syncNow();
    };
    // The Mac enables Excalidraw; the phone receives the list.
    pcFs.put(".obsidian/community-plugins.json", '["kamino","excalidraw"]');
    await sync(pc);
    await phone.syncNow();
    expect(phoneFs.text(".obsidian/community-plugins.json")).toBe('["kamino","excalidraw"]');
    // Obsidian on the phone rewrites the list it knew: Excalidraw stays.
    phoneFs.put(".obsidian/community-plugins.json", '[\n  "kamino"\n]');
    reloads = 0;
    await sync(phone);
    await pc.syncNow();
    // Nothing new of its own: the file is the Mac's again, and no new version goes up.
    const both = '["kamino","excalidraw"]';
    expect(phoneFs.text(".obsidian/community-plugins.json")).toBe(both);
    expect(server.files().get("{config}/community-plugins.json")).toBe(both);
    expect(pcFs.text(".obsidian/community-plugins.json")).toBe(both);
    expect(reloads).toBe(1);
    // Still stale (no reload yet), and it enables a plugin of its own: both kept.
    phoneFs.put(".obsidian/community-plugins.json", '["kamino","dataview"]');
    await sync(phone);
    expect(phoneFs.text(".obsidian/community-plugins.json")).toBe(
      '[\n  "kamino",\n  "dataview",\n  "excalidraw"\n]',
    );
    // After a reload Obsidian knows the whole list: turning Excalidraw off holds.
    await phone.stop();
    phone = await Engine.open(phoneDeps());
    await phone.syncNow();
    phoneFs.put(".obsidian/community-plugins.json", '["kamino","dataview"]');
    await sync(phone);
    await pc.syncNow();
    expect(pcFs.text(".obsidian/community-plugins.json")).toBe('["kamino","dataview"]');
    expect(phone.conflicts()).toEqual([]);
    expect(pc.conflicts()).toEqual([]);
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
