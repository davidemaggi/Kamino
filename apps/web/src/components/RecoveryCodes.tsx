import { PRODUCT_SLUG } from "@kamino/brand";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "./ui/button.js";
import { Checkbox } from "./ui/checkbox.js";
import { Label } from "./ui/label.js";

export function RecoveryCodes({
  codes,
  ack,
  onAck,
}: {
  codes: string[];
  ack?: boolean;
  onAck?: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const text = codes.join("\n");
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: "text/plain" }));
    const a = Object.assign(document.createElement("a"), {
      href: url,
      download: `${PRODUCT_SLUG}-recovery-codes.txt`,
    });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3">
      <ul className="bg-muted grid grid-cols-2 gap-2 rounded-lg p-3 font-mono text-sm">
        {codes.map((c) => (
          <li key={c} data-testid="recovery-code">
            {c}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            void navigator.clipboard?.writeText(text).then(() => toast(t("auth.totp.copied")))
          }
        >
          {t("auth.totp.copy")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={download}>
          {t("auth.totp.download")}
        </Button>
      </div>
      {onAck && (
        <div className="flex items-center gap-2">
          <Checkbox id={id} checked={!!ack} onCheckedChange={(v) => onAck(v === true)} />
          <Label htmlFor={id}>{t("auth.totp.ack")}</Label>
        </div>
      )}
    </div>
  );
}
