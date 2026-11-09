import { useId } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";

/** A one-time link (activation/reset): shown once, copyable. */
export function LinkOnce({ link, hint }: { link: string; hint: string }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="space-y-2">
      <p className="text-sm">{hint}</p>
      <Label htmlFor={id}>{t("admin.create.link")}</Label>
      <Input id={id} readOnly value={link} className="font-mono text-xs" />
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          void navigator.clipboard?.writeText(link).then(() => toast(t("admin.create.copied")))
        }
      >
        {t("admin.create.copy")}
      </Button>
    </div>
  );
}
