import i18next, { type i18n } from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import it from "./locales/it.json";

export type Lang = "it" | "en";

/** `it*` maps to Italian, everything else to English. */
export function detectLanguage(navigatorLanguage: string | undefined): Lang {
  return navigatorLanguage?.toLowerCase().startsWith("it") ? "it" : "en";
}

export function createI18n(lng: Lang): i18n {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    lng,
    fallbackLng: "en",
    resources: { en: { translation: en }, it: { translation: it } },
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  return instance;
}
