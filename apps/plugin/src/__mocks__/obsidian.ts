// Minimal runtime stand-in for the `obsidian` package (types only upstream).
// Aliased in vitest.config.ts.

interface ObsidianElement extends HTMLElement {
  empty(): void;
}

function makeEl(): ObsidianElement {
  const el = document.createElement("div") as ObsidianElement;
  el.empty = () => {
    el.replaceChildren();
  };
  return el;
}

/** Icons known to the mock; tests may replace the set. */
export const mockIcons = {
  ids: new Set<string>([
    "lucide-shield-check",
    "lucide-clock",
    "lucide-cloud-off",
    "lucide-refresh-cw",
    "lucide-triangle-alert",
    "lucide-git-compare-arrows",
    "lucide-octagon-alert",
  ]),
};

export function getIconIds(): string[] {
  return [...mockIcons.ids];
}

export function setIcon(parent: HTMLElement, iconId: string): void {
  parent.replaceChildren();
  parent.dataset["icon"] = iconId;
  parent.append(document.createElementNS("http://www.w3.org/2000/svg", "svg"));
}

export class Notice {
  static shown: string[] = [];
  constructor(message: string) {
    Notice.shown.push(message);
  }
}

export const Platform = { isMobile: false, isDesktop: true };

type Handler = (...args: unknown[]) => void;

export class MarkdownView {
  actions: HTMLElement[] = [];
  /** Attached to the document so tests can check removal with isConnected. */
  headerEl: HTMLElement = document.body.appendChild(document.createElement("div"));
  addAction(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
    const el = document.createElement("a");
    el.dataset["icon"] = icon;
    el.setAttribute("aria-label", title);
    el.addEventListener("click", (e) => callback(e as MouseEvent));
    this.actions.push(el);
    this.headerEl.append(el);
    return el;
  }
}

type ViewCreator = (leaf: WorkspaceLeaf) => ItemView;

export class Workspace {
  private handlers = new Map<string, Handler[]>();
  activeView: MarkdownView | null = null;
  creators = new Map<string, ViewCreator>();
  leaves: WorkspaceLeaf[] = [];
  revealed: WorkspaceLeaf[] = [];
  constructor(public app: App) {}
  on(name: string, cb: Handler): { name: string } {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), cb]);
    return { name };
  }
  trigger(name: string, ...args: unknown[]): void {
    for (const h of this.handlers.get(name) ?? []) h(...args);
  }
  getActiveViewOfType<T>(type: unknown): T | null {
    void type;
    return this.activeView as T | null;
  }
  getRightLeaf(split: boolean): WorkspaceLeaf {
    void split;
    return new WorkspaceLeaf(this.app);
  }
  getLeaf(newLeaf?: unknown): WorkspaceLeaf {
    void newLeaf;
    return new WorkspaceLeaf(this.app);
  }
  getLeavesOfType(type: string): WorkspaceLeaf[] {
    return this.leaves.filter((l) => l.view?.getViewType() === type);
  }
  revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
    this.revealed.push(leaf);
    return Promise.resolve();
  }
}

export class WorkspaceLeaf {
  view: ItemView | null = null;
  constructor(public app: App) {}
  async setViewState(state: { type: string; state?: unknown; active?: boolean }): Promise<void> {
    const creator = this.app.workspace.creators.get(state.type);
    if (!creator) throw new Error(`no view registered: ${state.type}`);
    if (this.view) await this.view.close();
    this.view = creator(this);
    if (!this.app.workspace.leaves.includes(this)) this.app.workspace.leaves.push(this);
    await this.view.open();
    await this.view.setState(state.state ?? {}, { history: false });
  }
  detach(): void {
    this.app.workspace.leaves = this.app.workspace.leaves.filter((l) => l !== this);
    const view = this.view;
    this.view = null;
    void view?.close();
  }
}

export class ItemView {
  app: App;
  containerEl: ObsidianElement = makeEl();
  contentEl: ObsidianElement = makeEl();
  constructor(public leaf: WorkspaceLeaf) {
    this.app = leaf.app;
    this.containerEl.append(this.contentEl);
  }
  getViewType(): string {
    return "";
  }
  getDisplayText(): string {
    return "";
  }
  getIcon(): string {
    return "";
  }
  getState(): Record<string, unknown> {
    return {};
  }
  setState(state: unknown, result: unknown): Promise<void> {
    void state;
    void result;
    return Promise.resolve();
  }
  protected onOpen(): Promise<void> {
    return Promise.resolve();
  }
  protected onClose(): Promise<void> {
    return Promise.resolve();
  }
  /** Test helper (Obsidian calls onOpen itself). */
  open(): Promise<void> {
    return this.onOpen();
  }
  /** Test helper (Obsidian calls onClose itself). */
  close(): Promise<void> {
    return this.onClose();
  }
}

export class App {
  workspace: Workspace = new Workspace(this);
}

export interface Command {
  id: string;
  name: string;
  callback?: () => unknown;
}

export class Plugin {
  app = new App();
  tabs: PluginSettingTab[] = [];
  statusBarItems: ObsidianElement[] = [];
  ribbonIcons: HTMLElement[] = [];
  commands: Command[] = [];
  addSettingTab(tab: PluginSettingTab): void {
    this.tabs.push(tab);
  }
  addStatusBarItem(): HTMLElement {
    const el = makeEl();
    this.statusBarItems.push(el);
    return el;
  }
  addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
    const el = document.createElement("div");
    setIcon(el, icon);
    el.setAttribute("aria-label", title);
    el.addEventListener("click", (e) => callback(e as MouseEvent));
    this.ribbonIcons.push(el);
    return el;
  }
  registerView(type: string, creator: ViewCreator): void {
    this.app.workspace.creators.set(type, creator);
  }
  addCommand(command: Command): Command {
    this.commands.push(command);
    return command;
  }
  registerEvent(ref: unknown): void {
    void ref;
  }
  private cleanups: Array<() => unknown> = [];
  register(cb: () => unknown): void {
    this.cleanups.push(cb);
  }
  /** Test helper: what Obsidian does when the plugin is disabled or reloaded. */
  unload(): void {
    for (const cb of this.cleanups.splice(0)) cb();
  }
}

export class Modal {
  contentEl: ObsidianElement = makeEl();
  titleEl: ObsidianElement = makeEl();
  isOpen = false;
  constructor(public app: App) {}
  open(): void {
    this.isOpen = true;
    void this.onOpen();
  }
  close(): void {
    this.isOpen = false;
    void this.onClose();
  }
  onOpen(): void | Promise<void> {}
  onClose(): void {}
}

export class PluginSettingTab {
  containerEl: ObsidianElement = makeEl();
  constructor(
    public app: App,
    public plugin: Plugin,
  ) {}
}

export class Setting {
  private nameEl = document.createElement("div");
  private descEl = document.createElement("div");
  constructor(containerEl: HTMLElement) {
    const item = document.createElement("div");
    item.append(this.nameEl, this.descEl);
    containerEl.append(item);
  }
  setName(name: string): this {
    this.nameEl.textContent = name;
    return this;
  }
  setDesc(desc: string): this {
    this.descEl.textContent = desc;
    return this;
  }
  setHeading(): this {
    return this;
  }
}

let currentLocale = "en";
export const moment = {
  locale(next?: string): string {
    if (next !== undefined) currentLocale = next;
    return currentLocale;
  },
};
