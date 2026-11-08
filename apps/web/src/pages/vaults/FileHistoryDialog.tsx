import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { formatBytes, formatDateTime } from "../../lib/format.js";
import { cn } from "../../lib/utils.js";

export function FileHistoryDialog({
  fileId,
  onOpenChange,
}: {
  fileId: string | null;
  onOpenChange: (o: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const lang = i18n.language;
  const versions = useQuery({
    queryKey: ["file-versions", fileId],
    queryFn: () => api.fileVersions(fileId!),
    enabled: !!fileId,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setSelected(null), [fileId]);
  useEffect(() => setConfirming(false), [selected]);
  const content = useQuery({
    queryKey: ["version", selected],
    queryFn: () => api.version(selected!),
    enabled: !!selected,
  });
  const restore = useMutation({
    mutationFn: (id: string) => api.restoreVersion(id),
    onSuccess: async () => {
      toast(t("history.restored"));
      setSelected(null);
      await qc.invalidateQueries({ queryKey: ["file-versions", fileId] });
      void qc.invalidateQueries({ queryKey: ["files"] });
    },
    onError: (err) => toast.error(errorMessage(err, t)),
  });
  const data = versions.data;
  const chosen = data?.versions.find((v) => v.id === selected);

  return (
    <Dialog open={!!fileId} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="break-all">
            {data ? t("history.title", { path: data.path }) : ""}
          </DialogTitle>
          <DialogDescription>{t("history.restoreHint")}</DialogDescription>
        </DialogHeader>
        <ul className="max-h-48 divide-y overflow-auto rounded-lg border">
          {data?.versions.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                onClick={() => setSelected(v.id)}
                aria-pressed={selected === v.id}
                className={cn(
                  "flex w-full justify-between gap-2 p-2 text-left text-sm",
                  selected === v.id ? "bg-accent" : "hover:bg-muted",
                )}
              >
                <span>
                  {formatDateTime(v.at, lang)} · {v.device}
                  {v.current ? ` · ${t("history.current")}` : ""}
                </span>
                <span className="text-muted-foreground">{formatBytes(v.size, lang)}</span>
              </button>
            </li>
          ))}
        </ul>
        {content.data && (
          <section aria-label={t("history.preview")} className="space-y-2">
            {content.data.text !== null ? (
              <pre className="bg-muted max-h-64 overflow-auto rounded p-3 text-sm whitespace-pre-wrap">
                {content.data.text}
              </pre>
            ) : content.data.previewUrl ? (
              <img
                src={content.data.previewUrl}
                alt={t("history.preview")}
                className="max-h-64 rounded"
              />
            ) : (
              <p className="text-muted-foreground text-sm">{t("history.noPreview")}</p>
            )}
            {chosen && !chosen.current && !confirming && (
              <Button onClick={() => setConfirming(true)}>{t("history.restore")}</Button>
            )}
            {chosen && !chosen.current && confirming && (
              <div className="bg-muted space-y-2 rounded-lg p-3">
                <p className="text-sm">{t("history.restoreHint")}</p>
                <div className="flex gap-2">
                  <Button disabled={restore.isPending} onClick={() => restore.mutate(chosen.id)}>
                    {t("history.restoreConfirm")}
                  </Button>
                  <Button variant="outline" onClick={() => setConfirming(false)}>
                    {t("vaultSettings.cancel")}
                  </Button>
                </div>
              </div>
            )}
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
