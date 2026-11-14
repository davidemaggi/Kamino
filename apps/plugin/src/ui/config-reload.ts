import { Notice } from "obsidian";

/**
 * S-12: another device changed the configuration folder, and Obsidian reads it only at startup.
 * One lasting notice with a reload button; not repeated until the user reloads (a new session).
 */
export class ConfigReloadPrompt {
  private shown = false;

  constructor(
    private readonly texts: { text: string; button: string },
    private readonly reload: () => void,
  ) {}

  configApplied(): void {
    if (this.shown) return;
    this.shown = true;
    const notice = new Notice(this.texts.text, 0);
    const button = document.createElement("button");
    button.textContent = this.texts.button;
    notice.messageEl.append(button);
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      notice.hide();
      this.reload();
    });
  }
}
