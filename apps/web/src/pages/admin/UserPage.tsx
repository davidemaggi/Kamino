import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { LevelBadge } from "../../components/status/LevelBadge.js";
import { TextField } from "../../components/TextField.js";
import { Button } from "../../components/ui/button.js";
import { formatBytes, formatDateTime } from "../../lib/format.js";
import { adminUserRoute } from "../../router.js";
import { ErrorText } from "../auth/AuthCard.js";
import { LinkOnce } from "./LinkOnce.js";

const GB = 1024 ** 3;
type Dialog = "block" | "unblock" | "reset" | "delete" | null;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bg-card space-y-3 rounded-xl border p-4">
      <h2 className="font-serif text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function UserPage() {
  const { t, i18n } = useTranslation();
  const { userId } = adminUserRoute.useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const lang = i18n.language;
  const user = useQuery({ queryKey: ["admin-user", userId], queryFn: () => api.adminUser(userId) });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me }).data;
  const smtp =
    useQuery({ queryKey: ["admin-config"], queryFn: api.adminConfig }).data?.smtpConfigured ??
    false;
  const u = user.data;
  useDocumentTitle(u?.username ?? t("admin.users.title"));
  const [unlimited, setUnlimited] = useState(true);
  const [gb, setGb] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [resetLink, setResetLink] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [sendZip, setSendZip] = useState(false);
  useEffect(() => {
    if (!u) return;
    setUnlimited(u.quotaBytes === null);
    setGb(u.quotaBytes === null ? "" : String(Math.round((u.quotaBytes / GB) * 10) / 10));
    setRole(u.role);
  }, [u?.id]); // only when another user is loaded

  if (user.isError) return <p>{t("admin.user.notFound")}</p>;
  if (!u) return null;
  const self = me?.id === u.id;
  const quotaBytes = unlimited ? null : Math.max(0, Number(gb) * GB);
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["admin-user", userId] }),
      qc.invalidateQueries({ queryKey: ["admin-users"] }),
    ]);
  const act = async (
    fn: () => Promise<unknown>,
    done?: string,
    onError?: (msg: string) => void,
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      if (done) toast(t(done));
      await refresh();
    } catch (err) {
      if (onError) onError(errorMessage(err, t));
      else toast.error(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-serif text-2xl font-semibold">{u.username}</h1>
        <LevelBadge level={u.syncLevel} />
      </div>
      <p className="text-muted-foreground text-sm">{t("admin.users.privacy")}</p>
      <dl className="bg-card grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-xl border p-4 text-sm">
        {(
          [
            [t("admin.users.email"), u.email],
            [t("admin.users.status"), t(`admin.users.statuses.${u.status}`)],
            [t("admin.user.totp"), u.totpEnabled ? t("admin.user.yes") : t("admin.user.no")],
            [t("admin.user.created"), formatDateTime(u.createdAt, lang)],
            [
              t("admin.users.lastLogin"),
              u.lastLoginAt ? formatDateTime(u.lastLoginAt, lang) : t("admin.users.never"),
            ],
            [
              t("admin.users.space"),
              `${formatBytes(u.usedBytes, lang)} / ${u.quotaBytes === null ? t("admin.users.unlimited") : formatBytes(u.quotaBytes, lang)}`,
            ],
            [t("admin.users.vaults"), String(u.vaultCount)],
            [t("admin.users.devices"), String(u.deviceCount)],
          ] as Array<[string, string]>
        ).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>

      <Section title={t("admin.user.quota")}>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={unlimited}
            onChange={(e) => setUnlimited(e.target.checked)}
          />
          {t("admin.user.quotaUnlimited")}
        </label>
        {!unlimited && (
          <TextField
            label={t("admin.user.quotaGb")}
            value={gb}
            onChange={setGb}
            type="number"
            min={0}
            step={0.1}
          />
        )}
        {quotaBytes !== null && quotaBytes < u.usedBytes && (
          <p className="bg-status-attention-surface text-status-attention rounded-md p-2 text-sm">
            {t("admin.user.quotaBelow")}
          </p>
        )}
        <Button
          disabled={busy || (!unlimited && gb === "")}
          onClick={() => void act(() => api.updateUser(u.id, { quotaBytes }), "admin.user.saved")}
        >
          {t("admin.user.save")}
        </Button>
      </Section>

      <Section title={t("admin.users.role")}>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">{t("admin.users.role")}</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "user" | "admin")}
            className="bg-background block rounded-md border px-2 py-1"
          >
            <option value="user">{t("admin.user.roles.user")}</option>
            <option value="admin">{t("admin.user.roles.admin")}</option>
          </select>
        </label>
        <ErrorText>{roleError}</ErrorText>
        <Button
          disabled={busy}
          onClick={() => {
            setRoleError(null);
            void act(() => api.updateUser(u.id, { role }), "admin.user.saved", setRoleError);
          }}
        >
          {t("admin.user.save")}
        </Button>
      </Section>

      <Section title={t("admin.user.reset")}>
        {resetLink ? (
          <LinkOnce link={resetLink} hint={t("admin.user.resetHint")} />
        ) : (
          <Button variant="outline" onClick={() => setDialog("reset")}>
            {t("admin.user.reset")}
          </Button>
        )}
      </Section>

      <Section title={t("admin.user.danger")}>
        {self ? (
          <p className="text-muted-foreground text-sm">{t("admin.user.self")}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {u.status === "blocked" ? (
              <Button variant="outline" onClick={() => setDialog("unblock")}>
                {t("admin.user.unblock")}
              </Button>
            ) : (
              u.status !== "deleting" && (
                <Button variant="outline" onClick={() => setDialog("block")}>
                  {t("admin.user.block")}
                </Button>
              )
            )}
            {u.status !== "deleting" && (
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirmName("");
                  setSendZip(false);
                  setDialog("delete");
                }}
              >
                {t("admin.user.delete")}
              </Button>
            )}
          </div>
        )}
      </Section>

      <ConfirmDialog
        open={dialog === "block"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t("admin.user.blockTitle", { name: u.username })}
        text={t("admin.user.blockText")}
        confirmText={t("admin.user.block")}
        cancelText={t("admin.user.cancel")}
        destructive
        busy={busy}
        onConfirm={() => void act(() => api.blockUser(u.id)).then(() => setDialog(null))}
      />
      <ConfirmDialog
        open={dialog === "unblock"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t("admin.user.unblockTitle", { name: u.username })}
        text={t("admin.user.unblockText")}
        confirmText={t("admin.user.unblock")}
        cancelText={t("admin.user.cancel")}
        busy={busy}
        onConfirm={() => void act(() => api.unblockUser(u.id)).then(() => setDialog(null))}
      />
      <ConfirmDialog
        open={dialog === "reset"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t("admin.user.resetTitle", { name: u.username })}
        text={t("admin.user.resetText")}
        confirmText={t("admin.user.generate")}
        cancelText={t("admin.user.cancel")}
        busy={busy}
        onConfirm={() =>
          void act(async () => setResetLink((await api.resetLink(u.id)).link)).then(() =>
            setDialog(null),
          )
        }
      />
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t("admin.user.deleteTitle", { name: u.username })}
        text={t("admin.user.deleteText")}
        confirmText={t("admin.user.deleteConfirm")}
        cancelText={t("admin.user.cancel")}
        destructive
        busy={busy || confirmName !== u.username}
        onConfirm={() =>
          void (async () => {
            if (busy) return;
            setBusy(true);
            try {
              await api.deleteUser(u.id, confirmName, sendZip);
              toast(t("admin.user.deleted"));
              setDialog(null);
              await navigate({ to: "/admin/users" });
              await qc.invalidateQueries({ queryKey: ["admin-users"] });
            } catch (err) {
              toast.error(errorMessage(err, t));
            } finally {
              setBusy(false);
            }
          })()
        }
      >
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            disabled={!smtp}
            checked={sendZip}
            onChange={(e) => setSendZip(e.target.checked)}
          />
          <span>
            {t("admin.user.sendZip")}
            {!smtp && (
              <span className="text-muted-foreground block">{t("admin.user.sendZipOff")}</span>
            )}
          </span>
        </label>
        <TextField
          label={t("admin.user.deleteConfirmLabel")}
          value={confirmName}
          onChange={setConfirmName}
          autoComplete="off"
        />
      </ConfirmDialog>
    </div>
  );
}
