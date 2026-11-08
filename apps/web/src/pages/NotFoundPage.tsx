import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <section className="space-y-3">
      <p>{t("shell.notFound")}</p>
      <Link to="/" className="text-link underline">
        {t("shell.backHome")}
      </Link>
    </section>
  );
}
