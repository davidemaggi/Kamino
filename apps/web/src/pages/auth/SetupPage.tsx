import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { newPasswordError } from "../../components/newPassword.js";
import { PasswordField } from "../../components/PasswordField.js";
import { TextField } from "../../components/TextField.js";
import { Button } from "../../components/ui/button.js";
import { AuthCard, ErrorText } from "./AuthCard.js";

export function SetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState({ token: "", username: "", email: "", password: "", repeat: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const pwError = newPasswordError(f.password, f.repeat, t);
    if (pwError) return setError(pwError);
    setBusy(true);
    setError(null);
    try {
      await api.setup({
        token: f.token.trim(),
        username: f.username,
        email: f.email,
        password: f.password,
      });
      await qc.invalidateQueries();
      await navigate({ to: "/account/totp-setup" });
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t("auth.setup.title")}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <p className="text-muted-foreground text-sm">{t("auth.setup.intro")}</p>
        <TextField
          label={t("auth.setup.token")}
          value={f.token}
          onChange={set("token")}
          autoComplete="off"
          required
        />
        <TextField
          label={t("auth.login.username")}
          value={f.username}
          onChange={set("username")}
          autoComplete="username"
          required
        />
        <TextField
          label={t("auth.setup.email")}
          value={f.email}
          onChange={set("email")}
          type="email"
          autoComplete="email"
          required
        />
        <PasswordField
          label={t("auth.password.new")}
          value={f.password}
          onChange={set("password")}
          autoComplete="new-password"
        />
        <PasswordField
          label={t("auth.password.repeat")}
          value={f.repeat}
          onChange={set("repeat")}
          autoComplete="new-password"
        />
        <ErrorText>{error}</ErrorText>
        <Button type="submit" className="w-full" disabled={busy}>
          {t("auth.setup.submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
