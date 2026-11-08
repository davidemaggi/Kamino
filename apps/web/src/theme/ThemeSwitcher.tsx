import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useTheme, type Theme } from "./ThemeProvider.js";

const OPTIONS: Theme[] = ["light", "dark", "system"];

export function ThemeSwitcher() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  return (
    <div role="group" aria-label={t("theme.label")} className="inline-flex gap-1">
      {OPTIONS.map((o) => (
        <Button
          key={o}
          size="sm"
          variant={theme === o ? "default" : "outline"}
          aria-pressed={theme === o}
          onClick={() => setTheme(o)}
        >
          {t(`theme.${o}`)}
        </Button>
      ))}
    </div>
  );
}
