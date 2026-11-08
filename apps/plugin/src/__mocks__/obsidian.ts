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
  static last: Notice | null = null;
  noticeEl: HTMLElement = document.createElement("div");
  constructor(message: string, duration?: number) {
    void duration;
    Notice.shown.push(message);
    Notice.last = this;
  }
}

export const Platform = { isMobile: false, isDesktop: true, isIosApp: false };

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
  onLayoutReady(cb: () => unknown): void {
    cb();
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
    const view = creator(this);
    this.view = view;
    if (!this.app.workspace.leaves.includes(this)) this.app.workspace.leaves.push(this);
    await view.open();
    await view.setState(state.state ?? {}, { history: false });
  }
  getViewState(): { type: string; state: Record<string, unknown> } {
    return { type: this.view?.getViewType() ?? "empty", state: this.view?.getState() ?? {} };
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

export class Vault {
  configDir = ".obsidian";
  files: Array<{ path: string }> = [];
  getFiles(): Array<{ path: string }> {
    return this.files;
  }
  getName(): string {
    return "Prova";
  }
}

export class App {
  workspace: Workspace = new Workspace(this);
  vault: Vault = new Vault();
}

export interface Command {
  id: string;
  name: string;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
}

export class Plugin {
  app = new App();
  tabs: PluginSettingTab[] = [];
  statusBarItems: ObsidianElement[] = [];
  ribbonIcons: HTMLElement[] = [];
  commands: Command[] = [];
  data: unknown = null;
  loadData(): Promise<unknown> {
    return Promise.resolve(structuredClone(this.data));
  }
  saveData(d: unknown): Promise<void> {
    this.data = structuredClone(d);
    return Promise.resolve();
  }
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
  protocolHandlers = new Map<string, (params: Record<string, string>) => unknown>();
  registerObsidianProtocolHandler(
    action: string,
    handler: (params: Record<string, string>) => unknown,
  ): void {
    this.protocolHandlers.set(action, handler);
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

class BaseComponent {
  disabled = false;
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
}

export class TextComponent extends BaseComponent {
  inputEl: HTMLInputElement = document.createElement("input");
  constructor(container: HTMLElement) {
    super();
    this.inputEl.type = "text";
    container.append(this.inputEl);
  }
  getValue(): string {
    return this.inputEl.value;
  }
  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }
  setPlaceholder(p: string): this {
    this.inputEl.placeholder = p;
    return this;
  }
  onChange(cb: (value: string) => unknown): this {
    this.inputEl.addEventListener("input", () => cb(this.inputEl.value));
    return this;
  }
}

export class TextAreaComponent extends BaseComponent {
  inputEl: HTMLTextAreaElement = document.createElement("textarea");
  constructor(container: HTMLElement) {
    super();
    container.append(this.inputEl);
  }
  getValue(): string {
    return this.inputEl.value;
  }
  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }
  setPlaceholder(p: string): this {
    this.inputEl.placeholder = p;
    return this;
  }
  onChange(cb: (value: string) => unknown): this {
    this.inputEl.addEventListener("input", () => cb(this.inputEl.value));
    return this;
  }
}

export class ToggleComponent extends BaseComponent {
  toggleEl: HTMLInputElement = document.createElement("input");
  constructor(container: HTMLElement) {
    super();
    this.toggleEl.type = "checkbox";
    container.append(this.toggleEl);
  }
  getValue(): boolean {
    return this.toggleEl.checked;
  }
  setValue(on: boolean): this {
    this.toggleEl.checked = on;
    return this;
  }
  onChange(cb: (value: boolean) => unknown): this {
    this.toggleEl.addEventListener("change", () => cb(this.toggleEl.checked));
    return this;
  }
}

export class DropdownComponent extends BaseComponent {
  selectEl: HTMLSelectElement = document.createElement("select");
  constructor(container: HTMLElement) {
    super();
    container.append(this.selectEl);
  }
  addOption(value: string, display: string): this {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = display;
    this.selectEl.append(o);
    return this;
  }
  getValue(): string {
    return this.selectEl.value;
  }
  setValue(value: string): this {
    this.selectEl.value = value;
    return this;
  }
  onChange(cb: (value: string) => unknown): this {
    this.selectEl.addEventListener("change", () => cb(this.selectEl.value));
    return this;
  }
}

export class ButtonComponent extends BaseComponent {
  buttonEl: HTMLButtonElement = document.createElement("button");
  constructor(container: HTMLElement) {
    super();
    container.append(this.buttonEl);
  }
  setButtonText(text: string): this {
    this.buttonEl.textContent = text;
    return this;
  }
  setCta(): this {
    this.buttonEl.classList.add("mod-cta");
    return this;
  }
  setWarning(): this {
    this.buttonEl.classList.add("mod-warning");
    return this;
  }
  override setDisabled(disabled: boolean): this {
    this.buttonEl.disabled = disabled;
    return super.setDisabled(disabled);
  }
  onClick(cb: (evt: MouseEvent) => unknown): this {
    this.buttonEl.addEventListener("click", (e) => cb(e as MouseEvent));
    return this;
  }
}

export class Setting {
  settingEl = document.createElement("div");
  infoEl = document.createElement("div");
  nameEl = document.createElement("div");
  descEl = document.createElement("div");
  controlEl = document.createElement("div");
  constructor(containerEl: HTMLElement) {
    this.settingEl.className = "setting-item";
    this.nameEl.className = "setting-item-name";
    this.descEl.className = "setting-item-description";
    this.infoEl.append(this.nameEl, this.descEl);
    this.settingEl.append(this.infoEl, this.controlEl);
    containerEl.append(this.settingEl);
  }
  setName(name: string): this {
    this.nameEl.textContent = name;
    return this;
  }
  setDesc(desc: string | DocumentFragment): this {
    this.descEl.replaceChildren(desc);
    return this;
  }
  setHeading(): this {
    this.settingEl.classList.add("setting-item-heading");
    return this;
  }
  setClass(cls: string): this {
    this.settingEl.classList.add(cls);
    return this;
  }
  addText(cb: (c: TextComponent) => unknown): this {
    cb(new TextComponent(this.controlEl));
    return this;
  }
  addTextArea(cb: (c: TextAreaComponent) => unknown): this {
    cb(new TextAreaComponent(this.controlEl));
    return this;
  }
  addToggle(cb: (c: ToggleComponent) => unknown): this {
    cb(new ToggleComponent(this.controlEl));
    return this;
  }
  addDropdown(cb: (c: DropdownComponent) => unknown): this {
    cb(new DropdownComponent(this.controlEl));
    return this;
  }
  addButton(cb: (c: ButtonComponent) => unknown): this {
    cb(new ButtonComponent(this.controlEl));
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
