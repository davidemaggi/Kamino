import { Modal, type App } from "obsidian";
import type { PairingLink } from "../connection/link.js";
import { fmt } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import type { UiContext } from "./context.js";
import { h } from "./dom.js";
import { CLASS_PREFIX } from "./status-classes.js";

const P = `${CLASS_PREFIX}-pairing`;
type Step = "name" | "code" | "reconcile" | "result";

/** New device side of pairing: name → code → approval → (reconcile) → download (spec §3.4). */
export class PairingClaimModal extends Modal {
  private step: Step = "name";
  private deviceName: string;
  private host: string;
  private code = "";
  private claimId: string | null = null;
  private expiresAt = 0;
  private result = "";
  private timer: number | null = null;
  private ticks = 0;
  private busy = false;
  /** Set on close: late answers must not render, poll or link anything. */
  private closed = false;

  constructor(
    app: App,
    private readonly ctx: UiContext,
    private readonly link: PairingLink,
  ) {
    super(app);
    this.deviceName = ctx.platformLabel;
    this.host = new URL(link.server).host;
  }

  override onOpen(): void {
    this.render();
  }

  override onClose(): void {
    this.closed = true;
    this.stopTimer();
    if (this.step === "code" && this.claimId) void this.ctx.connection.cancelClaim(this.claimId);
    // Approved but reconciliation not confirmed: closing means cancelling, so leave the vault unlinked.
    if (this.step === "reconcile") void this.ctx.connection.unlink();
    this.contentEl.replaceChildren();
  }

  private get m() {
    return t(this.ctx.lang).pairing;
  }

  private render(): void {
    const m = this.m;
    this.titleEl.textContent = "";
    const root = this.contentEl;
    root.replaceChildren();
    root.classList.add(P);
    h(root, "h2", { text: fmt(m.claimTitle, { host: this.host }) });
    const bar = () => h(root, "div", { cls: "modal-button-container" });
    const button = (parent: HTMLElement, text: string, onClick: () => void, cta = false) => {
      const b = h(parent, "button", { text, ...(cta ? { cls: "mod-cta" } : {}) });
      b.disabled = this.busy;
      b.addEventListener("click", onClick);
    };

    if (this.step === "name") {
      const label = h(root, "label", { cls: `${P}__field` });
      h(label, "span", { text: m.deviceName });
      const input = h(label, "input", { attrs: { type: "text", "aria-label": m.deviceName } });
      input.value = this.deviceName;
      input.addEventListener("input", () => (this.deviceName = input.value));
      const b = bar();
      button(b, m.cancel, () => this.close());
      button(b, m.start, () => void this.claim(), true);
    } else if (this.step === "code") {
      h(root, "p", { text: m.codeIntro });
      h(root, "div", {
        cls: `${P}__code`,
        text: this.code,
        attrs: { "aria-label": this.code.split("").join(" ") },
      });
      h(root, "p", {
        cls: `${P}__muted ${P}__waiting`,
        attrs: { "aria-live": "polite" },
        text: fmt(m.waiting, { left: this.left() }),
      });
      button(bar(), m.cancel, () => this.close());
    } else if (this.step === "reconcile") {
      h(root, "p", {
        text: fmt(t(this.ctx.lang).connect.reconcile, { count: this.ctx.localFileCount() }),
      });
      const b = bar();
      button(b, m.cancel, () => void this.abortAfterApproval());
      button(b, t(this.ctx.lang).connect.continue, () => this.startDownload(), true);
    } else {
      h(root, "p", { attrs: { role: "alert" }, text: this.result });
      button(bar(), m.close, () => this.close());
    }
  }

  private left(): string {
    const ms = Math.max(0, this.expiresAt - this.ctx.now());
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  private async claim(): Promise<void> {
    if (this.busy || !this.deviceName.trim()) return;
    this.busy = true;
    let r: Awaited<ReturnType<UiContext["connection"]["claim"]>>;
    try {
      r = await this.ctx.connection.claim(this.link, this.deviceName.trim());
    } finally {
      this.busy = false;
    }
    if (this.closed) {
      // Closed while the claim was in flight: withdraw it so the other device gets nothing to approve.
      if (r.ok) void this.ctx.connection.cancelClaim(r.claimId);
      return;
    }
    if (!r.ok) {
      this.result = {
        invalid: this.m.invalidToken,
        expired: this.m.expired,
        already_claimed: this.m.alreadyClaimed,
      }[r.reason];
      this.step = "result";
      this.render();
      return;
    }
    this.claimId = r.claimId;
    this.code = r.code;
    this.expiresAt = r.expiresAt;
    this.step = "code";
    this.render();
    this.timer = window.setInterval(() => void this.tick(), 1000);
  }

  private async tick(): Promise<void> {
    this.ticks += 1;
    if (this.ticks % 2 === 0 && this.claimId) {
      const status = await this.ctx.connection.claimStatus(this.claimId);
      if (this.closed || this.step !== "code") return;
      if (status === "approved") {
        this.stopTimer();
        if (this.ctx.localFileCount() > 0) {
          this.step = "reconcile";
          this.render();
        } else {
          this.startDownload();
        }
        return;
      }
      if (status === "denied" || status === "expired") {
        this.stopTimer();
        this.result = status === "denied" ? this.m.denied : this.m.expired;
        this.step = "result";
        this.render();
        return;
      }
    }
    // Countdown only: update the text, never rebuild the window (keeps focus and aria-live stable).
    const waiting = this.contentEl.querySelector(`.${P}__waiting`);
    if (this.step === "code" && waiting)
      waiting.textContent = fmt(this.m.waiting, { left: this.left() });
  }

  private startDownload(): void {
    this.step = "result";
    this.ctx.transfer.start("download");
    this.close();
    void this.ctx.openTransfer();
  }

  private async abortAfterApproval(): Promise<void> {
    this.step = "result";
    await this.ctx.connection.unlink();
    this.close();
  }

  private stopTimer(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }
}
