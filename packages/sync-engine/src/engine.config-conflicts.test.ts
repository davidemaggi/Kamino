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

  it("different content on two devices: one conflict, closed for good once resolved", async () => {
    const server = new FakeServer();
    const pcFs = new MemoryFs();
    pcFs.put(".obsidian/app.json", '{"pc":true}');
    const phoneFs = new MemoryFs();
    phoneFs.put(".obsidian/app.json", '{"phone":true}');
    const pc = await Engine.open(deps(server, pcFs, "pc"));
    await pc.syncNow();
    const phone = await Engine.open(deps(server, phoneFs, "phone"));
    await phone.syncNow();
    const [c] = phone.conflicts();
    const head = (await phone.conflictDetail(c!.id, false))!.head;
    expect(await phone.resolve([{ id: c!.id, choice: "incoming", head }])).toEqual(["ok"]);
    for (let i = 0; i < 3; i++) {
      await phone.syncNow();
      await pc.syncNow();
    }
    expect(phone.conflicts()).toEqual([]);
    expect(pc.conflicts()).toEqual([]);
    expect(phoneFs.text(".obsidian/app.json")).toBe('{"pc":true}');
  });
});
