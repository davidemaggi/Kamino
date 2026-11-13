import { Modal, type App } from "obsidian";
import type { ServerCheck, Session, VaultSummary } from "../connection/types.js";
import { fmt } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import type { UiContext } from "./context.js";
import { h } from "./dom.js";
import { CLASS_PREFIX } from "./status-classes.js";

const P = `${CLASS_PREFIX}-connect`;
type Step = "server" | "login" | "vault" | "device" | "reconcile";

/** Manual linking: first device ("create") or existing vault ("join") — spec §3.2–3.3. */
export class ConnectModal extends Modal {
  private step: Step = "server";
  private serverUrl = "";
  private check: Extract<ServerCheck, { ok: true }> | null = null;
  private user = "";
  private password = "";
  private totp = "";
  private needTotp = false;
  private session: Session | null = null;
  private vaults: VaultSummary[] = [];
  private vaultId: string | null = null;
  private vaultName: string;
  private deviceName: string;
  private error: string | null = null;
  private busy = false;
  /** Set on close: a late answer must not link or start anything. */
  private closed = false;

  constructor(
    app: App,
    private readonly ctx: UiContext,
    private readonly mode: "create" | "join",
  ) {
    super(app);
    this.vaultName = ctx.vaultName;
    this.deviceName = ctx.platformLabel;
  }

