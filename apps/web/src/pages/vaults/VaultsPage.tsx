import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { VaultCard } from "./VaultCard.js";

export function VaultsPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("nav.vaults"));
  const vaults = useQuery({ queryKey: ["vaults"], queryFn: api.vaults }).data?.vaults;
  return (
    <div className="space-y-4">
      <h1 className="font-serif text-2xl font-semibold">{t("nav.vaults")}</h1>
      {vaults && vaults.length === 0 && (
        <p className="text-muted-foreground">{t("overview.noVaults")}</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {vaults?.map((v) => (
          <VaultCard key={v.id} vault={v} />
        ))}
      </div>
    </div>
  );
}
