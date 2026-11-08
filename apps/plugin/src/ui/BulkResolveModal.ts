import { Modal, Notice, type App } from "obsidian";
import { fmt } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import type { BulkStrategy } from "../state/types.js";
import type { UiContext } from "./context.js";
import { h } from "./dom.js";

/** "Resolve all…": explicit choice and confirmation (spec §5.4). */
export class BulkResolveModal extends Modal {
  private choice: BulkStrategy | null = null;

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

    const apply = root.ownerDocument.createElement("button");
    apply.className = "mod-cta";
    apply.textContent = m.apply;
    apply.disabled = true;
    apply.addEventListener("click", () => void this.apply());

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
        apply.disabled = false;
      });
    }

    h(root, "p", { text: fmt(m.appliesTo, { count: this.ctx.source.conflicts().length }) });
    const bar = h(root, "div", { cls: "modal-button-container" });
    bar.append(apply);
    h(bar, "button", { text: m.cancel }).addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.replaceChildren();
  }

  private async apply(): Promise<void> {
    if (!this.choice) return;
    const { resolved } = await this.ctx.actions.resolveAll(this.choice);
    new Notice(fmt(t(this.ctx.lang).bulk.done, { count: resolved }));
    this.close();
  }
}
