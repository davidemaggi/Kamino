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

export class Workspace {
  private handlers = new Map<string, Handler[]>();
  activeView: MarkdownView | null = null;
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
}

export class App {
  workspace = new Workspace();
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
