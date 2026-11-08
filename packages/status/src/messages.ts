import type { StatusKey } from "./levels.js";
import type { StatusMessage } from "./types.js";

export type Lang = "it" | "en";
export type Template = string | { zero?: string; one: string; other: string };

export const STATUS_MESSAGES: Record<Lang, Record<StatusKey, Template>> = {
  it: {
    safe: "Tutto al sicuro",
    "working.syncing": { one: "Invio di 1 modifica…", other: "Invio di {count} modifiche…" },
    "working.queued": { one: "1 modifica in attesa", other: "{count} modifiche in attesa" },
    "working.neverSynced": "Mai sincronizzato",
    "attention.offline": {
      zero: "Server non raggiungibile da {age}",
      one: "Server non raggiungibile da {age} · 1 modifica non salvata",
      other: "Server non raggiungibile da {age} · {count} modifiche non salvate",
    },
    "attention.stale": {
      one: "1 modifica non salvata da {age}",
      other: "{count} modifiche non salvate da {age}",
    },
    "attention.quota": "Spazio quasi esaurito ({percent}%)",
    "decision.conflicts": {
      one: "1 conflitto da risolvere",
      other: "{count} conflitti da risolvere",
    },
    "blocked.quota": {
      zero: "Spazio esaurito",
      one: "Spazio esaurito · 1 modifica non salvata",
      other: "Spazio esaurito · {count} modifiche non salvate",
    },
    "blocked.revoked": "Dispositivo revocato: il sync è fermo",
    "blocked.auth": "Accesso scaduto: accedi di nuovo",
    "blocked.protocol": "Aggiorna il plugin: versione non compatibile con il server",
    "note.unreachable": "Server non raggiungibile da {age}",
  },
  en: {
    safe: "All safe",
    "working.syncing": { one: "Sending 1 change…", other: "Sending {count} changes…" },
    "working.queued": { one: "1 change waiting", other: "{count} changes waiting" },
    "working.neverSynced": "Never synced",
    "attention.offline": {
      zero: "Server unreachable for {age}",
      one: "Server unreachable for {age} · 1 unsaved change",
      other: "Server unreachable for {age} · {count} unsaved changes",
    },
    "attention.stale": {
      one: "1 change unsaved for {age}",
      other: "{count} changes unsaved for {age}",
    },
    "attention.quota": "Storage almost full ({percent}%)",
    "decision.conflicts": { one: "1 conflict to resolve", other: "{count} conflicts to resolve" },
    "blocked.quota": {
      zero: "Storage full",
      one: "Storage full · 1 unsaved change",
      other: "Storage full · {count} unsaved changes",
    },
    "blocked.revoked": "Device revoked: sync is stopped",
    "blocked.auth": "Session expired: sign in again",
    "blocked.protocol": "Update the plugin: version not compatible with the server",
    "note.unreachable": "Server unreachable for {age}",
  },
};

const UNITS: Record<Lang, { lessThanMin: string; min: string; h: string; d: string }> = {
  it: { lessThanMin: "meno di 1 min", min: "min", h: "h", d: "g" },
  en: { lessThanMin: "under 1 min", min: "min", h: "h", d: "d" },
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function formatAge(ms: number, lang: Lang): string {
  const u = UNITS[lang];
  const n = (v: number) => new Intl.NumberFormat(lang).format(Math.floor(v));
  if (ms < MIN) return u.lessThanMin;
  if (ms < HOUR) return `${n(ms / MIN)} ${u.min}`;
  if (ms < DAY) return `${n(ms / HOUR)} ${u.h}`;
  return `${n(ms / DAY)} ${u.d}`;
}

function pick(t: Template, count: number | undefined, lang: Lang): string {
  if (typeof t === "string") return t;
  if (count === 0 && t.zero !== undefined) return t.zero;
  return new Intl.PluralRules(lang).select(count ?? 0) === "one" ? t.one : t.other;
}

export function formatStatusMessage(message: StatusMessage, lang: Lang): string {
  const p = message.params;
  const text = pick(STATUS_MESSAGES[lang][message.key], p["count"], lang);
  return text.replace(/\{(count|age|percent)\}/g, (_, name: string) => {
    if (name === "age") return formatAge(p["ageMs"] ?? 0, lang);
    return new Intl.NumberFormat(lang).format(p[name] ?? 0);
  });
}

const LAST: Record<Lang, { ago: (age: string) => string; never: string }> = {
  it: { ago: (a) => `Ultimo sync confermato: ${a} fa`, never: "Mai sincronizzato con il server" },
  en: { ago: (a) => `Last confirmed sync: ${a} ago`, never: "Never synced with the server" },
};

export function formatLastConfirmed(
  lastConfirmedAt: number | null,
  now: number,
  lang: Lang,
): string {
  if (lastConfirmedAt === null) return LAST[lang].never;
  return LAST[lang].ago(formatAge(Math.max(0, now - lastConfirmedAt), lang));
}
