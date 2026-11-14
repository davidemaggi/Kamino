import type { Device } from "@kamino/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";

/** ADR-0019: one source, one or more targets among the vault's active devices. */
export function ForceSyncDialog({
  open,
  onOpenChange,
  vaultId,
  devices,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  vaultId: string;
  devices: readonly Device[];
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [source, setSource] = useState<string | null>(null);
  const [targets, setTargets] = useState<ReadonlySet<string>>(new Set());
  const reset = () => {
    setSource(null);
    setTargets(new Set());
  };
  const send = useMutation({
    mutationFn: () =>
      api.requestForceSync(vaultId, { sourceDeviceId: source!, targetDeviceIds: [...targets] }),
    onSuccess: (r) => {
      qc.setQueryData(["force-sync", vaultId], r);
      toast(t("forceSync.sent"));
      reset();
      onOpenChange(false);
    },
    onError: (err) => toast.error(errorMessage(err, t)),
  });
  const toggle = (id: string, on: boolean) => {
    const next = new Set(targets);
    if (on) next.add(id);
    else next.delete(id);
    setTargets(next);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        reset();
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("forceSync.title")}</DialogTitle>
          <DialogDescription>{t("forceSync.text")}</DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">{t("forceSync.source")}</legend>
          {devices.map((d) => (
            <label key={d.id} className="flex items-center gap-2">
              <input
                type="radio"
                name="force-source"
                checked={source === d.id}
                onChange={() => {
                  setSource(d.id);
                  toggle(d.id, false);
                }}
              />
              {d.name}
            </label>
          ))}
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">{t("forceSync.targets")}</legend>
          {devices
            .filter((d) => d.id !== source)
            .map((d) => (
              <label key={d.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={targets.has(d.id)}
                  onChange={(e) => toggle(d.id, e.target.checked)}
                />
                {d.name}
              </label>
            ))}
        </fieldset>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("forceSync.cancel")}
          </Button>
          <Button
            disabled={!source || targets.size === 0 || send.isPending}
            onClick={() => send.mutate()}
          >
            {t("forceSync.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
