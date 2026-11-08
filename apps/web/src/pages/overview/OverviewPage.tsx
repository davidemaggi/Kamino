import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { LevelBadge } from "../../components/status/LevelBadge.js";
import { Button } from "../../components/ui/button.js";
import { formatBytes } from "../../lib/format.js";
import { AddDeviceDialog } from "../devices/AddDeviceDialog.js";
import { VaultCard } from "../vaults/VaultCard.js";

const ATTENTION = new Set(["attention", "decision", "blocked"]);

export function OverviewPage() {
  const { t, i18n } = useTranslation();
  useDocumentTitle(t("overview.title"));
  const [addOpen, setAddOpen] = useState(false);
  const vaults = useQuery({ queryKey: ["vaults"], queryFn: api.vaults });
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices });
  const data = vaults.data;
  if (!data) return null;
  const { usedBytes, limitBytes } = data.quota;
  const ratio = limitBytes ? usedBytes / limitBytes : 0;
  const watch = (devices.data ?? [])
    .filter((d) => !d.revoked && ATTENTION.has(d.level))
    .slice(0, 5);
  const lang = i18n.language;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-2xl font-semibold">{t("overview.title")}</h1>
        {data.vaults.length > 0 && (
          <Button onClick={() => setAddOpen(true)}>{t("overview.addDevice")}</Button>
        )}
      </div>

      <section aria-label={t("overview.space")} className="bg-card space-y-2 rounded-xl border p-4">
        <p className="text-sm font-medium">{t("overview.space")}</p>
        <p>
          {limitBytes
            ? t("overview.spaceOf", {
                used: formatBytes(usedBytes, lang),
                limit: formatBytes(limitBytes, lang),
              })
            : t("overview.spaceUnlimited", { used: formatBytes(usedBytes, lang) })}
        </p>
        {limitBytes ? <progress className="w-full" max={limitBytes} value={usedBytes} /> : null}
        {ratio >= 0.9 && (
          <p
            role="alert"
            className="bg-status-attention-surface text-status-attention rounded-md p-2 text-sm"
          >
            {t("overview.spaceWarning")}
          </p>
        )}
      </section>

      <section aria-label={t("overview.vaults")} className="space-y-3">
        <h2 className="font-serif text-lg font-semibold">{t("overview.vaults")}</h2>
        {data.vaults.length === 0 ? (
          <p className="text-muted-foreground">{t("overview.noVaults")}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {data.vaults.map((v) => (
              <VaultCard key={v.id} vault={v} />
            ))}
          </div>
        )}
      </section>

      {watch.length > 0 && (
        <section aria-label={t("overview.attention")} className="space-y-3">
          <h2 className="font-serif text-lg font-semibold">{t("overview.attention")}</h2>
          <ul className="bg-card divide-y rounded-xl border">
            {watch.map((d) => (
              <li key={d.id}>
                <Link
                  to="/devices/$deviceId"
                  params={{ deviceId: d.id }}
                  className="hover:bg-muted flex flex-wrap items-center justify-between gap-2 p-3"
                >
                  <span>
                    <span className="font-medium">{d.name}</span>{" "}
                    <span className="text-muted-foreground text-sm">· {d.vaultName}</span>
                  </span>
                  <LevelBadge level={d.level} />
                </Link>
              </li>
            ))}
          </ul>
          <Link to="/devices" className="text-link text-sm underline">
            {t("overview.allDevices")}
          </Link>
        </section>
      )}
      <AddDeviceDialog open={addOpen} onOpenChange={setAddOpen} vaults={data.vaults} />
    </div>
  );
}
