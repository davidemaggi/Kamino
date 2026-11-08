import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { renderSVG } from "uqr";
import { api } from "../api/endpoints.js";
import { errorMessage } from "../api/errors.js";
import { useDocumentTitle } from "../app/useDocumentTitle.js";
import { RecoveryCodes } from "../components/RecoveryCodes.js";
import { TextField } from "../components/TextField.js";
import { Button } from "../components/ui/button.js";
import { ErrorText } from "./auth/AuthCard.js";

/** TOTP setup in three steps (spec §8.2). Mandatory for admins without TOTP. */
export function TotpSetupPage({ onDone }: { onDone?: () => void }) {
  const { t } = useTranslation();
  useDocumentTitle(t("auth.totp.title"));
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me }).data;
  const setup = useQuery({ queryKey: ["totp-setup"], queryFn: api.totpSetup, staleTime: Infinity });
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [ack, setAck] = useState(false);
  const confirm = useMutation({
    mutationFn: (c: string) => api.totpConfirm(c),
    onSuccess: (r) => setCodes(r.recoveryCodes),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    confirm.mutate(code.trim());
  };

  const finish = async () => {
    qc.removeQueries({ queryKey: ["totp-setup"] });
    await qc.invalidateQueries({ queryKey: ["me"] });
    if (onDone) onDone();
    else await navigate({ to: "/" });
  };

  return (
    <section className="max-w-lg space-y-5">
      <h1 className="font-serif text-2xl font-semibold">{t("auth.totp.title")}</h1>
      {me?.totpSetupRequired && (
        <p className="text-status-attention bg-status-attention-surface rounded-lg p-3 text-sm">
          {t("auth.totp.required")}
        </p>
      )}
      {codes === null ? (
        <>
          <p>{t("auth.totp.step1")}</p>
          {setup.data && (
            <>
              <img
                src={`data:image/svg+xml,${encodeURIComponent(renderSVG(setup.data.otpauthUrl, { border: 2, whiteColor: "#ffffff", blackColor: "#000000" }))}`}
                alt={t("auth.totp.qrAlt")}
                width={200}
                height={200}
                className="rounded-md"
              />
              <p className="text-muted-foreground text-sm">{t("auth.totp.secret")}</p>
              <code className="bg-muted block rounded p-2 font-mono text-sm break-all">
                {setup.data.secret}
              </code>
            </>
          )}
          <form onSubmit={submit} className="space-y-3">
            <p>{t("auth.totp.step2")}</p>
            <TextField
              label={t("auth.totp.code")}
              value={code}
              onChange={setCode}
              inputMode="numeric"
              maxLength={6}
              autoComplete="one-time-code"
            />
            <ErrorText>{confirm.isError ? errorMessage(confirm.error, t) : null}</ErrorText>
            <Button type="submit" disabled={confirm.isPending}>
              {t("auth.totp.verify")}
            </Button>
          </form>
        </>
      ) : (
        <>
          <p>{t("auth.totp.step3")}</p>
          <RecoveryCodes codes={codes} ack={ack} onAck={setAck} />
          <Button type="button" disabled={!ack} onClick={() => void finish()}>
            {t("auth.totp.finish")}
          </Button>
        </>
      )}
    </section>
  );
}
