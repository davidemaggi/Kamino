import { DEFAULT_THRESHOLDS, describeStatus, exampleSnapshots } from "@kamino/status";
// Mock classes imported by path: Vitest aliases "obsidian" to this same module,
// and the mock-only fields (statusBarItems, actions, Notice.shown) stay typed.
import { MarkdownView, Notice, Plugin } from "../__mocks__/obsidian.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { levelClass } from "./status-classes.js";
import { StatusIndicator } from "./StatusIndicator.js";

const NOW = Date.UTC(2026, 10, 7, 12);
const status = (id: string) =>
  describeStatus(exampleSnapshots(NOW).find((e) => e.id === id)!.snapshot, DEFAULT_THRESHOLDS, NOW);

function setup(isMobile: boolean) {
  const onOpenDetails = vi.fn();
  const plugin = new Plugin();
  const view = new MarkdownView();
  plugin.app.workspace.activeView = view;
  const indicator = new StatusIndicator(plugin as never, {
    isMobile,
    lang: "it",
    now: () => NOW,
    available: null,
    onOpenDetails,
  });
  indicator.mount();
  return { plugin, view, indicator, onOpenDetails };
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
    expect(view.actions[0]!.isConnected).toBe(false);
  });

  it("moves the header action to the new active note", () => {
    const { plugin, view, indicator } = setup(true);
    indicator.update(status("one-conflict"));
    const other = new MarkdownView();
    plugin.app.workspace.activeView = other;
    plugin.app.workspace.trigger("active-leaf-change");
    expect(view.actions[0]!.isConnected).toBe(false);
    expect(other.actions).toHaveLength(1);
  });
});

describe("StatusIndicator header action lifecycle", () => {
  it("refreshes icon and label when the status changes within the same level", () => {
    const { view, indicator } = setup(true);
    indicator.update(status("offline-2-days"));
    indicator.update(status("stale-queue"));
    const live = view.actions.filter((a) => a.isConnected);
    expect(live).toHaveLength(1);
    expect(live[0]!.dataset["icon"]).toBe("triangle-alert");
    expect(live[0]!.getAttribute("aria-label")).toContain("5 modifiche non salvate da 2 h");
  });

  it("does not rebuild the action when nothing changed", () => {
    const { view, indicator } = setup(true);
    indicator.update(status("one-conflict"));
    indicator.update(status("one-conflict"));
    expect(view.actions).toHaveLength(1);
    expect(view.actions[0]!.isConnected).toBe(true);
  });

  it("removes the header action when the plugin unloads", () => {
    const { plugin, view, indicator } = setup(true);
    indicator.update(status("revoked"));
    expect(view.actions[0]!.isConnected).toBe(true);
    plugin.unload();
    expect(view.actions[0]!.isConnected).toBe(false);
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

  it("clicking the ribbon opens the status panel", () => {
    const { plugin, indicator, onOpenDetails } = setup(false);
    indicator.update(status("safe"));
    plugin.ribbonIcons[0]!.click();
    expect(onOpenDetails).toHaveBeenCalled();
  });
});