  override onOpen(): void {
    // Enter submits the current step (keyboard users).
    this.contentEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.target as HTMLElement | null)?.tagName === "INPUT") {
        e.preventDefault();
        void this.next();
      }
    });
    this.render();
  }

  override onClose(): void {
    this.closed = true;
    // Never keep the password around (D-08).
    this.password = "";
    this.totp = "";
    this.contentEl.replaceChildren();
  }

  private get m() {
    return t(this.ctx.lang).connect;
  }

  private render(): void {
    const m = this.m;
    this.titleEl.textContent = this.mode === "create" ? m.titleCreate : m.titleJoin;
    const root = this.contentEl;
    root.replaceChildren();
    root.classList.add(P);
    if (this.check?.insecure) h(root, "p", { cls: `${P}__warning`, text: m.insecure });

    const body = h(root, "div", { cls: `${P}__body` });
    if (this.step === "server") {
      this.field(
        body,
        m.serverLabel,
        this.serverUrl,
        (v) => (this.serverUrl = v),
        "url",
        m.serverPlaceholder,
      );
    } else if (this.step === "login") {
      this.field(body, m.user, this.user, (v) => (this.user = v));
      this.field(body, m.password, "", (v) => (this.password = v), "password");
      if (this.needTotp) {
        h(body, "p", { cls: `${P}__muted`, text: m.totpHint });
        this.field(body, m.totp, "", (v) => (this.totp = v), "text");
      }
    } else if (this.step === "vault") {
      if (this.mode === "create") {
        this.field(body, m.vaultName, this.vaultName, (v) => (this.vaultName = v));
      } else if (this.vaults.length === 0) {
        h(body, "p", { text: m.noVaults });
      } else {
        const group = h(body, "div", { attrs: { role: "radiogroup", "aria-label": m.vaultPick } });
        for (const v of this.vaults) {
          const label = h(group, "label", { cls: `${P}__vault` });
          const input = h(label, "input", { attrs: { type: "radio", name: "vault", value: v.id } });
          input.checked = this.vaultId === v.id;
          input.addEventListener("change", () => (this.vaultId = v.id));
          h(label, "b", { text: v.name });
          h(label, "span", {
            cls: `${P}__muted`,
            text: fmt(m.vaultMeta, { files: v.fileCount, devices: v.deviceCount }),
          });
        }
      }
    } else if (this.step === "device") {
      this.field(body, m.deviceName, this.deviceName, (v) => (this.deviceName = v));
    } else {
      h(body, "p", { text: fmt(m.reconcile, { count: this.ctx.localFileCount() }) });
    }

    if (this.error)
      h(root, "p", { cls: `${P}__error`, attrs: { role: "alert" }, text: this.error });
    this.renderButtons(root);
  }

  private field(
    parent: HTMLElement,
    label: string,
    value: string,
    onInput: (v: string) => void,
    type = "text",
    placeholder = "",
  ): void {
    const wrap = h(parent, "label", { cls: `${P}__field` });
    h(wrap, "span", { text: label });
    const input = h(wrap, "input", {
      attrs: { type, "aria-label": label, ...(placeholder ? { placeholder } : {}) },
    });
    input.value = value;
    input.addEventListener("input", () => onInput(input.value));
  }

  private renderButtons(root: HTMLElement): void {
    const m = this.m;
    const bar = h(root, "div", { cls: "modal-button-container" });
    const button = (text: string, onClick: () => void, cta = false) => {
      const b = h(bar, "button", { text, ...(cta ? { cls: "mod-cta" } : {}) });
      b.disabled = this.busy;
      b.addEventListener("click", onClick);
    };
    if (this.step !== "server") button(m.back, () => this.back());
    button(m.cancel, () => this.close());
    const primary = {
      server: m.check,
      login: m.signIn,
      vault: m.next,
      device: this.mode === "create" ? m.createAndLink : m.link,
      reconcile: m.continue,
    }[this.step];
    if (this.step === "vault" && this.mode === "join" && this.vaults.length === 0) return;
    button(primary, () => void this.next(), true);
  }

  private back(): void {
    if (this.busy) return;
    const order: Step[] = ["server", "login", "vault", "device", "reconcile"];
    this.error = null;
    this.step = order[Math.max(0, order.indexOf(this.step) - 1)]!;
    if (this.step === "server") this.check = null;
    this.render();
  }

  private async next(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    try {
      await this.advance();
    } catch {
      // Never a silent button: a failed create or link says so (the details stay out of the UI).
      this.error = this.m.errors.failed;
    } finally {
      this.busy = false;
      if (this.contentEl.isConnected || this.contentEl.childElementCount > 0) this.render();
    }
  }

  private async advance(): Promise<void> {
    const m = this.m;
    const { connection } = this.ctx;
    switch (this.step) {
      case "server": {
        const r = await connection.checkServer(this.serverUrl);
        if (!r.ok) {
          this.error = m.errors[r.reason];
          return;
        }
        this.check = r;
        this.step = "login";
        return;
      }
      case "login": {
        if (!this.user || !this.password) {
          this.error = m.errors.required;
          return;
        }
        const r = await connection.login(
          this.serverUrl.trim(),
          this.user,
          this.password,
          this.needTotp ? this.totp : undefined,
        );
        if (!r.ok) {
          if (r.reason === "totp_required") {
            this.needTotp = true;
          } else {
            // The field is re-rendered empty: never resubmit a password the user cannot see.
            this.password = "";
            this.totp = "";
            this.error = m.errors[r.reason];
          }
          return;
        }
        this.password = "";
        this.totp = "";
        this.session = r.session;
        if (this.mode === "join") this.vaults = await connection.listVaults(r.session);
        this.step = "vault";
        return;
      }
      case "vault": {
        if (this.mode === "join") {
          // Read the selection from the DOM: robust whatever event the radio fires.
          const picked = this.contentEl.querySelector<HTMLInputElement>(
            'input[name="vault"]:checked',
          );
          this.vaultId = picked?.value ?? this.vaultId;
        }
        if (this.mode === "create" ? !this.vaultName.trim() : !this.vaultId) {
          this.error = m.errors.required;
          return;
        }
        this.step = "device";
        return;
      }
      case "device": {
        if (!this.deviceName.trim()) {
          this.error = m.errors.required;
          return;
        }
        if (this.mode === "join" && this.ctx.localFileCount() > 0) {
          this.step = "reconcile";
          return;
        }
        await this.finish();
        return;
      }
      case "reconcile":
        await this.finish();
        return;
    }
  }

  private async finish(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const { connection, transfer } = this.ctx;
    let vaultId = this.vaultId;
    if (this.mode === "create")
      vaultId = (await connection.createVault(session, this.vaultName.trim())).id;
    if (!vaultId || this.closed) return;
    await connection.linkDevice(session, vaultId, this.deviceName.trim());
    if (this.closed) {
      // Closed (Esc) while linking: the user cancelled, so do not stay linked.
      await connection.unlink();
      return;
    }
    transfer.start(this.mode === "create" ? "upload" : "download");
    this.close();
    void this.ctx.openTransfer();
  }
}
