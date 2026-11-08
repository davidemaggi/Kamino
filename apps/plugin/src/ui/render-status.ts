import { setIcon } from "obsidian";
import {
  formatLastConfirmed,
  formatStatusMessage,
  LEVELS,
  severity,
  type Lang,
  type Level,
  type StatusDescription,
} from "@kamino/status";
import { levelClass, STATUS_CLASS } from "./status-classes.js";

export { levelClass, STATUS_CLASS };

/** Older Lucide names, present in older Obsidian builds. */
export const FALLBACK_ICON: Record<Level, string> = {
  safe: "check",
  working: "clock",
  attention: "alert-triangle",
  decision: "git-compare",
  blocked: "x-octagon",
};

/** Missing icons are reported once per name, not on every update. */
const warnedIcons = new Set<string>();

export function resolveIcon(
  status: StatusDescription,
  available: ReadonlySet<string> | null,
): string {
  if (available === null) return status.icon;
  if (available.has(status.icon) || available.has(`lucide-${status.icon}`)) return status.icon;
  if (!warnedIcons.has(status.icon)) {
    warnedIcons.add(status.icon);
    console.warn(`status icon "${status.icon}" not available, using fallback`);
  }
  return FALLBACK_ICON[status.level];
}

export function statusLabel(status: StatusDescription, now: number, lang: Lang): string {
  return [status.message, ...status.secondary]
    .map((m) => formatStatusMessage(m, lang))
    .concat(formatLastConfirmed(status.lastConfirmedAt, now, lang))
    .join(" · ");
}

export function renderStatusIndicator(
  el: HTMLElement,
  status: StatusDescription,
  opts: { lang: Lang; now: number; available: ReadonlySet<string> | null },
): void {
  const doc = el.ownerDocument;
  el.replaceChildren();
  el.classList.add(STATUS_CLASS);
  for (const l of LEVELS) el.classList.toggle(levelClass(l), l === status.level);
  const icon = doc.createElement("span");
  icon.className = `${STATUS_CLASS}__icon`;
  setIcon(icon, resolveIcon(status, opts.available));
  const text = doc.createElement("span");
  text.className = `${STATUS_CLASS}__text`;
  text.textContent = formatStatusMessage(status.message, opts.lang);
  el.append(icon, text);
  el.setAttribute("aria-label", statusLabel(status, opts.now, opts.lang));
}

const ATTENTION = severity("attention");

export function shouldShowHeaderAction(level: Level, isMobile: boolean): boolean {
  return isMobile && severity(level) >= ATTENTION;
}

export function shouldNotify(prev: Level | null, next: Level): boolean {
  return severity(next) >= ATTENTION && next !== prev;
}
