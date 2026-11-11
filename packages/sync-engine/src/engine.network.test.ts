import { DEFAULT_SYNC_SETTINGS } from "@kamino/protocol";
import { describe, expect, it } from "vitest";
import { Engine, type EngineDeps } from "./engine.js";
import { MemoryFs } from "./memory-fs.js";
import type { Network } from "./network.js";
import { FakeServer } from "./testing/fake-server.js";

const DEV = "dev-a";
let ids = 0;
function setup(network: Network, thresholdBytes = 10) {
  const server = new FakeServer();
  const fs = new MemoryFs();
  const d: EngineDeps = {
    fs,
    http: server.http(DEV),
    clock: { now: () => 1, sleep: () => new Promise<void>(() => {}), random: () => 0.5 },
    newId: () => `n-${++ids}`,
    config: {
      deviceId: DEV,
      platform: "ios",
      configDir: ".obsidian",
      settings: DEFAULT_SYNC_SETTINGS,
      batchSize: 50,
    },
    vaultId: "v",
    token: () => DEV,
    network,
    wifiOnly: () => ({ enabled: true, thresholdBytes }),
  };
  return { server, fs, d };
}
const fixed = (kind: "free" | "metered" | "ask", answer = false) => {
  const n = { asked: 0, kind: () => kind, ask: async () => (n.asked++, answer) };
  return n;
};

describe("large attachments only on Wi-Fi (S-08)", () => {
  it("on a metered network, big files wait; notes and small files pass", async () => {
    const { server, fs, d } = setup(fixed("metered"));
    fs.put("note.md", "short");
    fs.put("video.bin", "x".repeat(50));
    const e = await Engine.open(d);
    await e.syncNow();
    expect([...server.files().keys()]).toEqual(["note.md"]);
    expect(e.deferred()).toEqual([
      { path: "video.bin", size: 50, direction: "upload", reason: "network" },
    ]);
    expect(e.snapshot().queued).toBeGreaterThan(0); // never "safe" while something waits
  });

  it("big downloads wait too, and still count as not safe", async () => {
    const { server, fs, d } = setup(fixed("metered"));
    await server.remotePut(
      "dev-b",
      { opId: "o", fileId: "f", versionId: "v1", path: "big.bin", baseVersionId: null, mtime: 1 },
      "y".repeat(50),
    );
    const e = await Engine.open(d);
    await e.syncNow();
    expect(fs.files.has("big.bin")).toBe(false);
    expect(e.deferred()).toEqual([
      expect.objectContaining({ path: "big.bin", direction: "download", reason: "network" }),
    ]);
    expect(e.snapshot().queued).toBeGreaterThan(0);
  });

  it("transferNow lets that one file through", async () => {
    const { server, fs, d } = setup(fixed("metered"));
    fs.put("a.bin", "x".repeat(50));
    fs.put("b.bin", "z".repeat(50));
    const e = await Engine.open(d);
    await e.syncNow();
    await e.transferNow("a.bin");
    expect(server.files().has("a.bin")).toBe(true);
    expect(server.files().has("b.bin")).toBe(false);
  });

  it("iOS: asks once per cycle; yes lets the cycle's large files through", async () => {
    const n = fixed("ask", true);
    const { server, fs, d } = setup(n);
    fs.put("a.bin", "x".repeat(50));
    fs.put("b.bin", "z".repeat(50));
    const e = await Engine.open(d);
    await e.syncNow();
    expect(n.asked).toBe(1);
    expect(server.files().size).toBe(2);
    fs.put("c.bin", "w".repeat(50));
    await e.syncNow();
    expect(n.asked).toBe(2); // asked again: "don't ask again" is the plugin's choice
    expect(server.files().size).toBe(3);
  });

  it("iOS: no means they wait, asked again at the next cycle", async () => {
    const n = fixed("ask", false);
    const { server, fs, d } = setup(n);
    fs.put("a.bin", "x".repeat(50));
    const e = await Engine.open(d);
    await e.syncNow();
    expect(server.files().size).toBe(0);
    await e.syncNow();
    expect(n.asked).toBe(2);
  });

  it("a network change mid-batch defers only the next files", async () => {
    let kind: "free" | "metered" = "free";
    const net = { kind: () => kind, ask: async () => false };
    const { server, fs, d } = setup(net);
    fs.put("a.bin", "x".repeat(50));
    fs.put("b.bin", "z".repeat(50));
    const read = fs.read.bind(fs);
    let reads = 0;
    fs.read = (p: string) => {
      // The first upload read (after the two scan reads): the phone leaves the Wi-Fi.
      if (++reads === 3) kind = "metered";
      return read(p);
    };
    const e = await Engine.open(d);
    await e.syncNow();
    const uploaded = [...server.files().keys()];
    expect(uploaded.length).toBe(1);
    expect(e.deferred().map((f) => f.path)).toEqual(
      ["a.bin", "b.bin"].filter((p) => !uploaded.includes(p)),
    );
  });
});
