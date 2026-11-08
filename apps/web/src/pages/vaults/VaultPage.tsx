import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { LevelBadge } from "../../components/status/LevelBadge.js";
import { formatBytes } from "../../lib/format.js";
import { vaultRoute, VAULT_TABS, type VaultTab } from "../../router.js";
import { VaultConflictsTab } from "./VaultConflictsTab.js";
import { VaultDevicesTab } from "./VaultDevicesTab.js";
import { VaultHistoryTab } from "./VaultHistoryTab.js";
import { VaultSettingsTab } from "./VaultSettingsTab.js";

export function VaultPage() {
  const { t, i18n } = useTranslation();
  const { vaultId } = vaultRoute.useParams();
  const { tab } = vaultRoute.useSearch();
  const navigate = useNavigate();
  const vault = useQuery({ queryKey: ["vault", vaultId], queryFn: () => api.vault(vaultId) });
  useDocumentTitle(vault.data?.name ?? t("nav.vaults"));
  if (vault.isError) return <p>{t("vault.notFound")}</p>;
  const v = vault.data;
  if (!v) return null;
  const lang = i18n.language;
  const select = (next: VaultTab) =>
    void navigate({
      to: "/vaults/$vaultId",
      params: { vaultId },
      search: { tab: next },
      replace: true,
    });

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="font-serif text-2xl font-semibold">{v.name}</h1>
          <LevelBadge level={v.level} />
        </div>
        <p className="text-muted-foreground text-sm">
          {t("vault.files", { count: v.fileCount })} ·{" "}
          {t("vault.devices", { count: v.deviceCount })} ·{" "}
          {t("vault.space", {
            total: formatBytes(v.usedBytes, lang),
            history: formatBytes(v.historyBytes, lang),
            trash: formatBytes(v.trashBytes, lang),
          })}
        </p>
      </header>
      <div role="tablist" aria-label={v.name} className="flex flex-wrap gap-1 border-b">
        {VAULT_TABS.map((id) => (
          <button
            key={id}
            role="tab"
            id={`vault-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="vault-tabpanel"
            onClick={() => select(id)}
            className={
              tab === id
                ? "px-3 py-2 text-sm font-semibold shadow-[inset_0_-2px_0_var(--link)]"
                : "text-muted-foreground px-3 py-2 text-sm"
            }
          >
            {t(`vault.tabs.${id}`)}
            {id === "conflicts" && v.conflicts > 0 ? ` · ${v.conflicts}` : ""}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="vault-tabpanel" aria-labelledby={`vault-tab-${tab}`}>
        {tab === "devices" && <VaultDevicesTab vault={v} />}
        {tab === "conflicts" && <VaultConflictsTab vault={v} />}
        {tab === "history" && <VaultHistoryTab vault={v} />}
        {tab === "settings" && <VaultSettingsTab vault={v} />}
      </div>
    </div>
  );
}
