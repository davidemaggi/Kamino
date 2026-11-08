import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { Button } from "../../components/ui/button.js";
import { SectionCard } from "./SectionCard.js";

export function SecurityLogSection() {
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState(1);
  const log = useQuery({ queryKey: ["security-log", page], queryFn: () => api.securityLog(page) });
  const data = log.data;
  return (
    <SectionCard title={t("account.log.title")}>
      <ul className="divide-y">
        {data?.items.map((e) => (
          <li key={e.id} className="flex flex-wrap justify-between gap-2 py-2 text-sm">
            <span>
              {t(`account.log.types.${e.type}`)}
              {e.client ? ` · ${e.client}` : ""}
            </span>
            <time dateTime={e.at} className="text-muted-foreground">
              {new Date(e.at).toLocaleString(i18n.language)}
            </time>
          </li>
        ))}
      </ul>
      {data && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            {t("account.log.newer")}
          </Button>
          <span className="text-muted-foreground text-sm">
            {t("account.log.page", { page: data.page, pages: data.pages })}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={page >= data.pages}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("account.log.older")}
          </Button>
        </div>
      )}
    </SectionCard>
  );
}
