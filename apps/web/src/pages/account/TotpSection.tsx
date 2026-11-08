import type { Me } from "@kamino/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { PasswordField } from "../../components/PasswordField.js";
import { RecoveryCodes } from "../../components/RecoveryCodes.js";
import { Button } from "../../components/ui/button.js";
import { ErrorText } from "../auth/AuthCard.js";
import { TotpSetupPage } from "../TotpSetupPage.js";
import { SectionCard } from "./SectionCard.js";

type Mode = "idle" | "enable" | "disable" | "regenerate";

export function TotpSection({ me }: { me: Me }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>("idle");
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (mode === "disable") await api.totpDisable(password);
      if (mode === "regenerate")
        setCodes((await api.regenerateRecoveryCodes(password)).recoveryCodes);
      await qc.invalidateQueries({ queryKey: ["me"] });
      setMode("idle");
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setPassword("");
    }
  };

  if (mode === "enable") {
    return (
      <SectionCard title={t("account.totp.title")}>
        <TotpSetupPage onDone={() => setMode("idle")} />
      </SectionCard>
    );
  }

  return (
    <SectionCard title={t("account.totp.title")}>
      <p>{me.totpEnabled ? t("account.totp.on") : t("account.totp.off")}</p>
      {codes && (
        <>
          <p role="status">{t("account.totp.newCodes")}</p>
          <RecoveryCodes codes={codes} />
        </>
      )}
      {mode === "idle" ? (
        <div className="flex flex-wrap gap-2">
          {!me.totpEnabled && (
            <Button onClick={() => setMode("enable")}>{t("account.totp.enable")}</Button>
          )}
          {me.totpEnabled && (
            <Button variant="outline" onClick={() => setMode("regenerate")}>
              {t("account.totp.regenerate")}
            </Button>
          )}
          {me.totpEnabled && me.role !== "admin" && (
            <Button variant="outline" onClick={() => setMode("disable")}>
              {t("account.totp.disable")}
            </Button>
          )}
        </div>
      ) : (
        <form onSubmit={(e) => void confirm(e)} className="space-y-3">
          <PasswordField
            label={t("account.totp.confirmPassword")}
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
          <div className="flex gap-2">
            <Button type="submit">{t("account.totp.confirm")}</Button>
            <Button type="button" variant="ghost" onClick={() => setMode("idle")}>
              {t("account.totp.cancel")}
            </Button>
          </div>
        </form>
      )}
      <ErrorText>{error}</ErrorText>
      {me.role === "admin" && (
        <p className="text-muted-foreground text-sm">{t("account.totp.adminNote")}</p>
      )}
    </SectionCard>
  );
}
