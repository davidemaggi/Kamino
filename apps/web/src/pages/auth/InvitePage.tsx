import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { newPasswordError } from "../../components/newPassword.js";
import { PasswordField } from "../../components/PasswordField.js";
import { Button } from "../../components/ui/button.js";
import { inviteRoute } from "../../router.js";
import { AuthCard, ErrorText } from "./AuthCard.js";

export function InvitePage() {
  const { t } = useTranslation();
  const { token } = inviteRoute.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const invite = useQuery({ queryKey: ["invite", token], queryFn: () => api.invite(token) });
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
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
      await api.acceptInvite(token, password);
      await qc.invalidateQueries();
      await navigate({ to: "/" });
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t("auth.invite.title")}>
      {invite.isError ? (
        <>
          <ErrorText>{errorMessage(invite.error, t)}</ErrorText>
          <Link
            to="/login"
            search={{ redirect: "/" }}
            className="text-link mt-4 block text-center text-sm underline"
          >
            {t("auth.login.back")}
          </Link>
        </>
      ) : invite.data ? (
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <p className="text-muted-foreground text-sm">{t("auth.invite.intro", invite.data)}</p>
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
            {t("auth.invite.submit")}
          </Button>
        </form>
      ) : null}
    </AuthCard>
  );
}
