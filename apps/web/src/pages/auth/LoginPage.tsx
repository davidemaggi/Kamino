import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { ApiError } from "../../api/http.js";
import { PasswordField } from "../../components/PasswordField.js";
import { TextField } from "../../components/TextField.js";
import { Button } from "../../components/ui/button.js";
import { loginRoute } from "../../router.js";
import { AuthCard, ErrorText } from "./AuthCard.js";

export function LoginPage() {
  const { t } = useTranslation();
  const { redirect } = loginRoute.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const done = async () => {
    await qc.invalidateQueries();
    await navigate({ to: redirect });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (challenge === null) {
        const r = await api.login(username, password);
        setPassword("");
        if (r.status === "totp_required") setChallenge(r.challengeId);
        else await done();
      } else {
        await api.loginTotp(challenge, code.trim());
        await done();
      }
    } catch (err) {
      setPassword("");
      setCode("");
      if (err instanceof ApiError && err.code === "challenge_expired") setChallenge(null);
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={challenge === null ? t("auth.login.title") : t("auth.login.totpTitle")}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        {challenge === null ? (
          <>
            <TextField
              label={t("auth.login.username")}
              value={username}
              onChange={setUsername}
              autoComplete="username"
              required
            />
            <PasswordField
              label={t("auth.login.password")}
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
            />
          </>
        ) : (
          <>
            {!recovery && (
              <p className="text-muted-foreground text-sm">{t("auth.login.totpHint")}</p>
            )}
            <TextField
              label={recovery ? t("auth.login.recoveryCode") : t("auth.login.code")}
              value={code}
              onChange={setCode}
              autoComplete="one-time-code"
              {...(recovery ? {} : { inputMode: "numeric" as const, maxLength: 6 })}
            />
            <button
              type="button"
              className="text-link text-sm underline"
              onClick={() => setRecovery((r) => !r)}
            >
              {recovery ? t("auth.login.useTotp") : t("auth.login.useRecovery")}
            </button>
          </>
        )}
        <ErrorText>{error}</ErrorText>
        <Button type="submit" className="w-full" disabled={busy}>
          {challenge === null ? t("auth.login.submit") : t("auth.login.verify")}
        </Button>
        {challenge === null && (
          <Link to="/forgot" className="text-link block text-center text-sm underline">
            {t("auth.login.forgot")}
          </Link>
        )}
      </form>
    </AuthCard>
  );
}
