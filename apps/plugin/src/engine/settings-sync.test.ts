import type { SyncSettings } from "@kamino/protocol";
import { Api, MemoryFs, type HttpRequest, type HttpResponse } from "@kamino/sync-engine";
import { describe, expect, it } from "vitest";
import { defaultSettings, type PluginSettings } from "../settings/model.js";
import { SettingsSync, SettingsUnavailable } from "./settings-sync.js";

const vault: SyncSettings = {
  config: { base: false, appearance: false, hotkeys: false, pluginList: false, plugins: false },
  patterns: [".trash/**"],
};

function server() {
  const s = {
    vault,
    override: null as SyncSettings | null,
    down: false,
    puts: 0,
    deviceFails: false,
  };
  const effective = () => s.override ?? s.vault;
  const handle = (r: HttpRequest): HttpResponse => {
    if (s.down) throw new Error("offline");
    if (r.path === "/vault/settings") return { status: 200, json: s.vault };
    if (s.deviceFails) return { status: 500 };
    if (r.path === "/device/settings" && r.method === "GET")
      return { status: 200, json: { override: s.override, effective: effective() } };
    s.puts++;
    s.override = (r.json as { override: SyncSettings | null }).override;
    return { status: 200, json: { override: s.override, effective: effective() } };
  };
  return { s, api: new Api({ request: async (r) => handle(r) }, () => "tok") };
}

describe("SettingsSync", () => {
  it("sets this device's override on the server and returns the effective settings", async () => {
    const { s, api } = server();
    let local: PluginSettings = defaultSettings(false);
    const notices: string[] = [];
    const sync = new SettingsSync({
      local: () => local,
      notice: (m) => notices.push(m),
      reloadText: "reload",
    });
    const fs = new MemoryFs();
    expect(await sync.load(api, fs)).toEqual(vault);
    expect(s.puts).toBe(0); // already following the vault
    local = { ...local, exclusions: ["private/**"] };
    expect((await sync.load(api, fs)).patterns).toEqual([".trash/**", "private/**"]);
    expect(s.puts).toBe(1);
    expect(notices).toEqual([]);
    local = {
      ...local,
      configDir: {
        useVaultDefault: false,
        categories: { ...local.configDir.categories, hotkeys: true },
      },
    };
    expect((await sync.load(api, fs)).config.hotkeys).toBe(true);
    expect(notices).toEqual(["reload"]); // S-12
  });

  it("offline, uses the last vault defaults it saw and this device's choices", async () => {
    const { s, api } = server();
    s.vault = { ...vault, patterns: ["archive/**"] };
    const local = { ...defaultSettings(false), exclusions: ["private/**"] };
    const fs = new MemoryFs();
    const sync = new SettingsSync({ local: () => local, notice: () => {}, reloadText: "" });
    await sync.load(api, fs);
    s.down = true;
    const again = new SettingsSync({ local: () => local, notice: () => {}, reloadText: "" });
    expect((await again.load(api, fs)).patterns).toEqual(["archive/**", "private/**"]);
  });
  it("if only the device part fails, the vault's exclusions still apply (review I5)", async () => {
    const { s, api } = server();
    s.vault = { ...vault, patterns: ["archive/**"] };
    s.deviceFails = true;
    const sync = new SettingsSync({
      local: () => defaultSettings(false),
      notice: () => {},
      reloadText: "",
    });
    const fs = new MemoryFs();
    expect((await sync.load(api, fs)).patterns).toEqual(["archive/**"]);
    // Saved: offline later, the same.
    s.down = true;
    expect((await sync.load(api, fs)).patterns).toEqual(["archive/**"]);
  });

  it("never having seen the vault defaults is an error, not the generic defaults (review I5)", async () => {
    const { s, api } = server();
    s.down = true;
    const sync = new SettingsSync({
      local: () => defaultSettings(false),
      notice: () => {},
      reloadText: "",
    });
    await expect(sync.load(api, new MemoryFs())).rejects.toBeInstanceOf(SettingsUnavailable);
  });
});
