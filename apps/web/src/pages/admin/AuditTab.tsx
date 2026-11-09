import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { Button } from "../../components/ui/button.js";
import { formatDateTime } from "../../lib/format.js";

export function AuditTab() {
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState(1);
  const audit = useQuery({ queryKey: ["admin-audit", page], queryFn: () => api.audit(page) });
  if (audit.isError) return <p role="alert">{errorMessage(audit.error, t)}</p>;
  const d = audit.data;
  if (!d) return null;
  return (
    <div className="space-y-3">
      <div className="bg-card overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground text-left">
            <tr>
              {(["when", "actor", "action", "target"] as const).map((k) => (
                <th key={k} scope="col" className="p-3 font-medium">
                  {t(`admin.system.${k}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {d.items.map((e) => (
              <tr key={e.id}>
                <td className="p-3 whitespace-nowrap">{formatDateTime(e.at, i18n.language)}</td>
                <td className="p-3">{e.actor}</td>
                <td className="p-3">{t(`admin.system.actions.${e.action}`)}</td>
                <td className="p-3 font-mono text-xs">{e.target}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          {t("admin.system.newer")}
        </Button>
        <span className="text-muted-foreground text-sm">
          {t("admin.system.page", { page: d.page, pages: d.pages })}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={page >= d.pages}
          onClick={() => setPage((p) => p + 1)}
        >
          {t("admin.system.older")}
        </Button>
      </div>
    </div>
  );
}
