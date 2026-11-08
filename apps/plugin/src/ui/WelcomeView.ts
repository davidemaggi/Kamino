import { PRODUCT_NAME, PROTOCOL_ACTION } from "@kamino/brand";
import { ItemView, type WorkspaceLeaf } from "obsidian";
import { parsePairingUrl } from "../connection/link.js";
import { fmt } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import type { UiContext } from "./context.js";
import { h } from "./dom.js";
import { CLASS_PREFIX } from "./status-classes.js";
import { WELCOME_VIEW } from "./workspace.js";

const P = `${CLASS_PREFIX}-welcome`;

/** First run in a vault that is not linked: three ways in (spec §3.1). */
export class WelcomeView extends ItemView {
  private showLinkHelp = false;
  private linkError = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly ctx: UiContext,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return WELCOME_VIEW;
  }
  override getDisplayText(): string {
    return t(this.ctx.lang).welcome.viewTitle;
  }
  override getIcon(): string {
    return "link";
  }

  protected override onOpen(): Promise<void> {
    this.unsubscribe = this.ctx.connection.onChange((e) => {
      if (e.type === "linked") this.leaf.detach();
    });
    this.render();
    return Promise.resolve();
  }

  protected override onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    return Promise.resolve();
  }

  private render(): void {
    const m = t(this.ctx.lang).welcome;
    const root = this.contentEl;
    root.replaceChildren();
    root.classList.add(P);
    h(root, "h2", { text: fmt(m.title, { product: PRODUCT_NAME }) });
    h(root, "p", { cls: `${P}__muted`, text: m.intro });

    const choice = (title: string, desc: string, onClick: () => void) => {
      const b = h(root, "button", { cls: `${P}__choice` });
      h(b, "b", { text: title });
      h(b, "span", { cls: `${P}__muted`, text: desc });
      b.addEventListener("click", onClick);
    };
    choice(m.createTitle, m.createDesc, () => this.ctx.openConnect("create"));
    choice(m.joinTitle, m.joinDesc, () => this.ctx.openConnect("join"));
    choice(m.linkTitle, m.linkDesc, () => {
      this.showLinkHelp = true;
      this.render();
    });

    if (!this.showLinkHelp) return;
    const help = h(root, "section", { cls: `${P}__help` });
    if (this.ctx.isMobile) {
      h(help, "p", { text: m.linkHowMobile });
      return;
    }
    h(help, "p", { text: m.linkHowDesktop });
    const input = h(help, "input", {
      attrs: { type: "text", "aria-label": m.linkPaste, placeholder: m.linkPaste },
    });
    h(help, "button", { cls: "mod-cta", text: m.linkGo }).addEventListener("click", () => {
      const parsed = parsePairingUrl(input.value, PROTOCOL_ACTION);
      if (!parsed.ok) {
        this.linkError = true;
        error.textContent = m.linkInvalid;
        return;
      }
      this.linkError = false;
      error.textContent = "";
      this.ctx.openClaim(parsed.link);
    });
    const error = h(help, "p", {
      cls: `${P}__error`,
      attrs: { role: "alert" },
      text: this.linkError ? m.linkInvalid : "",
    });
  }
}
