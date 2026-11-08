import type { Vault } from "@kamino/protocol";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";

export function VaultConflictsTab({ vault }: { vault: Vault }) {
  const { t } = useTranslation();
  const conflicts = (
    useQuery({ queryKey: ["conflicts"], queryFn: api.conflicts }).data ?? []
  ).filter((c) => c.vaultId === vault.id);
  if (conflicts.length === 0)
    return <p className="text-muted-foreground">{t("vault.noConflicts")}</p>;
  return (
    <ul className="bg-card divide-y rounded-xl border">
      {conflicts.map((c) => (
        <li key={c.id}>
          <Link
            to="/conflicts/$conflictId"
            params={{ conflictId: c.id }}
            className="hover:bg-muted flex justify-between gap-2 p-3"
          >
            <span className="font-medium">{c.path}</span>
            <span className="text-muted-foreground text-sm">{c.incoming.device}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
