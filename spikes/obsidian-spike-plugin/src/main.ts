// Throwaway spike plugin for M0 risks R-1..R-5 (docs/spikes/). One command per
// measurement; results go to notes under "Kamino spike results/".
// Only Obsidian API, requestUrl, fetch on resource URLs, WebSocket, WebCrypto
// and @noble/hashes: no Node/Electron APIs (isDesktopOnly: false).
import { Notice, Plugin } from "obsidian";
import {
  cleanupLarge,
  fullMemoryPipeline,
  generateFile,
  probeAdapter,
  streamingPipeline,
} from "./r1-large-files.ts";
import { recordNetwork, watchNetwork } from "./r2-network.ts";
import { openMergeSpike } from "./r3-merge.ts";
import { WsSpike } from "./r4-websocket.ts";
import { cleanupMass, EventCounter, generateVault, moveViaApi } from "./r5-mass-events.ts";
import { errorText } from "./report.ts";
import { DEFAULT_SETTINGS, SpikeSettingTab, type SpikeSettings } from "./settings.ts";

export default class SpikePlugin extends Plugin {
  override settings: SpikeSettings = { ...DEFAULT_SETTINGS };
  #ws: WsSpike | null = null;
  #counter: EventCounter | null = null;

  override async onload(): Promise<void> {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...((await this.loadData()) as Partial<SpikeSettings> | null),
    };
    this.addSettingTab(new SpikeSettingTab(this.app, this));
    const ctx = () => ({
      app: this.app,
      serverUrl: this.settings.serverUrl,
      device: this.settings.deviceLabel,
    });
    const device = () => this.settings.deviceLabel;

    this.cmd("r1-probe", "R-1: probe adapter APIs (append/appendBinary/range read)", () =>
      probeAdapter(ctx()),
    );
    this.cmd("r1-generate", "R-1: generate a test file (50/200/500 MB)", () => generateFile(ctx()));
    this.cmd("r1-full", "R-1: full-memory pipeline (readBinary, hash, upload, writeBinary)", () =>
      fullMemoryPipeline(ctx()),
    );
    this.cmd(
      "r1-stream",
      "R-1: streaming pipeline (resource URL, hash, upload, appendBinary)",
      () => streamingPipeline(ctx()),
    );
    this.cmd("r1-cleanup", "R-1: delete the large test files", async () => {
      await cleanupLarge(this.app);
      new Notice("R-1 test files deleted");
    });

    this.cmd("r2-wifi", "R-2: record network info (on Wi-Fi)", () =>
      recordNetwork(this.app, device(), "Wi-Fi"),
    );
    this.cmd("r2-cell", "R-2: record network info (on cellular)", () =>
      recordNetwork(this.app, device(), "cellular"),
    );
    this.cmd("r2-watch", "R-2: watch network changes for 2 minutes", () =>
      watchNetwork(this.app, device()),
    );

    this.cmd("r3-merge", "R-3: open merge view modal", () => openMergeSpike(this.app, device()));

    this.#ws = new WsSpike(this.app, () => this.settings.serverUrl, device);
    this.cmd("r4-start", "R-4: start WebSocket test", () => this.#ws!.start());
    this.cmd("r4-stop", "R-4: stop WebSocket test and write summary", () => this.#ws!.stop());

    this.#counter = new EventCounter(this.app);
    this.cmd("r5-generate", "R-5: generate synthetic vault subtree", () =>
      generateVault(this.app, device(), this.settings.massFileCount, this.settings.massMoveCount),
    );
    this.cmd("r5-count-start", "R-5: start counting vault events (resets counters)", async () =>
      this.#counter!.start(),
    );
    this.cmd("r5-move-api", "R-5: move the folder via API (alternative to drag and drop)", () =>
      moveViaApi(this.app),
    );
    this.cmd("r5-dump", "R-5: write event counters (keep counting)", () =>
      this.#counter!.dump(device(), false),
    );
    this.cmd("r5-stop", "R-5: write event counters and stop counting", () =>
      this.#counter!.dump(device(), true),
    );
    this.cmd("r5-cleanup", "R-5: delete the synthetic subtree", () =>
      cleanupMass(this.app, device()),
    );
  }

  override onunload(): void {
    void this.#ws?.stop();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private cmd(id: string, name: string, run: () => Promise<void>): void {
    this.addCommand({
      id,
      name,
      callback: () => {
        run().catch((err: unknown) => {
          console.error("[kamino-spike]", err);
          new Notice(`Spike command failed: ${errorText(err)}`, 10000);
        });
      },
    });
  }
}
