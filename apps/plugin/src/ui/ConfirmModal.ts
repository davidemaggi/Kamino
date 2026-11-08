import { Modal, type App } from "obsidian";
import type { ConfirmOptions } from "./context.js";
import { h } from "./dom.js";

/** Confirmation (or information, with confirmText null). Resolves false on cancel or close. */
export class ConfirmModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly opts: ConfirmOptions,
    private readonly resolve: (ok: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.textContent = this.opts.title;
    h(this.contentEl, "p", { text: this.opts.text });
    const bar = h(this.contentEl, "div", { cls: "modal-button-container" });
    h(bar, "button", { text: this.opts.cancelText }).addEventListener("click", () =>
      this.answer(false),
    );
    if (this.opts.confirmText !== null) {
      h(bar, "button", {
        cls: this.opts.warning ? "mod-warning" : "mod-cta",
        text: this.opts.confirmText,
      }).addEventListener("click", () => this.answer(true));
    }
  }

  override onClose(): void {
    if (!this.answered) this.resolve(false);
    this.contentEl.replaceChildren();
  }

  private answer(ok: boolean): void {
    this.answered = true;
    this.resolve(ok);
    this.close();
  }
}

export function confirmDialog(app: App, opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => new ConfirmModal(app, opts, resolve).open());
}
