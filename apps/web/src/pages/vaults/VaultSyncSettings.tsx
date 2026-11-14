import { CONFIG_CATEGORIES, type SyncSettings } from "@kamino/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { Label } from "../../components/ui/label.js";

/** The vault defaults every device follows unless it chose its own (plugin: "Use the vault settings"). */
export function VaultSyncSettings({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const key = ["vault-sync-settings", vaultId];
  const q = useQuery({ queryKey: key, queryFn: () => api.vaultSyncSettings(vaultId) });
  const [draft, setDraft] = useState<SyncSettings | null>(null);
  const [patterns, setPatterns] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    setDraft(q.data);
    setPatterns(q.data.patterns.join("\n"));
  }, [q.data]);

  if (!draft) return null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const body: SyncSettings = {
        config: draft.config,
        patterns: [...new Set(patterns.split("\n").map((p) => p.trim()))].filter(Boolean),
      };
      qc.setQueryData(key, await api.setVaultSyncSettings(vaultId, body));
      toast(t("vaultSettings.saved"));
    } catch (err) {
      toast.error(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void save(e)} className="space-y-4">
      <p className="text-muted-foreground text-sm">{t("vaultSettings.syncHint")}</p>
      <fieldset className="space-y-2">
        <legend className="mb-2 flex items-center gap-2 text-sm font-medium">
          {t("vaultSettings.syncConfig")}
          <Badge variant="outline">{t("vaultSettings.syncBeta")}</Badge>
        </legend>
        <p className="text-muted-foreground text-sm">{t("vaultSettings.syncBetaHint")}</p>
        {CONFIG_CATEGORIES.map((c) => (
          <div key={c} className="flex items-center gap-2">
            <Checkbox
              id={`sync-${c}`}
              checked={draft.config[c]}
              onCheckedChange={(v) =>
                setDraft({ ...draft, config: { ...draft.config, [c]: v === true } })
              }
            />
            <Label htmlFor={`sync-${c}`} className="font-normal">
              {t(`vaultSettings.syncCategories.${c}`)}
            </Label>
          </div>
        ))}
        <p className="text-muted-foreground text-xs">{t("vaultSettings.syncPluginsHint")}</p>
      </fieldset>
      <div className="space-y-1">
        <Label htmlFor="sync-patterns">{t("vaultSettings.syncExclusions")}</Label>
        <textarea
          id="sync-patterns"
          rows={5}
          value={patterns}
          onChange={(e) => setPatterns(e.target.value)}
          spellCheck={false}
          className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:ring-[3px]"
        />
        <p className="text-muted-foreground text-xs">{t("vaultSettings.syncExclusionsHint")}</p>
      </div>
      <p className="text-muted-foreground text-sm">{t("vaultSettings.syncReload")}</p>
      <Button type="submit" disabled={busy}>
        {t("vaultSettings.syncSave")}
      </Button>
    </form>
  );
}
