import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { LevelBadge } from "../../components/status/LevelBadge.js";
import { TextField } from "../../components/TextField.js";
import { Button } from "../../components/ui/button.js";
import { formatDateTime } from "../../lib/format.js";
import { deviceRoute } from "../../router.js";

export function DevicePage() {
  const { t, i18n } = useTranslation();
  const { deviceId } = deviceRoute.useParams();
  const qc = useQueryClient();
  const device = useQuery({ queryKey: ["device", deviceId], queryFn: () => api.device(deviceId) });
  const d = device.data;
  useDocumentTitle(d?.name ?? t("device.title"));
  const [name, setName] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  useEffect(() => {
    if (d) setName(d.name);
  }, [d?.id]); // only when another device is loaded
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["device", deviceId] }),
      qc.invalidateQueries({ queryKey: ["devices"] }),
      qc.invalidateQueries({ queryKey: ["vaults"] }),
    ]);
  const onError = (err: unknown) => toast.error(errorMessage(err, t));
  const rename = useMutation({
    mutationFn: () => api.renameDevice(deviceId, name),
    onSuccess: () => {
      toast(t("device.renamed"));
      void refresh();
    },
    onError,
  });
  const revoke = useMutation({
    mutationFn: () => api.revokeDevice(deviceId),
    onSuccess: () => {
      setConfirmOpen(false);
      toast(t("device.revokedDone"));
      void refresh();
    },
    onError,
  });

  if (device.isError) return <p>{t("device.notFound")}</p>;
  if (!d) return null;
  const lang = i18n.language;
  const rows: Array<[string, string]> = [
    [t("device.vault"), d.vaultName],
    [t("device.platform"), d.platform],
    [t("device.pluginVersion"), d.pluginVersion],
    [t("device.lastSeen"), formatDateTime(d.lastSeenAt, lang)],
    [t("device.lastSync"), d.lastSyncAt ? formatDateTime(d.lastSyncAt, lang) : t("device.never")],
    [t("device.lag"), t("device.lagValue", { count: d.lag })],
    [t("device.pending"), String(d.pending)],
    [
      t("device.lastError"),
      d.lastError ? t(`errors.${d.lastError}`, { defaultValue: d.lastError }) : t("device.noError"),
    ],
  ];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!rename.isPending && name.trim()) rename.mutate();
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-serif text-2xl font-semibold">{d.name}</h1>
        {d.revoked ? <span>{t("device.revoked")}</span> : <LevelBadge level={d.level} />}
      </div>
      <dl className="bg-card grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-xl border p-4 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {!d.revoked && (
        <>
          <form
            onSubmit={submit}
            className="bg-card flex flex-wrap items-end gap-2 rounded-xl border p-4"
          >
            <div className="min-w-56 flex-1">
              <TextField label={t("device.name")} value={name} onChange={setName} />
            </div>
            <Button type="submit" disabled={rename.isPending}>
              {t("device.save")}
            </Button>
          </form>
          <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
            {t("device.revoke")}
          </Button>
          <ConfirmDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            title={t("device.revokeTitle", { name: d.name })}
            text={t("device.revokeText")}
            confirmText={t("device.revokeConfirm")}
            cancelText={t("device.cancel")}
            destructive
            busy={revoke.isPending}
            onConfirm={() => revoke.mutate()}
          />
        </>
      )}
    </div>
  );
}
