import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { TextField } from "../../components/TextField.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { ErrorText } from "../auth/AuthCard.js";
import { LinkOnce } from "./LinkOnce.js";

export function CreateUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const smtp =
    useQuery({ queryKey: ["admin-config"], queryFn: api.adminConfig, enabled: open }).data
      ?.smtpConfigured ?? false;
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [delivery, setDelivery] = useState<"email" | "link">("link");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ link: string | null; email: string } | null>(null);

  const close = (o: boolean) => {
    if (!o) {
      setUsername("");
      setEmail("");
      setRole("user");
      setDelivery("link");
      setError(null);
      setDone(null);
    }
    onOpenChange(o);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.createUser({ username, email, role, delivery });
      setDone({ link: r.link, email });
      void qc.invalidateQueries({ queryKey: ["admin-users"] });
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin.create.title")}</DialogTitle>
        </DialogHeader>
        {done ? (
          <div className="space-y-3">
            {done.link ? (
              <LinkOnce link={done.link} hint={t("admin.create.linkHint")} />
            ) : (
              <p role="status">{t("admin.create.invited", { email: done.email })}</p>
            )}
            <Button onClick={() => close(false)}>{t("admin.create.done")}</Button>
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="space-y-3">
            <TextField
              label={t("admin.users.username")}
              value={username}
              onChange={setUsername}
              required
              autoComplete="off"
            />
            <TextField
              label={t("admin.users.email")}
              value={email}
              onChange={setEmail}
              type="email"
              required
              autoComplete="off"
            />
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
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">{t("admin.create.delivery")}</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="delivery"
                  disabled={!smtp}
                  checked={delivery === "email"}
                  onChange={() => setDelivery("email")}
                />
                {t("admin.create.byEmail")}
              </label>
              {!smtp && <p className="text-muted-foreground text-sm">{t("admin.create.noSmtp")}</p>}
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="delivery"
                  checked={delivery === "link"}
                  onChange={() => setDelivery("link")}
                />
                {t("admin.create.byLink")}
              </label>
            </fieldset>
            <ErrorText>{error}</ErrorText>
            <Button type="submit" disabled={busy}>
              {t("admin.create.submit")}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
