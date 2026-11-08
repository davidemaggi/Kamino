import { formatAge, type Lang } from "@kamino/status";

export function formatBytes(bytes: number, lang: string): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${new Intl.NumberFormat(lang, { maximumFractionDigits: i === 0 ? 0 : 1 }).format(v)} ${units[i]}`;
}

export function formatDateTime(iso: string, lang: string): string {
  return new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

/** "2 min", "3 h", "2 g" (same compact ages as the plugin, from @kamino/status). */
export function formatAgo(iso: string, lang: string, now = Date.now()): string {
  return formatAge(Math.max(0, now - Date.parse(iso)), (lang === "en" ? "en" : "it") as Lang);
}
