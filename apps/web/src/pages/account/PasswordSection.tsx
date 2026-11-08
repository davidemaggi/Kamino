import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { newPasswordError } from "../../components/newPassword.js";
import { PasswordField } from "../../components/PasswordField.js";
import { Button } from "../../components/ui/button.js";
import { ErrorText } from "../auth/AuthCard.js";
import { SectionCard } from "./SectionCard.js";

export function PasswordSection() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const pwError = newPasswordError(next, repeat, t);
    if (pwError) return setError(pwError);
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await api.changePassword(current, next);
      setDone(true);
      setCurrent("");
      setNext("");
      setRepeat("");
    } catch (err) {
      setError(errorMessage(err, t));
      setCurrent("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard title={t("account.password.title")}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <PasswordField
          label={t("account.password.current")}
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
        />
        <PasswordField
          label={t("auth.password.new")}
          value={next}
          onChange={setNext}
          autoComplete="new-password"
        />
        <PasswordField
          label={t("auth.password.repeat")}
          value={repeat}
          onChange={setRepeat}
          autoComplete="new-password"
        />
        <ErrorText>{error}</ErrorText>
        {done && (
          <p role="status" className="text-status-safe text-sm">
            {t("account.password.done")}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          {t("account.password.save")}
        </Button>
      </form>
    </SectionCard>
  );
}
