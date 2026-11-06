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

export class App {}

export class Plugin {
  app = new App();
  tabs: PluginSettingTab[] = [];
  addSettingTab(tab: PluginSettingTab): void {
    this.tabs.push(tab);
  }
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
