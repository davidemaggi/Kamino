import { ItemView, type WorkspaceLeaf } from "obsidian";
import { BRAND_ICON } from "./brand-icon.js";
import { t } from "../i18n/index.js";
import type { UiContext } from "./context.js";
import { renderWelcome } from "./welcome-content.js";
import { WELCOME_VIEW } from "./workspace.js";

/** First run in a vault that is not linked: three ways in (spec §3.1). */
export class WelcomeView extends ItemView {
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
    return BRAND_ICON;
  }

  protected override onOpen(): Promise<void> {
    this.unsubscribe = this.ctx.connection.onChange((e) => {
      if (e.type === "linked") this.leaf.detach();
    });
    // The tab stays open behind the connect window: closing it is the user's call.
    renderWelcome(this.contentEl, this.ctx, () => {});
    return Promise.resolve();
  }

  protected override onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    return Promise.resolve();
  }
}
