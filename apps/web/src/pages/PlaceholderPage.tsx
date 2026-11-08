import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "../app/useDocumentTitle.js";

/** 4b/4c sections not built yet: title and one line. */
export function PlaceholderPage({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();
  const title = t(titleKey);
  useDocumentTitle(title);
  return (
    <section className="space-y-2">
      <h1 className="font-serif text-2xl font-semibold">{title}</h1>
      <p className="text-muted-foreground">{t("shell.placeholder")}</p>
    </section>
  );
}
