import { createDiffView, type DiffViewHandle } from "@kamino/ui-diff";
import type { Lang } from "@kamino/status";
import { Modal, type App } from "obsidian";
import { t } from "../i18n/index.js";
import { h } from "../ui/dom.js";

// Sample note contents (test data, not UI text).
const MINE =
  "# Shopping list\n\n- milk\n- bread\n- eggs (a dozen)\n\nThis line only exists locally.\n";
const INCOMING =
  "# Shopping list\n\n- milk\n- wholegrain bread\n- eggs\n\nThis line was added on the desktop.\n";

/** Dev-only (R-3 check): a diff in all layout/edit combinations. */
export class DiffTestModal extends Modal {
  private handle: DiffViewHandle | null = null;

  constructor(
    app: App,
    private readonly lang: Lang,
  ) {
    super(app);
  }

  override onOpen(): void {
    const m = t(this.lang).dev;
    this.titleEl.textContent = m.diffTest;
    const bar = h(this.contentEl, "div");
    const host = h(this.contentEl, "div");
    let layout: "split" | "unified" = "split";
    let editable = false;
    const show = () => {
      this.handle?.destroy();
      this.handle = null;
      try {
        this.handle = createDiffView(host, {
          mine: MINE,
          incoming: INCOMING,
          layout,
          editable,
          labels: { mine: m.diffMine, incoming: m.diffIncoming },
        });
      } catch (err) {
        console.error(err);
        host.textContent = String(err);
      }
    };
    h(bar, "button", { text: m.diffSplit }).addEventListener("click", () => {
      layout = "split";
      show();
    });
    h(bar, "button", { text: m.diffUnified }).addEventListener("click", () => {
      layout = "unified";
      show();
    });
    h(bar, "button", { text: m.diffEditable }).addEventListener("click", () => {
      editable = !editable;
      show();
    });
    show();
  }

  override onClose(): void {
    this.handle?.destroy();
    this.handle = null;
    this.contentEl.replaceChildren();
  }
}
