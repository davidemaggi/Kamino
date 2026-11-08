import { ItemView, type WorkspaceLeaf } from "obsidian";
import { fmt, formatSize } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import type { UiContext } from "./context.js";
import { h } from "./dom.js";
import { CLASS_PREFIX } from "./status-classes.js";
import { TRANSFER_VIEW } from "./workspace.js";

const P = `${CLASS_PREFIX}-transfer`;

/** Initial upload/download progress (spec §3.5). */
export class TransferView extends ItemView {
  private unsubscribe: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly ctx: UiContext,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return TRANSFER_VIEW;
  }
  override getDisplayText(): string {
    return t(this.ctx.lang).transfer.viewTitle;
  }
  override getIcon(): string {
    return "refresh-cw";
  }

  protected override onOpen(): Promise<void> {
    this.unsubscribe = this.ctx.transfer.onChange(() => this.render());
    this.render();
    return Promise.resolve();
  }

  protected override onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    return Promise.resolve();
  }

  private render(): void {
    const m = t(this.ctx.lang).transfer;
    const lang = this.ctx.lang;
    const root = this.contentEl;
    root.replaceChildren();
    root.classList.add(P);
    const p = this.ctx.transfer.progress();
    if (!p) {
      h(root, "p", { text: m.none });
      return;
    }
    h(root, "h2", { text: p.direction === "upload" ? m.upload : m.download });
    const bar = h(root, "progress", { attrs: { max: String(Math.max(1, p.files.total)) } });
    bar.value = p.files.done;
    h(root, "p", {
      attrs: { "aria-live": "polite" },
      text: fmt(m.progress, {
        files: p.files.done,
        total: p.files.total,
        bytes: formatSize(p.bytes.done, lang),
        bytesTotal: formatSize(p.bytes.total, lang),
      }),
    });

    const actions = h(root, "div", { cls: `${P}__actions` });
    const button = (text: string, onClick: () => void, cta = false) =>
      h(actions, "button", { text, ...(cta ? { cls: "mod-cta" } : {}) }).addEventListener(
        "click",
        onClick,
      );

    switch (p.phase) {
      case "running":
        h(root, "p", { cls: `${P}__muted`, text: m.keepWorking });
        button(m.pause, () => this.ctx.transfer.pause());
        break;
      case "paused":
        h(root, "p", { text: m.paused });
        button(m.resume, () => this.ctx.transfer.resume(), true);
        break;
      case "interrupted":
        h(root, "p", { attrs: { role: "status" }, text: m.interrupted });
        break;
      case "failed":
        h(root, "p", { attrs: { role: "alert" }, text: m.failed });
        button(m.retry, () => this.ctx.transfer.retry(), true);
        break;
      case "done":
        h(root, "p", { text: fmt(m.done, { count: p.files.total }) });
        button(m.openStatus, () => void this.ctx.openStatusPanel(), true);
        break;
    }
    root.append(actions);
  }
}
