import { DEFAULT_THRESHOLDS, describeStatus, exampleSnapshots } from "@kamino/status";
// Mock classes imported by path: Vitest aliases "obsidian" to this same module,
// and the mock-only fields (statusBarItems, actions, Notice.shown) stay typed.
import { MarkdownView, Notice, Plugin } from "../__mocks__/obsidian.js";
import { beforeEach, describe, expect, it } from "vitest";
import { levelClass } from "./status-classes.js";
import { StatusIndicator } from "./StatusIndicator.js";

const NOW = Date.UTC(2026, 10, 7, 12);
const status = (id: string) =>
  describeStatus(exampleSnapshots(NOW).find((e) => e.id === id)!.snapshot, DEFAULT_THRESHOLDS, NOW);

function setup(isMobile: boolean) {
  const plugin = new Plugin();
  const view = new MarkdownView();
  plugin.app.workspace.activeView = view;
  const indicator = new StatusIndicator(plugin as never, {
    isMobile,
    lang: "it",
    now: () => NOW,
    available: null,
  });
  indicator.mount();
  return { plugin, view, indicator };
}

beforeEach(() => {
  Notice.shown = [];
});

describe("StatusIndicator on desktop", () => {
  it("adds a status bar item and a ribbon icon, both updated", () => {
    const { plugin, indicator } = setup(false);
    indicator.update(status("one-conflict"));
    expect(plugin.statusBarItems).toHaveLength(1);
    expect(plugin.statusBarItems[0]!.textContent).toBe("1 conflitto da risolvere");
    expect(plugin.statusBarItems[0]!.classList.contains(levelClass("decision"))).toBe(true);
    expect(plugin.ribbonIcons[0]!.dataset["icon"]).toBe("git-compare-arrows");
  });

  it("never adds a header action", () => {
    const { view, indicator } = setup(false);
    indicator.update(status("revoked"));
    expect(view.actions).toHaveLength(0);
  });
});

describe("StatusIndicator on mobile", () => {
  it("has no status bar item", () => {
    const { plugin } = setup(true);
    expect(plugin.statusBarItems).toHaveLength(0);
  });

  it("shows the header action only from attention up, and removes it", () => {
    const { view, indicator } = setup(true);
    indicator.update(status("queued"));
    expect(view.actions).toHaveLength(0);
    indicator.update(status("offline-2-days"));
    expect(view.actions).toHaveLength(1);
    expect(view.actions[0]!.dataset["icon"]).toBe("cloud-off");
    indicator.update(status("safe"));
    expect(view.actions[0]!.dataset["removed"]).toBe("true");
  });

  it("moves the header action to the new active note", () => {
    const { plugin, view, indicator } = setup(true);
    indicator.update(status("one-conflict"));
    const other = new MarkdownView();
    plugin.app.workspace.activeView = other;
    plugin.app.workspace.trigger("active-leaf-change");
    expect(view.actions[0]!.dataset["removed"]).toBe("true");
    expect(other.actions).toHaveLength(1);
  });
});

describe("StatusIndicator notices", () => {
  it("notifies once per change into attention+ levels", () => {
    const { indicator } = setup(false);
    indicator.update(status("safe"));
    indicator.update(status("stale-queue"));
    indicator.update(status("stale-queue"));
    indicator.update(status("revoked"));
    expect(Notice.shown).toEqual([
      "5 modifiche non salvate da 2 h",
      "Dispositivo revocato: il sync è fermo",
    ]);
  });

  it("clicking the ribbon shows the full label", () => {
    const { plugin, indicator } = setup(false);
    indicator.update(status("safe"));
    plugin.ribbonIcons[0]!.click();
    expect(Notice.shown.at(-1)).toBe("Tutto al sicuro · Ultimo sync confermato: 2 min fa");
  });
});
