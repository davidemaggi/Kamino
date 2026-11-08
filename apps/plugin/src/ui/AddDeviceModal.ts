import { Modal, Notice, type App } from "obsidian";
import { qrDataUrl } from "../connection/qr.js";
import type { PairingRequest } from "../connection/types.js";
import { fmt, formatWhen } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import type { UiContext } from "./context.js";
import { h } from "./dom.js";
import { CLASS_PREFIX } from "./status-classes.js";

const P = `${CLASS_PREFIX}-pairing`;
type Step = "offer" | "expired" | "request" | "done";

/** Origin side of pairing: QR/link, then approval of the request (spec §3.6). */
export class AddDeviceModal extends Modal {
  private static readonly showing = new Set<string>();
  /** True while an open window is showing this pairing: the global notice is then not needed. */
  static isShowing(pairingId: string): boolean {
    return AddDeviceModal.showing.has(pairingId);
  }

  private step: Step = "offer";
  private pairingId = "";
  private link = "";
  private expiresAt = 0;
  private request: PairingRequest | null;
  private doneText = "";
  private timer: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private busy = false;
  /** Set on close: a late startPairing() must not register anything. */
  private closed = false;

  constructor(
    app: App,
    private readonly ctx: UiContext,
    request?: PairingRequest,
  ) {
    super(app);
    this.request = request ?? null;
  }

  override onOpen(): void {
    this.unsubscribe = this.ctx.connection.onChange((e) => {
      if (e.type === "pairing_request" && e.request.pairingId === this.pairingId) {
        this.request = e.request;
        this.step = "request";
        this.render();
      }
      if (
        e.type === "pairing_closed" &&
        e.pairingId === this.pairingId &&
        this.step === "request" &&
        !this.busy
      ) {
        this.doneText = t(this.ctx.lang).pairing.expired;
        this.step = "done";
        this.render();
      }
    });
    this.timer = window.setInterval(() => this.tick(), 1000);
    if (this.request) {
      this.setPairing(this.request.pairingId, this.request.expiresAt);
      this.step = "request";
      if (!this.stillPending()) this.showGone();
      else this.render();
    } else {
      void this.offer();
    }
  }

  override onClose(): void {
    this.closed = true;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    AddDeviceModal.showing.delete(this.pairingId);
    if (this.step === "offer" && this.pairingId)
      void this.ctx.connection.cancelPairing(this.pairingId);
    this.contentEl.replaceChildren();
  }

  private setPairing(id: string, expiresAt: number): void {
    AddDeviceModal.showing.delete(this.pairingId);
    this.pairingId = id;
    this.expiresAt = expiresAt;
    AddDeviceModal.showing.add(id);
  }

  private async offer(): Promise<void> {
    const offer = await this.ctx.connection.startPairing();
    if (this.closed) {
      // Closed while the offer was being created: withdraw it, register nothing.
      void this.ctx.connection.cancelPairing(offer.pairingId);
      return;
    }
    this.setPairing(offer.pairingId, offer.expiresAt);
    this.link = offer.link;
    this.step = "offer";
    this.render();
  }

  private stillPending(): boolean {
    return this.ctx.connection.pairingRequests().some((r) => r.pairingId === this.pairingId);
  }

  private showGone(): void {
    this.doneText = t(this.ctx.lang).pairing.requestGone;
    this.step = "done";
    this.render();
  }

  private tick(): void {
    if (this.step === "request" && !this.busy && !this.stillPending()) {
      this.showGone();
      return;
    }
    if (this.step === "offer" && this.ctx.now() >= this.expiresAt) {
      this.step = "expired";
      this.render();
    } else if (this.step === "offer") {
      const el = this.contentEl.querySelector(`.${P}__validity`);
      if (el) el.textContent = fmt(t(this.ctx.lang).pairing.validFor, { left: this.left() });
    }
  }

  private left(): string {
    const s = Math.ceil(Math.max(0, this.expiresAt - this.ctx.now()) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  private render(): void {
    const m = t(this.ctx.lang).pairing;
    const root = this.contentEl;
    root.replaceChildren();
    root.classList.add(P);
    const bar = () => h(root, "div", { cls: "modal-button-container" });
    const button = (parent: HTMLElement, text: string, onClick: () => void, cls = "") => {
      const b = h(parent, "button", { text, ...(cls ? { cls } : {}) });
      b.disabled = this.busy;
      b.addEventListener("click", onClick);
    };

    if (this.step === "offer") {
      this.titleEl.textContent = m.addTitle;
      h(root, "p", { text: m.addIntro });
      h(root, "img", {
        cls: `${P}__qr`,
        attrs: { src: qrDataUrl(this.link), alt: m.qrAlt, width: "220", height: "220" },
      });
      const input = h(root, "input", {
        attrs: { type: "text", readonly: "", "aria-label": m.copy },
      });
      input.value = this.link;
      h(root, "p", {
        cls: `${P}__validity ${P}__muted`,
        text: fmt(m.validFor, { left: this.left() }),
      });
      button(bar(), m.copy, () => void this.copy(input));
    } else if (this.step === "expired") {
      this.titleEl.textContent = m.addTitle;
      h(root, "p", { text: m.codeExpired });
      button(bar(), m.regenerate, () => void this.offer(), "mod-cta");
    } else if (this.step === "request" && this.request) {
      const r = this.request;
      this.titleEl.textContent = fmt(m.requestTitle, { name: r.deviceName });
      h(root, "h2", { text: fmt(m.requestTitle, { name: r.deviceName }) });
      h(root, "p", {
        cls: `${P}__muted`,
        text: fmt(m.requestMeta, {
          platform: r.platform,
          version: r.pluginVersion,
          time: formatWhen(r.at, this.ctx.now(), this.ctx.lang),
        }),
      });
      h(root, "div", {
        cls: `${P}__code`,
        text: r.code,
        attrs: { "aria-label": r.code.split("").join(" ") },
      });
      h(root, "p", { text: m.requestHint });
      const b = bar();
      button(b, m.approve, () => void this.answer(true), "mod-cta");
      button(b, m.deny, () => void this.answer(false));
    } else {
      h(root, "p", { attrs: { role: "status" }, text: this.doneText });
      button(bar(), m.close, () => this.close());
    }
  }

  private async copy(input: HTMLInputElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.link);
      new Notice(t(this.ctx.lang).pairing.copied);
    } catch {
      input.select();
    }
  }

  private async answer(approve: boolean): Promise<void> {
    if (this.busy) return;
    const m = t(this.ctx.lang).pairing;
    this.busy = true;
    this.render();
    try {
      if (approve) await this.ctx.connection.approve(this.pairingId);
      else await this.ctx.connection.deny(this.pairingId);
      this.doneText = approve ? m.approved : m.rejected;
    } catch {
      // Not confirmed by the server: never report success.
      this.doneText = this.stillPending() ? m.answerFailed : m.requestGone;
    } finally {
      this.step = "done";
      this.busy = false;
      this.render();
    }
  }
}
