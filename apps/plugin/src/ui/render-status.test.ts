import {
  DEFAULT_THRESHOLDS,
  describeStatus,
  exampleSnapshots,
  LEVELS,
  type Level,
} from "@kamino/status";
import { describe, expect, it } from "vitest";
import {
  FALLBACK_ICON,
  levelClass,
  renderStatusIndicator,
  resolveIcon,
  shouldNotify,
  shouldShowHeaderAction,
  STATUS_CLASS,
  statusLabel,
} from "./render-status.js";

const NOW = Date.UTC(2026, 10, 7, 12);
const status = (id: string) =>
  describeStatus(exampleSnapshots(NOW).find((e) => e.id === id)!.snapshot, DEFAULT_THRESHOLDS, NOW);

describe("renderStatusIndicator", () => {
  it("renders icon, text, level class and aria-label", () => {
    const el = document.createElement("div");
    renderStatusIndicator(el, status("offline-2-days"), { lang: "it", now: NOW, available: null });
    expect(el.classList.contains(STATUS_CLASS)).toBe(true);
    expect(el.classList.contains(levelClass("attention"))).toBe(true);
    expect(el.textContent).toBe("Server non raggiungibile da 2 g · 14 modifiche non salvate");
    expect(el.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("cloud-off");
    expect(el.getAttribute("aria-label")).toContain("Ultimo sync confermato: 2 g fa");
  });

  it("replaces the previous level class on re-render", () => {
    const el = document.createElement("div");
    renderStatusIndicator(el, status("one-conflict"), { lang: "en", now: NOW, available: null });
    renderStatusIndicator(el, status("safe"), { lang: "en", now: NOW, available: null });
    expect(el.classList.contains(levelClass("decision"))).toBe(false);
    expect(el.classList.contains(levelClass("safe"))).toBe(true);
    expect(el.querySelectorAll("[data-icon]")).toHaveLength(1);
  });
});

describe("resolveIcon", () => {
  it("keeps the name when available (bare or lucide- prefixed)", () => {
    expect(resolveIcon(status("safe"), new Set(["lucide-shield-check"]))).toBe("shield-check");
    expect(resolveIcon(status("safe"), new Set(["shield-check"]))).toBe("shield-check");
    expect(resolveIcon(status("safe"), null)).toBe("shield-check");
  });

  it("falls back per level when missing", () => {
    expect(resolveIcon(status("revoked"), new Set())).toBe(FALLBACK_ICON.blocked);
  });
});

describe("statusLabel", () => {
  it("joins message, secondary and last sync", () => {
    expect(statusLabel(status("conflicts-and-offline"), NOW, "en")).toBe(
      "3 conflicts to resolve · Server unreachable for 2 d · Last confirmed sync: 2 min ago",
    );
  });
});

describe("shouldShowHeaderAction", () => {
  it.each(LEVELS.map((l) => [l]))("%s", (level: Level) => {
    const expected = level === "attention" || level === "decision" || level === "blocked";
    expect(shouldShowHeaderAction(level, true)).toBe(expected);
    expect(shouldShowHeaderAction(level, false)).toBe(false);
  });
});

describe("shouldNotify", () => {
  it("notifies when entering or changing among attention+ levels", () => {
    expect(shouldNotify("safe", "attention")).toBe(true);
    expect(shouldNotify("attention", "blocked")).toBe(true);
    expect(shouldNotify(null, "decision")).toBe(true);
    expect(shouldNotify("attention", "attention")).toBe(false);
    expect(shouldNotify("blocked", "safe")).toBe(false);
    expect(shouldNotify(null, "working")).toBe(false);
  });
});
