import type { BulkStrategy } from "@kamino/protocol";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";

export function BulkResolveDialog({
  open,
  onOpenChange,
  count,
  busy,
  onApply,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  count: number;
  busy: boolean;
  onApply: (s: BulkStrategy) => void;
}) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<BulkStrategy | null>(null);
  const options: Array<[BulkStrategy, string]> = [
    ["keep_mine", t("conflicts.bulkMine")],
    ["keep_incoming", t("conflicts.bulkIncoming")],
    ["keep_both", t("conflicts.bulkBoth")],
  ];
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setChoice(null);
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("conflicts.bulkTitle")}</DialogTitle>
        </DialogHeader>
        <div role="radiogroup" aria-label={t("conflicts.bulkTitle")} className="space-y-2">
          {options.map(([value, label]) => (
            <label key={value} className="flex items-center gap-2">
              <input
                type="radio"
                name="bulk"
                value={value}
                checked={choice === value}
                onChange={() => setChoice(value)}
              />
              {label}
            </label>
          ))}
        </div>
        <p className="text-muted-foreground text-sm">{t("conflicts.bulkAppliesTo", { count })}</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("conflicts.cancel")}
          </Button>
          <Button disabled={!choice || busy} onClick={() => choice && onApply(choice)}>
            {t("conflicts.bulkApply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
