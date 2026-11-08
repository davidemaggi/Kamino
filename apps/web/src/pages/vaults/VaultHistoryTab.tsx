import type { Vault } from "@kamino/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { formatAgo, formatBytes, formatDateTime } from "../../lib/format.js";
import { FileHistoryDialog } from "./FileHistoryDialog.js";

export function VaultHistoryTab({ vault }: { vault: Vault }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const lang = i18n.language;
  const [q, setQ] = useState("");
  const [fileId, setFileId] = useState<string | null>(null);
  const files = useQuery({
    queryKey: ["files", vault.id, q],
    queryFn: () => api.files(vault.id, q),
  });
  const trash = useQuery({ queryKey: ["trash", vault.id], queryFn: () => api.trash(vault.id) });
  const restore = useMutation({
    mutationFn: (id: string) => api.restoreTrash(id),
    onSuccess: () => {
      toast(t("history.fileRestored"));
      void qc.invalidateQueries({ queryKey: ["trash", vault.id] });
    },
    onError: (err) => toast.error(errorMessage(err, t)),
  });

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="history-search">{t("history.search")}</Label>
        <Input id="history-search" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="bg-card divide-y rounded-xl border">
          {files.data?.files.length === 0 && (
            <li className="text-muted-foreground p-3 text-sm">{t("history.noFiles")}</li>
          )}
          {files.data?.files.map((f) => (
            <li key={f.fileId}>
              <button
                type="button"
                onClick={() => setFileId(f.fileId)}
                className="hover:bg-muted flex w-full flex-wrap justify-between gap-2 p-3 text-left"
              >
                <span className="font-medium break-all">{f.path}</span>
                <span className="text-muted-foreground text-sm">
                  {t("history.versions", { count: f.versions })} ·{" "}
                  {t("history.changed", { when: formatAgo(f.lastChangedAt, lang) })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <section aria-label={t("history.trash")} className="space-y-2">
        <h2 className="font-serif text-lg font-semibold">{t("history.trash")}</h2>
        <p className="text-muted-foreground text-sm">{t("history.trashHint")}</p>
        <ul className="bg-card divide-y rounded-xl border">
          {trash.data?.items.length === 0 && (
            <li className="text-muted-foreground p-3 text-sm">{t("history.trashEmpty")}</li>
          )}
          {trash.data?.items.map((item) => (
            <li key={item.fileId} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <span>
                <span className="font-medium break-all">{item.path}</span>
                <span className="text-muted-foreground block text-sm">
                  {t("history.deletedOn", {
                    when: formatDateTime(item.deletedAt, lang),
                    expires: formatDateTime(item.expiresAt, lang),
                  })}{" "}
                  · {formatBytes(item.size, lang)}
                </span>
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={restore.isPending}
                onClick={() => restore.mutate(item.fileId)}
              >
                {t("history.restoreFile")}
              </Button>
            </li>
          ))}
        </ul>
      </section>
      <FileHistoryDialog fileId={fileId} onOpenChange={(o) => !o && setFileId(null)} />
    </div>
  );
}
