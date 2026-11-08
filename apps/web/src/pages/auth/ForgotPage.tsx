import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { TextField } from "../../components/TextField.js";
import { Button } from "../../components/ui/button.js";
import { AuthCard, ErrorText } from "./AuthCard.js";

export function ForgotPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<"sent" | "noSmtp" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const r = await api.forgot(email);
      setResult(r.smtp ? "sent" : "noSmtp");
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t("auth.forgot.title")}>
      {result ? (
        <p role="status">{result === "sent" ? t("auth.forgot.sent") : t("auth.forgot.noSmtp")}</p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <p className="text-muted-foreground text-sm">{t("auth.forgot.intro")}</p>
          <TextField
            label={t("auth.forgot.email")}
            value={email}
            onChange={setEmail}
            type="email"
            autoComplete="email"
            required
          />
          <ErrorText>{error}</ErrorText>
          <Button type="submit" className="w-full" disabled={busy}>
            {t("auth.forgot.submit")}
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
