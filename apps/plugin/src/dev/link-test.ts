import { PROTOCOL_ACTION } from "@kamino/brand";
import type { Lang } from "@kamino/status";
import { Modal, type App } from "obsidian";
import { buildPairingLink } from "../connection/link.js";
import { qrDataUrl } from "../connection/qr.js";
import { fmt } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import { h } from "../ui/dom.js";

/** Dev-only: shows a QR for a sample link, to check camera recognition and the protocol handler. */
export class LinkTestModal extends Modal {
  constructor(
    app: App,
    private readonly lang: Lang,
  ) {
    super(app);
  }

  override onOpen(): void {
    const m = t(this.lang).dev;
    const link = buildPairingLink(PROTOCOL_ACTION, {
      server: "https://sync.example",
      token: "test-token",
    });
    this.titleEl.textContent = m.linkTest;
    h(this.contentEl, "img", {
      attrs: { src: qrDataUrl(link), alt: m.linkTest, width: "220", height: "220" },
    });
    h(this.contentEl, "p", { text: fmt(m.linkTestHint, { command: `open "${link}"` }) });
  }

  override onClose(): void {
    this.contentEl.replaceChildren();
  }
}
