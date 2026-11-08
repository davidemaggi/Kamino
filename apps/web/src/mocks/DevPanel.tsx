import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/button.js";
import { db, resetDb, signInAs } from "./db.js";
import { seedUserData, simulatePairingRequest, simulateStaleNext } from "./userdata.js";

/** Dev only: floating panel to drive the fake data (spec §6). */
export default function DevPanel({ onChange }: { onChange: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [smtp, setSmtp] = useState(db.smtp);
  const act = (fn: () => void) => () => {
    fn();
    onChange();
  };
  return (
    <div data-msw="true" className="fixed right-4 bottom-4 z-50 text-sm">
      {open && (
        <div className="bg-card mb-2 flex w-56 flex-col gap-2 rounded-lg border p-3 shadow-lg">
          <Button size="sm" variant="outline" onClick={act(() => resetDb())}>
            {t("dev.reset")}
          </Button>
          <Button size="sm" variant="outline" onClick={act(() => resetDb("empty"))}>
            {t("dev.empty")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={act(() => {
              db.smtp = !db.smtp;
              setSmtp(db.smtp);
            })}
          >
            {smtp ? t("dev.smtpOn") : t("dev.smtpOff")}
          </Button>
          <Button size="sm" variant="outline" onClick={act(() => simulatePairingRequest())}>
            {t("dev.pairingRequest")}
          </Button>
          <Button size="sm" variant="outline" onClick={act(() => simulateStaleNext())}>
            {t("dev.staleNext")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={act(() => seedUserData("quota-almost-full"))}
          >
            {t("dev.quotaFull")}
          </Button>
          {["admin", "demo", "newadmin", "reset"].map((u) => (
            <Button key={u} size="sm" variant="ghost" onClick={act(() => signInAs(u))}>
              {t("dev.signInAs", { user: u })}
            </Button>
          ))}
        </div>
      )}
      <Button size="sm" onClick={() => setOpen((o) => !o)}>
        {t("dev.panel")}
      </Button>
    </div>
  );
}
