import type { Vault } from "@kamino/protocol";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { LevelBadge } from "../../components/status/LevelBadge.js";
import { Button } from "../../components/ui/button.js";
import { formatAgo } from "../../lib/format.js";
import { AddDeviceDialog } from "../devices/AddDeviceDialog.js";
import { ForceSyncDialog } from "./ForceSyncDialog.js";

export function VaultDevicesTab({ vault }: { vault: Vault }) {
  const { t, i18n } = useTranslation();
  const [addOpen, setAddOpen] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);
  const devices = (useQuery({ queryKey: ["devices"], queryFn: api.devices }).data ?? []).filter(
    (d) => d.vaultId === vault.id,
  );
  const active = devices.filter((d) => !d.revoked);
  const forced = useQuery({
    queryKey: ["force-sync", vault.id],
    queryFn: () => api.forceSync(vault.id),
  }).data?.request;
  const stateOf = (done: boolean, sourceDone: boolean) =>
    done ? t("forceSync.done") : sourceDone ? t("forceSync.waiting") : t("forceSync.waitingSource");
  return (
    <div className="space-y-3">
      <ul className="bg-card divide-y rounded-xl border">
        {devices.map((d) => (
          <li key={d.id}>
            <Link
              to="/devices/$deviceId"
              params={{ deviceId: d.id }}
              className={`hover:bg-muted flex flex-wrap items-center justify-between gap-2 p-3 ${d.revoked ? "opacity-60" : ""}`}
            >
              <span>
                <span className="font-medium">{d.name}</span>{" "}
                <span className="text-muted-foreground text-sm">
                  · {d.platform} ·{" "}
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
      {forced && (
        <section className="bg-card rounded-xl border p-3 text-sm">
          <h3 className="mb-1 font-medium">{t("forceSync.statusTitle")}</h3>
          <p className="text-muted-foreground">{formatAgo(forced.createdAt, i18n.language)}</p>
          <ul className="mt-2 space-y-1">
            <li>
              {t("forceSync.source")}: <span className="font-medium">{forced.source.name}</span> ·{" "}
              {forced.source.done ? t("forceSync.done") : t("forceSync.waiting")}
            </li>
            {forced.targets.map((d) => (
              <li key={d.id}>
                <span className="font-medium">{d.name}</span> ·{" "}
                {stateOf(d.done, forced.source.done)}
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setAddOpen(true)}>{t("overview.addDevice")}</Button>
        <Button
          variant="outline"
          disabled={active.length < 2}
          title={active.length < 2 ? t("forceSync.needTwo") : undefined}
          onClick={() => setForceOpen(true)}
        >
          {t("forceSync.open")}
        </Button>
      </div>
      <AddDeviceDialog open={addOpen} onOpenChange={setAddOpen} vaults={[vault]} />
      <ForceSyncDialog
        open={forceOpen}
        onOpenChange={setForceOpen}
        vaultId={vault.id}
        devices={active}
      />
    </div>
  );
}
