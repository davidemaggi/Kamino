import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "./model.js";
import { SettingsStore } from "./store.js";

function io(initial: unknown = null) {
  let data: unknown = initial;
  return {
    loadData: () => Promise.resolve(structuredClone(data)),
    saveData: vi.fn((d: unknown) => {
      data = structuredClone(d);
      return Promise.resolve();
    }),
    data: () => data,
  };
}

describe("SettingsStore", () => {
  it("defaults when data.json is missing", async () => {
    const s = new SettingsStore(io(), false);
    await s.load();
    expect(s.get()).toEqual(defaultSettings(false));
    expect(s.linkStore.load()).toBeNull();
  });

  it("update normalizes, saves and notifies, keeping the link", async () => {
    const file = io({
      link: {
        server: "https://s",
        host: "s",
        user: "u",
        vaultId: "v",
        vaultName: "V",
        deviceName: "D",
      },
    });
    const s = new SettingsStore(file, false);
    await s.load();
    const cb = vi.fn();
    s.onChange(cb);
    await s.update((x) => ({ ...x, sync: { ...x.sync, liveDebounceSec: 100 } }));
    expect(s.get().sync.liveDebounceSec).toBe(30);
    expect(cb).toHaveBeenCalled();
    expect(file.data()).toMatchObject({
      settings: { sync: { liveDebounceSec: 30 } },
      link: { vaultId: "v" },
    });
  });

  it("linkStore saves under its own key and survives a reload", async () => {
    const file = io();
    const s = new SettingsStore(file, false);
    await s.load();
    s.linkStore.save({
      server: "https://s",
      host: "s",
      user: "u",
      vaultId: "v",
      vaultName: "V",
      deviceName: "D",
    });
    await Promise.resolve();
    const again = new SettingsStore(file, false);
    await again.load();
    expect(again.linkStore.load()?.vaultId).toBe("v");
  });

  it("a broken data.json falls back to defaults", async () => {
    const s = new SettingsStore(io("not an object"), true);
    await s.load();
    expect(s.get()).toEqual(defaultSettings(true));
  });
});
