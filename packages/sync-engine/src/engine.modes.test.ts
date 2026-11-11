import { DEFAULT_SYNC_SETTINGS } from "@kamino/protocol";
import { describe, expect, it } from "vitest";
import { Engine, LIVE_FALLBACK_MS, type EngineDeps, type SyncMode } from "./engine.js";
import { MemoryFs } from "./memory-fs.js";
import { FakeServer } from "./testing/fake-server.js";
import { ManualClock } from "./testing/manual-clock.js";

const DEV = "dev-a";
let ids = 0;
function setup(mode: SyncMode, periodicMinutes = 15) {
  const server = new FakeServer();
  const fs = new MemoryFs();
  const clock = new ManualClock();
  const d: EngineDeps = {
    fs,
    http: server.http(DEV),
    socket: server.socket(DEV),
    clock,
    newId: () => `m-${++ids}`,
    config: {
      deviceId: DEV,
      platform: "linux",
      configDir: ".obsidian",
      settings: DEFAULT_SYNC_SETTINGS,
      batchSize: 50,
    },
    vaultId: "v",
    token: () => DEV,
    mode: { mode, periodicMinutes },
  };
  return { server, fs, clock, d };
}
const flush = async (clock: ManualClock) => {
  for (let i = 0; i < 30; i++) await clock.advance(0);
};

describe("sync modes (S-02)", () => {
  it("every mode syncs at start (S-03)", async () => {
    for (const mode of ["live", "periodic", "manual"] as const) {
      const { server, fs, clock, d } = setup(mode);
      fs.put("a.md", "x");
      const e = await Engine.open(d);
      e.start();
      await flush(clock);
      expect(server.files().get("a.md")).toBe("x");
      await e.stop();
    }
  });

  it("live: socket open; with the socket down, a pull every 5 minutes", async () => {
    const { server, clock, d } = setup("live");
    const e = await Engine.open(d);
    e.start();
    await flush(clock);
    expect(server.openSockets).toBe(1);
    server.down = true;
    server.closeAll(1006);
    await flush(clock);
    server.down = false;
    const before = server.pulls;
    // The socket keeps failing to reconnect (down again for the socket only).
    (server as unknown as { socket: () => unknown }).socket = () => () => ({
      send() {},
      close() {},
    });
    await clock.advance(LIVE_FALLBACK_MS);
    await flush(clock);
    expect(server.pulls).toBeGreaterThan(before);
    await e.stop();
  });

  it("periodic: no socket, a cycle every N minutes, local changes wait", async () => {
    const { server, fs, clock, d } = setup("periodic", 10);
    const e = await Engine.open(d);
    e.start();
    await flush(clock);
    expect(server.openSockets).toBe(0);
    fs.put("b.md", "y");
    e.localChange();
    await flush(clock);
    expect(server.files().has("b.md")).toBe(false);
    expect(e.snapshot().queued).toBeGreaterThan(0);
    await clock.advance(10 * 60_000);
    await flush(clock);
    expect(server.files().get("b.md")).toBe("y");
    await e.stop();
  });

  it("manual: nothing happens until syncNow", async () => {
    const { server, fs, clock, d } = setup("manual");
    const e = await Engine.open(d);
    e.start();
    await flush(clock);
    fs.put("c.md", "z");
    e.localChange();
    await clock.advance(24 * 3_600_000);
    await flush(clock);
    expect(server.files().has("c.md")).toBe(false);
    await e.syncNow();
    expect(server.files().get("c.md")).toBe("z");
    await e.stop();
  });

  it("switching mode twice leaves one timer and closes the socket", async () => {
    const { server, clock, d } = setup("live");
    const e = await Engine.open(d);
    e.start();
    await flush(clock);
    e.setMode("periodic", 1);
    e.setMode("periodic", 1);
    await flush(clock);
    expect(server.openSockets).toBe(0);
    const before = server.pulls;
    await clock.advance(60_000);
    await flush(clock);
    expect(server.pulls - before).toBe(1);
    e.setMode("live", 1);
    await flush(clock);
    expect(server.openSockets).toBe(1);
    await e.stop();
  });
});
