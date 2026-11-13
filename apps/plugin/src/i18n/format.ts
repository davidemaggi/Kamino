import type { Lang } from "@kamino/status";
import { t } from "./index.js";

/** Replaces {name} placeholders; unknown placeholders are left as they are. */
export function fmt(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

/** "10:45" today, "7 nov, 10:45" on other days; null = not known here. `timeZone` is for tests. */
export function formatWhen(at: number | null, now: number, lang: Lang, timeZone?: string): string {
  if (at === null) return t(lang).conflict.unknownTime;
  const tz = timeZone ? { timeZone } : {};
  const day = (d: number) =>
    new Intl.DateTimeFormat("en-CA", {
      ...tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  const time = new Intl.DateTimeFormat(lang, { ...tz, hour: "2-digit", minute: "2-digit" }).format(
    at,
  );
  if (day(at) === day(now)) return time;
  const date = new Intl.DateTimeFormat(lang, { ...tz, day: "numeric", month: "short" }).format(at);
  return `${date}, ${time}`;
}

export function formatSize(bytes: number, lang: Lang): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const n = new Intl.NumberFormat(lang, { maximumFractionDigits: i === 0 ? 0 : 1 }).format(value);
  return `${n} ${units[i]}`;
}

export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}
