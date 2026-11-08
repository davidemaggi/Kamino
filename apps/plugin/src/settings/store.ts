import type { LinkStore } from "../connection/fake-server.js";
import type { LinkInfo } from "../connection/types.js";
import { defaultSettings, normalizeSettings, type PluginSettings } from "./model.js";

export interface DataIO {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

function isLink(v: unknown): v is LinkInfo {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return ["server", "host", "user", "vaultId", "vaultName", "deviceName"].every(
    (k) => typeof o[k] === "string",
  );
}

/** Plugin settings and link data in data.json (plugin folder, always excluded from sync). */
export class SettingsStore {
  private settings: PluginSettings;
  private link: LinkInfo | null = null;
  private readonly listeners = new Set<() => void>();
  readonly linkStore: LinkStore;

  constructor(
    private readonly io: DataIO,
    private readonly isMobile: boolean,
  ) {
    this.settings = defaultSettings(isMobile);
    this.linkStore = {
      load: () => this.link,
      save: (link) => {
        this.link = link;
        void this.persist();
      },
    };
  }

  async load(): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.io.loadData();
    } catch {
      raw = null; // unreadable data.json: start from the defaults
    }
    const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    this.settings = normalizeSettings(r["settings"], this.isMobile);
    this.link = isLink(r["link"]) ? r["link"] : null;
  }

  get(): PluginSettings {
    return structuredClone(this.settings);
  }

  async update(fn: (s: PluginSettings) => PluginSettings): Promise<void> {
    this.settings = normalizeSettings(fn(this.get()), this.isMobile);
    for (const cb of [...this.listeners]) cb();
    await this.persist();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private persist(): Promise<void> {
    return this.io.saveData({ settings: this.settings, link: this.link });
  }
}
