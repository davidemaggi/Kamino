import { Modal, type App } from "obsidian";
import type { UiContext } from "./context.js";
import { renderWelcome } from "./welcome-content.js";

/**
 * The welcome choices as a window, for the "Link…" buttons in settings and in the status panel:
 * a tab would open behind the settings window (and behind the drawer on mobile).
 */
export class WelcomeModal extends Modal {
  private unsubscribe: (() => void) | null = null;

  constructor(
    app: App,
    private readonly ctx: UiContext,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.unsubscribe = this.ctx.connection.onChange((e) => {
      if (e.type === "linked") this.close();
    });
    renderWelcome(this.contentEl, this.ctx, () => this.close());
  }

  override onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.contentEl.replaceChildren();
  }
}
