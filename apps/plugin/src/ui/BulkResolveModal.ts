import { Modal, Notice, type App } from "obsidian";
import { fmt } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import type { BulkStrategy } from "../state/types.js";
import type { UiContext } from "./context.js";
import { h } from "./dom.js";

/** "Resolve all…": explicit choice and confirmation (spec §5.4). */
export class BulkResolveModal extends Modal {
  private choice: BulkStrategy | null = null;
  /** The conflicts shown when the modal opened: only these are resolved. */
  private ids: string[] = [];
  private busy = false;
  private applyButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly ctx: UiContext,
  ) {
    super(app);
  }

  override onOpen(): void {
    const m = t(this.ctx.lang).bulk;
    this.titleEl.textContent = m.title;
    const root = this.contentEl;
    root.replaceChildren();
    this.ids = this.ctx.source.conflicts().map((c) => c.id);

    const apply = root.ownerDocument.createElement("button");
    apply.className = "mod-cta";
    apply.textContent = m.apply;
    apply.disabled = true;
    apply.addEventListener("click", () => void this.apply());
    this.applyButton = apply;

    const group = h(root, "div", { attrs: { role: "radiogroup", "aria-label": m.title } });
    for (const [value, label] of [
      ["keep_mine", m.keepMine],
      ["keep_incoming", m.keepIncoming],
      ["keep_both", m.keepBoth],
    ] as const) {
      const row = h(group, "label");
      const input = h(row, "input", { attrs: { type: "radio", name: "bulk-strategy", value } });
      row.append(` ${label}`);
      input.addEventListener("change", () => {
        if (!input.checked) return;
        this.choice = value;
        apply.disabled = this.busy;
      });
    }

    h(root, "p", { text: fmt(m.appliesTo, { count: this.ids.length }) });
    const bar = h(root, "div", { cls: "modal-button-container" });
    bar.append(apply);
    h(bar, "button", { text: m.cancel }).addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.applyButton = null;
    this.contentEl.replaceChildren();
  }

  private async apply(): Promise<void> {
    if (!this.choice || this.busy) return;
    const m = t(this.ctx.lang).bulk;
    this.setBusy(true);
    try {
      const { resolved } = await this.ctx.actions.resolveAll(this.choice, this.ids);
      new Notice(fmt(m.done, { count: resolved }));
      this.close();
    } catch {
      // Nothing confirmed: say so and leave the modal open to retry.
      new Notice(m.failed);
    } finally {
      this.setBusy(false);
    }
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    if (this.applyButton) this.applyButton.disabled = busy || this.choice === null;
  }
}
