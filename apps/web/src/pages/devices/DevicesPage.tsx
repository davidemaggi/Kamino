import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { LevelBadge } from "../../components/status/LevelBadge.js";
import { formatAgo } from "../../lib/format.js";

export function DevicesPage() {
  const { t, i18n } = useTranslation();
  useDocumentTitle(t("device.title"));
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices }).data ?? [];
  const sorted = [...devices].sort((a, b) => Number(a.revoked) - Number(b.revoked));
  return (
    <div className="space-y-4">
      <h1 className="font-serif text-2xl font-semibold">{t("device.title")}</h1>
      <ul className="bg-card divide-y rounded-xl border">
        {sorted.map((d) => (
          <li key={d.id}>
            <Link
              to="/devices/$deviceId"
              params={{ deviceId: d.id }}
              className={`hover:bg-muted flex flex-wrap items-center justify-between gap-2 p-3 ${d.revoked ? "opacity-60" : ""}`}
            >
              <span>
                <span className="font-medium">{d.name}</span>{" "}
                <span className="text-muted-foreground text-sm">
                  · {d.vaultName} · {d.platform} ·{" "}
                  {d.lastSyncAt ? formatAgo(d.lastSyncAt, i18n.language) : t("device.never")}
                </span>
              </span>
              {d.revoked ? (
                <span className="text-sm">{t("device.revoked")}</span>
              ) : (
                <LevelBadge level={d.level} />
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
