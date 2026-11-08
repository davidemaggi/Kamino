import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/button.js";

/** Route error (server unreachable, 5xx…): translated, with a retry; never the raw error. */
export function ErrorPage() {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <main className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <p role="alert">{t("shell.error")}</p>
      <Button onClick={() => void router.invalidate()}>{t("shell.retry")}</Button>
    </main>
  );
}
