import { Modal, Notice, type App } from "obsidian";
import { h } from "./dom.js";
import { t, type Lang } from "../i18n/index.js";

export interface ForceSyncDeps {
  /** The other devices of this vault that can receive it. */
  devices(): Promise<{ id: string; name: string }[]>;
  request(targetIds: string[]): Promise<void>;
}

/**
 * ADR-0019: this device's files overwrite the same files on the chosen devices; their different
 * copies stay in the history, their extra files stay where they are.
 */
export class ForceSyncModal extends Modal {
  private readonly chosen = new Set<string>();

  constructor(
    app: App,
    private readonly lang: Lang,
    private readonly deps: ForceSyncDeps,
  ) {
    super(app);
  }

  override onOpen(): void {
    const m = t(this.lang).forceSync;
    this.titleEl.textContent = m.title;
    h(this.contentEl, "p", { text: m.text });
    const list = h(this.contentEl, "div", { cls: "kamino-force-sync__list" });
    h(list, "p", { text: m.loading });
    const bar = h(this.contentEl, "div", { cls: "modal-button-container" });
    h(bar, "button", { text: m.cancel }).addEventListener("click", () => this.close());
    const go = h(bar, "button", { cls: "mod-cta", text: m.confirm });
    go.disabled = true;
    go.addEventListener("click", () => void this.send(go));
    void this.deps.devices().then(
      (devices) => {
        list.replaceChildren();
        if (devices.length === 0) h(list, "p", { text: m.none });
        for (const d of devices) {
          const label = h(list, "label", { cls: "kamino-force-sync__device" });
          const box = h(label, "input", { attrs: { type: "checkbox" } });
          box.addEventListener("change", () => {
            if (box.checked) this.chosen.add(d.id);
            else this.chosen.delete(d.id);
            go.disabled = this.chosen.size === 0;
          });
          label.append(` ${d.name}`);
        }
      },
      () => {
        list.replaceChildren();
        h(list, "p", { text: m.failed });
      },
    );
  }

  override onClose(): void {
    this.contentEl.replaceChildren();
  }

  private async send(go: HTMLButtonElement): Promise<void> {
    const m = t(this.lang).forceSync;
    go.disabled = true;
    try {
      await this.deps.request([...this.chosen]);
      new Notice(m.sent);
      this.close();
    } catch {
      new Notice(m.failed);
      go.disabled = false;
    }
  }
}
