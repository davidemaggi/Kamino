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

export function VaultDevicesTab({ vault }: { vault: Vault }) {
  const { t, i18n } = useTranslation();
  const [addOpen, setAddOpen] = useState(false);
  const devices = (useQuery({ queryKey: ["devices"], queryFn: api.devices }).data ?? []).filter(
    (d) => d.vaultId === vault.id,
  );
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
      <Button onClick={() => setAddOpen(true)}>{t("overview.addDevice")}</Button>
      <AddDeviceDialog open={addOpen} onOpenChange={setAddOpen} vaults={[vault]} />
    </div>
  );
}
