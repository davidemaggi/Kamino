import { moment } from "obsidian";
import en from "./en.json";
import it from "./it.json";

export type Lang = "it" | "en";
export type Messages = typeof en;

const messages: Record<Lang, Messages> = { en, it };

/** Italian if the Obsidian locale starts with "it", English otherwise. */
export function detectLanguage(): Lang {
  return moment.locale().toLowerCase().startsWith("it") ? "it" : "en";
}

export function t(lang: Lang = detectLanguage()): Messages {
  return messages[lang];
}
