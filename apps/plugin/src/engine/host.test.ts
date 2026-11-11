import { DEFAULT_SYNC_SETTINGS, type SyncSettings } from "@kamino/protocol";
import { MemoryFs } from "@kamino/sync-engine";
import { describe, expect, it } from "vitest";
import { EngineHost } from "./host.js";
import { SettingsUnavailable } from "./settings-sync.js";

describe("EngineHost", () => {
  it("without the vault settings the engine waits paused, then starts once they arrive (review I5)", async () => {
    const wakeups: Array<() => void> = [];
    let available = false;
    const vault: SyncSettings = { ...DEFAULT_SYNC_SETTINGS, patterns: ["archive/**"] };
    const host = new EngineHost({
      current: () => ({ server: "https://s", vaultId: "v", deviceId: "d", deviceToken: "t" }),
      fs: () => new MemoryFs(),
      http: () => ({ request: () => Promise.reject(new Error("offline")) }),
      platform: "linux",
      configDir: ".obsidian",
      clock: {
        now: () => 1,
        sleep: () => new Promise<void>((r) => wakeups.push(r)),
        random: () => 0.5,
      },
      newId: () => "x",
      loadSettings: async () => {
        if (!available) throw new SettingsUnavailable();
        return vault;
      },
    });
    await host.refresh();
    const engine = host.engine()!;
    expect(engine.paused).toBe(true);
    available = true;
    // Every pending sleep ends: the host retries the settings.
    for (const w of wakeups.splice(0)) w();
    await new Promise((r) => setTimeout(r, 10));
    expect(engine.paused).toBe(false);
    await host.stop();
  });
});
