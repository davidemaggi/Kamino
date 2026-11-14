import { CONFIG_CATEGORIES, type SyncSettings } from "@kamino/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { Label } from "../../components/ui/label.js";

/**
 * The vault defaults every device follows unless it chose its own (plugin: "Use the vault
 * settings"). Two forms on one query: each saves the whole settings, changing only its part.
 */
function useSyncSettings(vaultId: string) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const key = ["vault-sync-settings", vaultId];
  const q = useQuery({ queryKey: key, queryFn: () => api.vaultSyncSettings(vaultId) });
  const [busy, setBusy] = useState(false);
  const save = async (patch: Partial<SyncSettings>) => {
    if (busy || !q.data) return;
    setBusy(true);
    try {
      qc.setQueryData(key, await api.setVaultSyncSettings(vaultId, { ...q.data, ...patch }));
      toast(t("vaultSettings.saved"));
    } catch (err) {
      toast.error(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };
  return { data: q.data, busy, save };
}

/** Exclusions: notes and attachments are always synced, except what matches here. */
export function VaultSyncExclusions({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const { data, busy, save } = useSyncSettings(vaultId);
  const [patterns, setPatterns] = useState("");
  useEffect(() => {
    if (data) setPatterns(data.patterns.join("\n"));
  }, [data]);
  if (!data) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save({
      patterns: [...new Set(patterns.split("\n").map((p) => p.trim()))].filter(Boolean),
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-muted-foreground text-sm">{t("vaultSettings.syncHint")}</p>
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
      <Button type="submit" disabled={busy}>
        {t("vaultSettings.syncSaveExclusions")}
      </Button>
    </form>
  );
}

/**
 * The Obsidian configuration folder (beta, ADR-0018): in the danger zone, because a wrong list
 * of plugins or settings reaches every device. Turning a category on asks first.
 */
export function VaultConfigSync({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const { data, busy, save } = useSyncSettings(vaultId);
  const [draft, setDraft] = useState<SyncSettings["config"] | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (data) setDraft(data.config);
  }, [data]);
  if (!data || !draft) return null;

  const turnsOn = CONFIG_CATEGORIES.some((c) => draft[c] && !data.config[c]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (turnsOn) setConfirm(true);
    else void save({ config: draft });
  };

  return (
    <>
      <form onSubmit={submit} className="space-y-3">
        <fieldset className="space-y-2">
          <legend className="mb-2 flex items-center gap-2 text-sm font-medium">
            {t("vaultSettings.syncConfig")}
            <Badge variant="outline">{t("vaultSettings.syncBeta")}</Badge>
          </legend>
          <p className="text-muted-foreground text-sm">{t("vaultSettings.syncConfigRisk")}</p>
          {CONFIG_CATEGORIES.map((c) => (
            <div key={c} className="flex items-center gap-2">
              <Checkbox
                id={`sync-${c}`}
                checked={draft[c]}
                onCheckedChange={(v) => setDraft({ ...draft, [c]: v === true })}
              />
              <Label htmlFor={`sync-${c}`} className="font-normal">
                {t(`vaultSettings.syncCategories.${c}`)}
              </Label>
            </div>
          ))}
          <p className="text-muted-foreground text-xs">{t("vaultSettings.syncPluginsHint")}</p>
        </fieldset>
        <p className="text-muted-foreground text-sm">{t("vaultSettings.syncReload")}</p>
        <Button type="submit" variant="outline" disabled={busy}>
          {t("vaultSettings.syncSaveConfig")}
        </Button>
      </form>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("vaultSettings.syncConfigConfirmTitle")}
        text={t("vaultSettings.syncConfigConfirmText")}
        confirmText={t("vaultSettings.syncConfigConfirm")}
        cancelText={t("vaultSettings.cancel")}
        destructive
        busy={busy}
        onConfirm={() => {
          setConfirm(false);
          void save({ config: draft });
        }}
      />
    </>
  );
}
