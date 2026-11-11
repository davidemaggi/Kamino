import { Modal, type App } from "obsidian";
import { h } from "./dom.js";
import { t, type Lang } from "../i18n/index.js";

/**
 * S-08 on iOS (the network type can't be read): may large files use this network now?
 * Resolves { ok: false } on close.
 */
export class MeteredModal extends Modal {
  private answered = false;
  private dontAsk = false;

  constructor(
    app: App,
    private readonly lang: Lang,
    private readonly resolve: (r: { ok: boolean; dontAsk: boolean }) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const m = t(this.lang).metered;
    this.titleEl.textContent = m.title;
    h(this.contentEl, "p", { text: m.text });
    const label = h(this.contentEl, "label", { cls: "kamino-metered__dont-ask" });
    const box = h(label, "input", { attrs: { type: "checkbox" } });
    box.addEventListener("change", () => (this.dontAsk = box.checked));
    label.append(` ${m.dontAsk}`);
    const bar = h(this.contentEl, "div", { cls: "modal-button-container" });
    h(bar, "button", { text: m.wait }).addEventListener("click", () => this.answer(false));
    h(bar, "button", { cls: "mod-cta", text: m.proceed }).addEventListener("click", () =>
      this.answer(true),
    );
  }

  override onClose(): void {
    if (!this.answered) this.resolve({ ok: false, dontAsk: false });
    this.contentEl.replaceChildren();
  }

  private answer(ok: boolean): void {
    this.answered = true;
    this.resolve({ ok, dontAsk: ok && this.dontAsk });
    this.close();
  }
}

export function askMetered(app: App, lang: Lang): Promise<{ ok: boolean; dontAsk: boolean }> {
  return new Promise((resolve) => new MeteredModal(app, lang, resolve).open());
}
