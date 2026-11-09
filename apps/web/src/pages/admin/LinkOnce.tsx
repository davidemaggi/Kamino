import { useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";

/** A one-time link (activation/reset): shown once, copyable. */
export function LinkOnce({ link, hint }: { link: string; hint: string }) {
  const { t } = useTranslation();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      // navigator.clipboard is missing on plain HTTP (e.g. a LAN install).
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(link);
      toast(t("admin.create.copied"));
    } catch {
      input.current?.select();
      toast.error(t("admin.create.copyFailed"));
    }
  };
  return (
    <div className="space-y-2">
      <p className="text-sm">{hint}</p>
      <Label htmlFor={id}>{t("admin.create.link")}</Label>
      <Input
        ref={input}
        id={id}
        readOnly
        value={link}
        onFocus={(e) => e.currentTarget.select()}
        className="font-mono text-xs"
      />
      <Button size="sm" variant="outline" onClick={() => void copy()}>
        {t("admin.create.copy")}
      </Button>
    </div>
  );
}
