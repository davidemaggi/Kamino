import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { PasswordSection } from "./PasswordSection.js";
import { ProfileSection } from "./ProfileSection.js";
import { SecurityLogSection } from "./SecurityLogSection.js";
import { SessionsSection } from "./SessionsSection.js";
import { TotpSection } from "./TotpSection.js";

export function AccountPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("account.title"));
  const me = useQuery({ queryKey: ["me"], queryFn: api.me }).data;
  if (!me) return null;
  return (
    <div className="space-y-6">
      <h1 className="font-serif text-2xl font-semibold">{t("account.title")}</h1>
      <ProfileSection me={me} />
      <PasswordSection />
      <TotpSection me={me} />
      <SessionsSection />
      <SecurityLogSection />
    </div>
  );
}
