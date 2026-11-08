import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { newPasswordError } from "../../components/newPassword.js";
import { PasswordField } from "../../components/PasswordField.js";
import { Button } from "../../components/ui/button.js";
import { resetRoute } from "../../router.js";
import { AuthCard, ErrorText } from "./AuthCard.js";

export function ResetPage() {
  const { t } = useTranslation();
  const { token } = resetRoute.useParams();
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const pwError = newPasswordError(password, repeat, t);
    if (pwError) return setError(pwError);
    setError(null);
    setBusy(true);
    try {
      await api.reset(token, password);
      setDone(true);
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t("auth.reset.title")}>
      {done ? (
        <p role="status">{t("auth.reset.done")}</p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <PasswordField
            label={t("auth.password.new")}
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
          />
          <PasswordField
            label={t("auth.password.repeat")}
            value={repeat}
            onChange={setRepeat}
            autoComplete="new-password"
          />
          <ErrorText>{error}</ErrorText>
          <Button type="submit" className="w-full" disabled={busy}>
            {t("auth.reset.submit")}
          </Button>
        </form>
      )}
      <Link
        to="/login"
        search={{ redirect: "/" }}
        className="text-link mt-4 block text-center text-sm underline"
      >
        {t("auth.login.back")}
      </Link>
    </AuthCard>
  );
}
