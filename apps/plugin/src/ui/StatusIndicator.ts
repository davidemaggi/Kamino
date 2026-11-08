import { MarkdownView, Notice, setIcon, type Plugin } from "obsidian";
import {
  formatStatusMessage,
  type Lang,
  type Level,
  type StatusDescription,
  type SyncSnapshot,
} from "@kamino/status";
import {
  renderStatusIndicator,
  resolveIcon,
  shouldNotify,
  shouldShowHeaderAction,
  statusLabel,
  STATUS_CLASS,
} from "./render-status.js";

export interface IndicatorDeps {
  isMobile: boolean;
  lang: Lang;
  now: () => number;
  available: ReadonlySet<string> | null;
}

/** State before the sync engine exists (M1): honest "never synced". */
export const INITIAL_SNAPSHOT: SyncSnapshot = {
  queued: 0,
  oldestQueuedAt: null,
  lastConfirmedAt: null,
  unreachableSince: null,
  syncing: false,
  conflicts: 0,
  blocked: null,
  quotaRatio: null,
};

/** "Never silent" indicator (S-05): status bar, ribbon, mobile header action, notices. */
export class StatusIndicator {
  private statusBarEl: HTMLElement | null = null;
  private ribbonEl: HTMLElement | null = null;
  private headerActionEl: HTMLElement | null = null;
  private status: StatusDescription | null = null;
  private current: Level | null = null;

  constructor(
    private readonly plugin: Plugin,
    private readonly deps: IndicatorDeps,
  ) {}

  get level(): Level | null {
    return this.current;
  }

  mount(): void {
    if (!this.deps.isMobile) {
      this.statusBarEl = this.plugin.addStatusBarItem();
      this.statusBarEl.addEventListener("click", () => this.showDetails());
    }
    this.ribbonEl = this.plugin.addRibbonIcon("clock", "", () => this.showDetails());
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("active-leaf-change", () => this.syncHeaderAction(true)),
    );
  }

  update(status: StatusDescription): void {
    const prev = this.current;
    this.status = status;
    this.current = status.level;
    const now = this.deps.now();
    const opts = { lang: this.deps.lang, now, available: this.deps.available };
    if (this.statusBarEl) renderStatusIndicator(this.statusBarEl, status, opts);
    if (this.ribbonEl) {
      setIcon(this.ribbonEl, resolveIcon(status, this.deps.available));
      this.ribbonEl.setAttribute("aria-label", statusLabel(status, now, this.deps.lang));
    }
    this.syncHeaderAction(prev !== status.level);
    if (shouldNotify(prev, status.level)) {
      new Notice(formatStatusMessage(status.message, this.deps.lang));
    }
  }

  private syncHeaderAction(rebuild: boolean): void {
    const status = this.status;
    const show = status !== null && shouldShowHeaderAction(status.level, this.deps.isMobile);
    if (this.headerActionEl && (rebuild || !show)) {
      this.headerActionEl.remove();
      this.headerActionEl.dataset["removed"] = "true";
      this.headerActionEl = null;
    }
    if (!show || this.headerActionEl) return;
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const now = this.deps.now();
    this.headerActionEl = view.addAction(
      resolveIcon(status, this.deps.available),
      statusLabel(status, now, this.deps.lang),
      () => this.showDetails(),
    );
    this.headerActionEl.classList.add(`${STATUS_CLASS}-action--${status.level}`);
  }

  private showDetails(): void {
    if (!this.status) return;
    new Notice(statusLabel(this.status, this.deps.now(), this.deps.lang));
  }
}
