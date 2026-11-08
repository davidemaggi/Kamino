import type { Vault } from "@kamino/protocol";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { LevelBadge, LevelDot } from "../../components/status/LevelBadge.js";

export function VaultCard({ vault }: { vault: Vault }) {
  const { t } = useTranslation();
  return (
    <Link
      to="/vaults/$vaultId"
      params={{ vaultId: vault.id }}
      search={{ tab: "devices" }}
      className="bg-card hover:border-ring block space-y-2 rounded-xl border p-4"
    >
      <span className="flex items-center gap-2 font-serif text-lg font-semibold">
        <LevelDot level={vault.level} />
        {vault.name}
      </span>
      <span className="text-muted-foreground block text-sm">
        {t("vault.files", { count: vault.fileCount })} ·{" "}
        {t("vault.devices", { count: vault.deviceCount })}
      </span>
      <LevelBadge level={vault.level} />
    </Link>
  );
}
