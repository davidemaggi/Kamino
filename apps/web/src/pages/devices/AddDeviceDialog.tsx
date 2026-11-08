import type { PairingOffer, PairingState, Vault } from "@kamino/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { renderSVG } from "uqr";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { ApiError } from "../../api/http.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";

type Result = "approved" | "denied" | "expired" | "closed" | null;

/** Origin side of pairing from the web (protocol §10, spec §4.4). */
export function AddDeviceDialog({
  open,
  onOpenChange,
  vaults,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  vaults: Vault[];
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [vaultId, setVaultId] = useState<string | null>(vaults.length === 1 ? vaults[0]!.id : null);
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [state, setState] = useState<PairingState | null>(null);
  const [result, setResult] = useState<Result>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const alive = useRef(false);

  // Start/stop with the dialog; nothing is applied after close.
  useEffect(() => {
    if (!open || !vaultId) return;
    alive.current = true;
    let current: PairingOffer | null = null;
    void api.startPairing(vaultId).then(
      (o) => {
        if (!alive.current) return void api.cancelPairing(o.pairingId).catch(() => undefined);
        current = o;
        setOffer(o);
      },
      (err: unknown) => alive.current && toast.error(errorMessage(err, t)),
    );
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (!current) return;
      const id = current.pairingId;
      void api.pairing(id).then(
        (s) => {
          if (!alive.current || current?.pairingId !== id) return;
          setState(s);
          if (s.status === "expired") setResult("expired");
        },
        () => undefined,
      );
    }, 2000);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      if (current) void api.cancelPairing(current.pairingId).catch(() => undefined);
      setOffer(null);
      setState(null);
      setResult(null);
    };
  }, [open, vaultId, t]);

  const answer = async (approve: boolean) => {
    if (!offer || busy) return;
    setBusy(true);
    try {
      await (approve ? api.approvePairing(offer.pairingId) : api.denyPairing(offer.pairingId));
      if (alive.current) setResult(approve ? "approved" : "denied");
      await qc.invalidateQueries();
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && err.code === "pairing_closed") setResult("closed");
      else toast.error(errorMessage(err, t));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const left = offer ? Math.max(0, Math.ceil((Date.parse(offer.expiresAt) - now) / 1000)) : 0;
  const leftText = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  const request = state?.status === "requested" ? state.request : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {request && !result
              ? t("pairing.requestTitle", { name: request.deviceName })
              : t("pairing.title")}
          </DialogTitle>
        </DialogHeader>
        {!vaultId ? (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("pairing.chooseVault")}</legend>
            {vaults.map((v) => (
              <Button
                key={v.id}
                variant="outline"
                className="w-full"
                onClick={() => setVaultId(v.id)}
              >
                {v.name}
              </Button>
            ))}
          </fieldset>
        ) : result ? (
          <div className="space-y-3">
            <p role="status">{t(`pairing.${result}`)}</p>
            <Button onClick={() => onOpenChange(false)}>{t("pairing.close")}</Button>
          </div>
        ) : request ? (
          <div className="space-y-3">
            <p className="text-muted-foreground text-sm">
              {t("pairing.requestMeta", {
                platform: request.platform,
                version: request.pluginVersion,
              })}
            </p>
            <p
              className="bg-muted rounded-lg py-3 text-center font-mono text-3xl tracking-[0.3em]"
              aria-label={request.code.split("").join(" ")}
            >
              {request.code}
            </p>
            <p className="text-sm">{t("pairing.requestHint")}</p>
            <div className="flex gap-2">
              <Button disabled={busy} onClick={() => void answer(true)}>
                {t("pairing.approve")}
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => void answer(false)}>
                {t("pairing.deny")}
              </Button>
            </div>
          </div>
        ) : offer ? (
          <div className="space-y-3">
            <p className="text-sm">{t("pairing.intro")}</p>
            <img
              src={`data:image/svg+xml,${encodeURIComponent(renderSVG(offer.link, { border: 2, whiteColor: "#ffffff", blackColor: "#000000" }))}`}
              alt={t("pairing.qrAlt")}
              width={220}
              height={220}
              className="mx-auto rounded-md"
            />
            <Label htmlFor="pairing-link">{t("pairing.link")}</Label>
            <Input id="pairing-link" readOnly value={offer.link} className="font-mono text-xs" />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(offer.link)
                    .then(() => toast(t("pairing.copied")))
                }
              >
                {t("pairing.copy")}
              </Button>
              <span className="text-muted-foreground text-sm">
                {t("pairing.validFor", { left: leftText })}
              </span>
            </div>
            <p className="text-muted-foreground text-sm" aria-live="polite">
              {t("pairing.waiting")}
            </p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
