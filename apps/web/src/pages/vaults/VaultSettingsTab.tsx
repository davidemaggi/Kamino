import type { Vault } from "@kamino/protocol";
import { PRODUCT_SLUG } from "@kamino/brand";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { TextField } from "../../components/TextField.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { formatDateTime } from "../../lib/format.js";
import { ErrorText } from "../auth/AuthCard.js";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-card space-y-3 rounded-xl border p-4">
      <h2 className="font-serif text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function VaultSettingsTab({ vault }: { vault: Vault }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const lang = i18n.language;
  const [name, setName] = useState(vault.name);
  const [retention, setRetention] = useState(String(vault.retentionDays));
  const [zipMode, setZipMode] = useState<"now" | "at">("now");
  const [zipAt, setZipAt] = useState("");
  const [zipError, setZipError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["vault", vault.id] }),
      qc.invalidateQueries({ queryKey: ["vaults"] }),
      qc.invalidateQueries({ queryKey: ["vaults-summary"] }),
    ]);

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
      if (done) toast(t(done));
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  };

  const download = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setZipError(null);
    setBusy("zip");
    try {
      const at = zipMode === "at" && zipAt ? new Date(zipAt).toISOString() : undefined;
      const blob = await api.downloadZip(vault.id, at);
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), {
        href: url,
        download: `${PRODUCT_SLUG}-${vault.name}.zip`,
      });
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setZipError(errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy("delete");
    try {
      await api.deleteVault(vault.id, confirmName);
      toast(t("vaultSettings.deleted"));
      setDeleteOpen(false);
      await qc.invalidateQueries();
      await navigate({ to: "/vaults" });
    } catch (err) {
      toast.error(errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <Section title={t("vaultSettings.rename")}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim())
              void run("name", () => api.updateVault(vault.id, { name }), "vaultSettings.renamed");
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="min-w-56 flex-1">
            <TextField label={t("vaultSettings.name")} value={name} onChange={setName} />
          </div>
          <Button type="submit" disabled={busy !== null}>
            {t("vaultSettings.rename")}
          </Button>
        </form>
      </Section>

      <Section title={t("vaultSettings.retention")}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              "retention",
              () => api.updateVault(vault.id, { retentionDays: Number(retention) }),
              "vaultSettings.saved",
            );
          }}
          className="space-y-2"
        >
          <Label htmlFor="retention">{t("vaultSettings.retention")}</Label>
          <p className="text-muted-foreground text-sm">
            {t("vaultSettings.retentionHint", { max: vault.maxRetentionDays })}
          </p>
          <div className="flex gap-2">
            <select
              id="retention"
              value={retention}
              onChange={(e) => setRetention(e.target.value)}
              className="bg-background rounded-md border px-2"
            >
              {[0, 7, 14, 30, 60, 90]
                .filter((d) => d <= vault.maxRetentionDays)
                .map((d) => (
                  <option key={d} value={d}>
                    {t("vaultSettings.days", { count: d })}
                  </option>
                ))}
            </select>
            <Button type="submit" disabled={busy !== null}>
              {t("vaultSettings.save")}
            </Button>
          </div>
        </form>
      </Section>

      <Section title={t("vaultSettings.zip")}>
        <form onSubmit={(e) => void download(e)} className="space-y-2">
          <div role="radiogroup" className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="zip"
                checked={zipMode === "now"}
                onChange={() => setZipMode("now")}
              />
              {t("vaultSettings.zipNow")}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="zip"
                checked={zipMode === "at"}
                onChange={() => setZipMode("at")}
              />
              {t("vaultSettings.zipAt")}
            </label>
          </div>
          {zipMode === "at" && (
            <div className="space-y-1">
              <Label htmlFor="zip-at">{t("vaultSettings.zipAtLabel")}</Label>
              <Input
                id="zip-at"
                type="datetime-local"
                value={zipAt}
                onChange={(e) => setZipAt(e.target.value)}
              />
              <p className="text-muted-foreground text-sm">
                {t("vaultSettings.zipHint", { from: formatDateTime(vault.historyFrom, lang) })}
              </p>
            </div>
          )}
          <ErrorText>{zipError}</ErrorText>
          <Button type="submit" disabled={busy !== null || (zipMode === "at" && !zipAt)}>
            {t("vaultSettings.download")}
          </Button>
        </form>
      </Section>

      <Section title={t("vaultSettings.danger")}>
        <Button
          variant="destructive"
          onClick={() => {
            setConfirmName("");
            setDeleteOpen(true);
          }}
        >
          {t("vaultSettings.delete")}
        </Button>
      </Section>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("vaultSettings.deleteTitle", { name: vault.name })}
        text={t("vaultSettings.deleteText")}
        confirmText={t("vaultSettings.deleteConfirm")}
        cancelText={t("vaultSettings.cancel")}
        destructive
        busy={busy === "delete" || confirmName !== vault.name}
        onConfirm={() => void remove()}
      >
        <TextField
          label={t("vaultSettings.deleteConfirmLabel")}
          value={confirmName}
          onChange={setConfirmName}
          autoComplete="off"
        />
      </ConfirmDialog>
    </div>
  );
}
