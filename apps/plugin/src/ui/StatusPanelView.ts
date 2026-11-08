import {
  DEFAULT_THRESHOLDS,
  describeStatus,
  formatAge,
  formatLastConfirmed,
  formatStatusMessage,
} from "@kamino/status";
import { ItemView, type WorkspaceLeaf } from "obsidian";
import { fmt, formatSize, formatWhen } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import type { UiContext } from "./context.js";
import { h } from "./dom.js";
import { renderStatusIndicator, STATUS_CLASS } from "./render-status.js";
import { STATUS_VIEW } from "./workspace.js";

const P = `${STATUS_CLASS}-panel`;
const PENDING_PREVIEW = 5;

/** Sync status panel: summary + non-empty sections (spec §5.1). */
export class StatusPanelView extends ItemView {
  private unsubscribe: Array<() => void> = [];
  private showAllPending = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly ctx: UiContext,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return STATUS_VIEW;
  }
  override getDisplayText(): string {
    return t(this.ctx.lang).panel.title;
  }
  override getIcon(): string {
    return "shield-check";
  }

  protected override onOpen(): Promise<void> {
    this.unsubscribe = [
      this.ctx.source.onChange(() => this.render()),
      this.ctx.connection.onChange(() => this.render()),
    ];
    this.render();
    return Promise.resolve();
  }

  protected override onClose(): Promise<void> {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    return Promise.resolve();
  }

  private render(): void {
    const { ctx } = this;
    const m = t(ctx.lang).panel;
    const now = ctx.now();
    const root = this.contentEl;
    root.replaceChildren();
    root.classList.add(P);

    // Pairing requests waiting for an answer (origin side): on top, until answered or expired.
    const requests = ctx.connection.pairingRequests();
    if (requests.length > 0) {
      const m2 = t(ctx.lang).panel2;
      const sec = this.section(root, fmt(m2.requests, { count: requests.length }));
      for (const r of requests) {
        const meta = fmt(m2.requestMeta, {
          platform: r.platform,
          left: formatAge(Math.max(0, r.expiresAt - now), ctx.lang),
        });
        this.row(sec.list, r.deviceName, meta).addEventListener("click", () =>
          ctx.openAddDevice(r),
        );
      }
    }

    const snapshot = ctx.source.snapshot();
    const status = describeStatus(snapshot, DEFAULT_THRESHOLDS, now);
    const summary = h(root, "section", { cls: `${P}__summary`, attrs: { "aria-live": "polite" } });
    renderStatusIndicator(h(summary, "div", { cls: `${P}__headline` }), status, {
      lang: ctx.lang,
      now,
      available: ctx.available,
    });
    for (const s of status.secondary)
      h(summary, "p", { cls: `${P}__muted`, text: formatStatusMessage(s, ctx.lang) });
    h(summary, "p", {
      cls: `${P}__muted`,
      text: formatLastConfirmed(status.lastConfirmedAt, now, ctx.lang),
    });
    if (snapshot.linked === false) {
      h(summary, "button", { cls: "mod-cta", text: t(ctx.lang).panel2.connect }).addEventListener(
        "click",
        () => void ctx.openWelcome(),
      );
    } else {
      h(summary, "button", { cls: "mod-cta", text: m.syncNow }).addEventListener("click", () => {
        void ctx.actions.syncNow();
      });
    }

    const conflicts = ctx.source.conflicts();
    if (conflicts.length > 0) {
      const sec = this.section(root, fmt(m.conflicts, { count: conflicts.length }));
      if (conflicts.length >= 2) {
        h(sec.header, "button", { text: m.resolveAll }).addEventListener("click", () =>
          ctx.openBulkResolve(),
        );
      }
      for (const c of conflicts) {
        const meta = fmt(m.conflictFrom, {
          device: c.incoming.device,
          when: formatWhen(c.incoming.at, now, ctx.lang),
        });
        this.row(sec.list, c.path, meta).addEventListener("click", () => {
          void ctx.openConflict(c.id);
        });
      }
    }

    const pending = ctx.source.pending();
    if (pending.length > 0) {
      const sec = this.section(root, fmt(m.pending, { count: pending.length }));
      const shown = this.showAllPending ? pending : pending.slice(0, PENDING_PREVIEW);
      for (const p of shown) {
        const meta = fmt(m.pendingMeta, {
          op: m.ops[p.op],
          age: formatAge(now - p.since, ctx.lang),
        });
        this.row(sec.list, p.path, meta, "div");
      }
      if (shown.length < pending.length) {
        h(sec.list, "button", {
          cls: `${P}__more`,
          text: fmt(m.showAll, { count: pending.length }),
        }).addEventListener("click", () => {
          this.showAllPending = true;
          this.render();
        });
      }
    }

    const deferred = ctx.source.deferred();
    if (deferred.length > 0) {
      const sec = this.section(root, fmt(m.deferred, { count: deferred.length }));
      for (const d of deferred) {
        const row = this.row(sec.list, d.path, formatSize(d.size, ctx.lang), "div");
        h(row, "button", {
          text: d.direction === "upload" ? m.uploadNow : m.downloadNow,
        }).addEventListener("click", () => {
          void ctx.actions.transferNow(d.path);
        });
      }
    }

    const device = ctx.source.device();
    const sec = this.section(root, m.device);
    const dl = h(sec.list, "dl", { cls: `${P}__device` });
    for (const [label, value] of [
      [m.deviceName, device.name],
      [m.mode, m.modes[device.mode]],
      [m.server, device.server],
    ] as const) {
      h(dl, "dt", { text: label });
      h(dl, "dd", { text: value });
    }
  }

  private section(root: HTMLElement, title: string): { header: HTMLElement; list: HTMLElement } {
    const sec = h(root, "section", { cls: `${P}__section` });
    const header = h(sec, "div", { cls: `${P}__header` });
    h(header, "h3", { text: title });
    return { header, list: h(sec, "div", { cls: `${P}__list` }) };
  }

  private row(
    list: HTMLElement,
    main: string,
    meta: string,
    tag: "button" | "div" = "button",
  ): HTMLElement {
    const row = h(list, tag, { cls: `${P}__row` });
    h(row, "span", { cls: `${P}__name`, text: main });
    h(row, "span", { cls: `${P}__meta`, text: meta });
    return row;
  }
}
