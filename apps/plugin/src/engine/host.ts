import { DEFAULT_SYNC_SETTINGS, type SyncSettings } from "@kamino/protocol";
import { Engine, type Clock, type EngineDeps, type Http, type VaultFs } from "@kamino/sync-engine";

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
      const engine = await Engine.open({
        fs: this.o.fs(link.deviceId),
        http: this.o.http(link.server),
        clock: this.o.clock,
        newId: this.o.newId,
        vaultId: link.vaultId,
        token: () => token,
        config: {
          deviceId: link.deviceId,
          platform: this.o.platform,
          configDir: this.o.configDir,
          settings: this.o.settings?.() ?? DEFAULT_SYNC_SETTINGS,
          batchSize: 200,
        },
        ...(this.o.log ? { log: this.o.log } : {}),
      });
      this.current = engine;
      this.off = engine.onChange(() => this.emit());
      engine.start();
    }
    this.emit();
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
