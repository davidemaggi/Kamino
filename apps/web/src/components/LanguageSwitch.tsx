import { useTranslation } from "react-i18next";

export function LanguageSwitch() {
  const { t, i18n } = useTranslation();
  return (
    <div role="group" aria-label={t("auth.language")} className="flex gap-2 text-sm">
      {(["it", "en"] as const).map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={i18n.language === l}
          onClick={() => {
            void i18n.changeLanguage(l);
            document.documentElement.lang = l;
          }}
          className={i18n.language === l ? "font-semibold underline" : "text-muted-foreground"}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
