import { DEFAULT_SYNC_SETTINGS, type SyncSettings } from "@kamino/protocol";
import {
  Api,
  Engine,
  type Clock,
  type EngineDeps,
  type Http,
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
}

/** One engine per link: opened when the device is linked, stopped when it is unlinked. */
export class EngineHost {
  private current: Engine | null = null;
  private key: string | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private off: (() => void) | null = null;
  private io: { api: Api; fs: VaultFs } | null = null;

  constructor(private readonly o: EngineHostOptions) {}

  engine(): Engine | null {
    return this.current;
  }

  /** Follows the link: call at startup and whenever it changes. */
  refresh(): Promise<void> {
    this.chain = this.chain
      .then(() => this.apply())
      .catch(() => this.o.log?.("engine_open_failed"));
    return this.chain;
  }

  private async apply(): Promise<void> {
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
      const engine = await Engine.open({
        fs,
        http,
        onSettingsChanged: () => void this.reloadSettings(),
        clock: this.o.clock,
        newId: this.o.newId,
        vaultId: link.vaultId,
        token: () => token,
        config: {
          deviceId: link.deviceId,
          platform: this.o.platform,
          configDir: this.o.configDir,
          settings,
          batchSize: 200,
        },
        ...(this.o.log ? { log: this.o.log } : {}),
      });
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
