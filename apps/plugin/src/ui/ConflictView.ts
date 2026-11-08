import { createDiffView, diffSummary, type DiffViewHandle } from "@kamino/ui-diff";
import { ItemView, Notice, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { basename, fmt, formatSize, formatWhen } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import type { BinaryInfo, ConflictDetail, Resolution, ResolveOutcome } from "../state/types.js";
import type { UiContext } from "./context.js";
import { h } from "./dom.js";
import { CLASS_PREFIX } from "./status-classes.js";
import { CONFLICT_VIEW } from "./workspace.js";

const P = `${CLASS_PREFIX}-conflict`;
type Tab = "mine" | "diff" | "incoming";

/** Resolution of one conflict (spec §5.2–5.3). */
export class ConflictView extends ItemView {
  private conflictId: string | null = null;
  private detail: ConflictDetail | null = null;
  private diff: DiffViewHandle | null = null;
  private editing = false;
  private tab: Tab = "diff";
  private staleWarning = false;
  private unsubscribe: (() => void) | null = null;
  /** A resolution is being sent: actions are disabled and re-entry is ignored. */
  private busy = false;
  /** Merged text not yet saved (kept across a "stale" answer and shown if the conflict goes away). */
  private draft: string | null = null;
  /** Guards async loads: only the latest one may render, never after close. */
  private loadSeq = 0;
  private closed = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly ctx: UiContext,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return CONFLICT_VIEW;
  }
  override getDisplayText(): string {
    const m = t(this.ctx.lang).conflict;
    return this.detail ? fmt(m.viewTitle, { name: basename(this.detail.path) }) : m.viewTitleEmpty;
  }
  override getIcon(): string {
    return "git-compare-arrows";
  }
  override getState(): Record<string, unknown> {
    return { ...super.getState(), conflictId: this.conflictId };
  }
  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const id = (state as { conflictId?: unknown } | null)?.conflictId;
    this.conflictId = typeof id === "string" ? id : null;
    await this.loadConflict();
    await super.setState(state, result);
  }

  protected override onOpen(): Promise<void> {
    // Resolved elsewhere (another view, bulk, M3 push) → show "already resolved".
    this.unsubscribe = this.ctx.source.onChange(() => {
      if (!this.detail || this.ctx.source.conflicts().some((c) => c.id === this.conflictId)) return;
      // Keep an in-progress merge visible, so it can be copied after the conflict goes away.
      if (this.editing && this.diff) this.draft = this.diff.getMerged();
      void this.loadConflict();
    });
    return Promise.resolve();
  }

  protected override onClose(): Promise<void> {
    this.closed = true;
    this.loadSeq += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.destroyDiff();
    return Promise.resolve();
  }

  private async loadConflict(keepEditing = false): Promise<void> {
    const seq = ++this.loadSeq;
    const detail = this.conflictId ? await this.ctx.source.conflict(this.conflictId) : null;
    if (seq !== this.loadSeq || this.closed) return;
    this.detail = detail;
    this.editing = keepEditing && detail !== null && !detail.binary;
    this.tab = "diff";
    this.render();
  }

  private destroyDiff(): void {
    this.diff?.destroy();
    this.diff = null;
  }

  private render(): void {
    const m = t(this.ctx.lang).conflict;
    this.destroyDiff();
    const root = this.contentEl;
    root.replaceChildren();
    root.classList.add(P);
    root.classList.toggle(`${P}--mobile`, this.ctx.isMobile);

    const d = this.detail;
    if (!d) {
      h(root, "p", { text: m.gone });
      if (this.draft !== null) {
        h(root, "p", { cls: `${P}__muted`, text: m.unsavedMerge });
        h(root, "pre", { cls: `${P}__text`, text: this.draft });
      }
      h(root, "button", { text: m.close }).addEventListener("click", () => this.leaf.detach());
      return;
    }

    const now = this.ctx.now();
    const when = (at: number) => formatWhen(at, now, this.ctx.lang);
    h(root, "h2", { text: basename(d.path) });
    const summary = d.kind === "both_created" ? m.summaryCreated : m.summaryEdit;
    h(root, "p", {
      cls: `${P}__muted`,
      text: fmt(summary, {
        mine: when(d.mine.at),
        device: d.incoming.device,
        incoming: when(d.incoming.at),
      }),
    });
    if (this.staleWarning)
      h(root, "div", { cls: `${P}__alert`, text: m.stale, attrs: { role: "alert" } });

    if (d.binary) this.renderBinary(root, d);
    else this.renderText(root, d);
    this.renderActions(root, d);
  }

  private renderText(root: HTMLElement, d: Extract<ConflictDetail, { binary: false }>): void {
    const m = t(this.ctx.lang).conflict;
    h(root, "p", {
      cls: `${P}__muted`,
      text: fmt(m.changes, { count: diffSummary(d.mineText, d.incomingText).changes }),
    });
    const labels = {
      mine: m.labelMine,
      incoming: fmt(m.labelIncoming, {
        device: d.incoming.device,
        when: formatWhen(d.incoming.at, this.ctx.now(), this.ctx.lang),
      }),
    };
    // Exact phrases used by @codemirror/merge 6.12 (state.phrase): unified controls,
    // split revert arrow, collapsed unchanged lines ("$" = count).
    const phrases = {
      Accept: m.chunkKeepMine,
      Reject: m.chunkTakeIncoming,
      "Revert this chunk": m.chunkTakeIncoming,
      "$ unchanged lines": m.unchangedLines,
    };

    // While editing, a merge kept across a "stale" answer replaces your version as the base.
    const mine = this.editing && this.draft !== null ? this.draft : d.mineText;

    if (!this.ctx.isMobile) {
      const host = h(root, "div", { cls: `${P}__diff` });
      this.diff = createDiffView(host, {
        mine,
        incoming: d.incomingText,
        layout: "split",
        editable: this.editing,
        labels,
        phrases,
      });
      return;
    }

    const panelId = `${P}-panel-${this.conflictId ?? ""}`;
    const tabs = h(root, "div", { cls: `${P}__tabs`, attrs: { role: "tablist" } });
    for (const [id, label] of [
      ["mine", m.tabMine],
      ["diff", m.tabDiff],
      ["incoming", m.tabIncoming],
    ] as const) {
      const tab = h(tabs, "button", {
        text: label,
        attrs: {
          role: "tab",
          id: `${panelId}-${id}`,
          "aria-selected": String(this.tab === id),
          "aria-controls": panelId,
        },
      });
      tab.disabled = this.editing && id !== "diff";
      tab.addEventListener("click", () => {
        this.tab = id;
        this.render();
      });
    }
    const panel = h(root, "div", {
      cls: `${P}__tabpanel`,
      attrs: { role: "tabpanel", id: panelId, "aria-labelledby": `${panelId}-${this.tab}` },
    });
    if (this.tab === "diff") {
      this.diff = createDiffView(panel, {
        mine,
        incoming: d.incomingText,
        layout: "unified",
        editable: this.editing,
        labels,
        phrases,
      });
    } else {
      h(panel, "pre", {
        cls: `${P}__text`,
        text: this.tab === "mine" ? d.mineText : d.incomingText,
      });
    }
  }

  private renderBinary(root: HTMLElement, d: Extract<ConflictDetail, { binary: true }>): void {
    const m = t(this.ctx.lang).conflict;
    const grid = h(root, "div", { cls: `${P}__binary` });
    const card = (title: string, info: BinaryInfo, device: string, at: number) => {
      const box = h(grid, "section", { cls: `${P}__file` });
      h(box, "h3", { text: title });
      if (info.previewUrl) h(box, "img", { attrs: { src: info.previewUrl, alt: title } });
      else h(box, "p", { cls: `${P}__muted`, text: m.noPreview });
      const dl = h(box, "dl");
      for (const [k, v] of [
        [m.fileDevice, device],
        [m.fileDate, formatWhen(at, this.ctx.now(), this.ctx.lang)],
        [m.fileSize, formatSize(info.size, this.ctx.lang)],
        [m.fileType, info.mime],
      ] as const) {
        h(dl, "dt", { text: k });
        h(dl, "dd", { text: v });
      }
    };
    card(m.tabMine, d.mineFile, d.mine.device, d.mine.at);
    card(m.tabIncoming, d.incomingFile, d.incoming.device, d.incoming.at);
  }

  private renderActions(root: HTMLElement, d: ConflictDetail): void {
    const m = t(this.ctx.lang).conflict;
    const bar = h(root, "div", { cls: `${P}__actions` });
    const button = (text: string, onClick: () => void, cta = false) => {
      const b = h(bar, "button", { text, ...(cta ? { cls: "mod-cta" } : {}) });
      b.disabled = this.busy;
      b.addEventListener("click", onClick);
    };

    if (this.editing) {
      button(
        m.saveMerge,
        () => {
          // Never save an empty merge because the diff view is missing.
          if (this.diff) void this.apply({ type: "manual", text: this.diff.getMerged() });
        },
        true,
      );
      button(m.cancel, () => {
        this.editing = false;
        this.draft = null;
        this.render();
      });
      return;
    }
    button(m.keepMine, () => void this.apply({ type: "keep_mine" }));
    button(m.keepIncoming, () => void this.apply({ type: "keep_incoming" }));
    button(m.keepBoth, () => void this.apply({ type: "keep_both" }));
    if (!d.binary) {
      button(
        m.edit,
        () => {
          this.editing = true;
          this.tab = "diff";
          this.render();
        },
        true,
      );
    }
  }

  private async apply(resolution: Resolution): Promise<void> {
    const d = this.detail;
    if (!d || !this.conflictId || this.busy) return;
    const m = t(this.ctx.lang).conflict;
    if (resolution.type === "manual") this.draft = resolution.text;
    this.setBusy(true);
    let outcome: ResolveOutcome;
    try {
      outcome = await this.ctx.actions.resolve(this.conflictId, resolution);
    } catch {
      // Nothing was applied: say so and let the user try again (the view stays as it was).
      this.setBusy(false);
      new Notice(m.failed);
      return;
    }
    this.busy = false;
    if (outcome.ok) {
      this.draft = null;
      const text = {
        keep_mine: fmt(m.doneMine, { device: d.incoming.device }),
        keep_incoming: fmt(m.doneIncoming, { device: d.incoming.device }),
        keep_both: m.doneBoth,
        manual: m.doneMerge,
      }[resolution.type];
      new Notice(text);
      this.leaf.detach();
      return;
    }
    this.staleWarning = outcome.reason === "stale";
    // A manual merge survives a newer incoming version: stay in edit mode on the draft.
    await this.loadConflict(resolution.type === "manual");
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    for (const b of this.contentEl.querySelectorAll<HTMLButtonElement>(`.${P}__actions button`)) {
      b.disabled = busy;
    }
  }
}
