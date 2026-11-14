import { DEFAULT_SYNC_SETTINGS, type SyncSettings } from "@kamino/protocol";
import {
  Api,
  Engine,
  type Clock,
  type EngineDeps,
  type Http,
  type Network,
  type PairingMessage,
  type SocketFactory,
  type SyncMode,
  type VaultFs,
} from "@kamino/sync-engine";

export type SyncPlatform = EngineDeps["config"]["platform"];

export interface EngineHostOptions {
  /** The device's link and token (from the connection service). */
  current: () => { server: string; vaultId: string; deviceId: string; deviceToken: string } | null;
  /** The vault, with the engine's state in a folder of this device (a new link starts afresh). */
  fs: (deviceId: string) => VaultFs;
  http: (server: string) => Http;
  platform: SyncPlatform;
  configDir: string;
  clock: Clock;
  newId: () => string;
  settings?: () => SyncSettings;
  /** Effective settings before the first cycle and on every change (E10). */
  loadSettings?: (api: Api, fs: VaultFs) => Promise<SyncSettings>;
  /** Codes only. */
  log?: (code: string) => void;
  /** M2b: realtime doorbell for a server URL, network, Wi-Fi option, mode. */
  socket?: (server: string) => SocketFactory;
  client?: { pluginVersion: string; platform: string };
  network?: Network;
  wifiOnly?: () => { enabled: boolean; thresholdBytes: number };
  mode?: () => { mode: SyncMode; periodicMinutes: number };
  /** Pairing news from the realtime channel (03 §10). */
  onPairing?: (message: PairingMessage) => void;
  /** S-12: another device changed the configuration folder here. */
  onConfigApplied?: () => void;
}

/** One engine per link: opened when the device is linked, stopped when it is unlinked. */
export class EngineHost {
  private current: Engine | null = null;
  private key: string | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private off: (() => void) | null = null;
  private io: { api: Api; fs: VaultFs } | null = null;
  /** I11: stopped for good (plugin unloaded): never opens an engine again. */
  private disposed = false;

  constructor(private readonly o: EngineHostOptions) {}

  engine(): Engine | null {
    return this.current;
  }

  /** The other active devices of this vault (forced sync targets, ADR-0019). */
  async otherDevices(): Promise<{ id: string; name: string }[]> {
    const link = this.o.current();
    if (!this.io || !link) return [];
    const all = await this.io.api.vaultDevices();
    return all
      .filter((d) => !d.revoked && d.id !== link.deviceId)
      .map((d) => ({ id: d.id, name: d.name }));
  }

  /** Follows the link: call at startup and whenever it changes. */
  refresh(): Promise<void> {
    this.chain = this.chain
      .then(() => this.apply())
      .catch(() => this.o.log?.("engine_open_failed"));
    return this.chain;
  }

  private async apply(): Promise<void> {
    if (this.disposed) return;
    const link = this.o.current();
    const key = link ? `${link.server}|${link.vaultId}|${link.deviceId}` : null;
    if (key === this.key) return;
    if (this.current) {
      this.off?.();
      await this.current.stop();
      this.current = null;
    }
    this.key = key;
    if (link) {
      const token = link.deviceToken;
      const fs = this.o.fs(link.deviceId);
      // I9: an interrupted replacement is recovered before anything else runs.
      await (fs as Partial<{ ready(): Promise<void> }>).ready?.();
      const http = this.o.http(link.server);
      const api = new Api(http, () => token);
      this.io = { api, fs };
      // Never a cycle with fewer exclusions than the user set: settings first. Without them
      // (never seen, server unreachable) the engine waits paused until they arrive (I5).
      let settings = this.o.settings?.() ?? DEFAULT_SYNC_SETTINGS;
      let known = true;
      if (this.o.loadSettings)
        try {
          settings = await this.o.loadSettings(api, fs);
        } catch {
          known = false;
        }
      let engine: Engine;
      try {
        engine = await this.openEngine(fs, http, link, settings, token);
      } catch {
        // M6: never stuck without an engine: try again in a while.
        this.key = null;
        this.o.log?.("engine_open_failed");
        void this.o.clock.sleep(30_000).then(() => this.refresh());
        return;
      }
      this.current = engine;
      this.off = engine.onChange(() => this.emit());
      if (!known) {
        engine.pause();
        void this.waitForSettings(engine);
      }
      engine.start();
    }
    this.emit();
  }

  private openEngine(
    fs: VaultFs,
    http: Http,
    link: { server: string; vaultId: string; deviceId: string },
    settings: SyncSettings,
    token: string,
  ): Promise<Engine> {
    const o = this.o;
    return Engine.open({
      fs,
      http,
      onSettingsChanged: () => void this.reloadSettings(),
      clock: o.clock,
      newId: o.newId,
      vaultId: link.vaultId,
      token: () => token,
      config: {
        deviceId: link.deviceId,
        platform: o.platform,
        configDir: o.configDir,
        settings,
        batchSize: 200,
      },
      ...(o.log ? { log: o.log } : {}),
      ...(o.socket ? { socket: o.socket(link.server) } : {}),
      ...(o.client ? { client: o.client } : {}),
      ...(o.network ? { network: o.network } : {}),
      ...(o.wifiOnly ? { wifiOnly: o.wifiOnly } : {}),
      ...(o.mode ? { mode: o.mode() } : {}),
      ...(o.onPairing ? { onPairing: o.onPairing } : {}),
      ...(o.onConfigApplied ? { onConfigApplied: o.onConfigApplied } : {}),
    });
  }

  /** Retries the settings every 30 s; the engine starts once they arrive. */
  private async waitForSettings(engine: Engine): Promise<void> {
    while (this.current === engine) {
      await this.o.clock.sleep(30_000);
      if (this.current !== engine || !this.io || !this.o.loadSettings) return;
      try {
        engine.setSettings(await this.o.loadSettings(this.io.api, this.io.fs));
        engine.resume();
        return;
      } catch {
        this.o.log?.("settings_unavailable");
      }
    }
  }

  /** Reads the effective settings again and hands them to the engine. */
  reloadSettings(): Promise<void> {
    this.chain = this.chain
      .then(async () => {
        if (!this.current || !this.io || !this.o.loadSettings) return;
        this.current.setSettings(await this.o.loadSettings(this.io.api, this.io.fs));
      })
      .catch(() => this.o.log?.("settings_load_failed"));
    return this.chain;
  }

  async stop(): Promise<void> {
    this.disposed = true;
    this.off?.();
    await this.current?.stop();
    this.current = null;
    this.key = null;
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
