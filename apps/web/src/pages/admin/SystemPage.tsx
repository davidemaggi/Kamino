import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { adminSystemRoute, SYSTEM_TABS, type SystemTab } from "../../router.js";
import { AuditTab } from "./AuditTab.js";
import { ConfigTab } from "./ConfigTab.js";
import { HealthTab } from "./HealthTab.js";

export function SystemPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("admin.system.title"));
  const { tab } = adminSystemRoute.useSearch();
  const navigate = useNavigate();
  const select = (next: SystemTab) =>
    void navigate({ to: "/admin/system", search: { tab: next }, replace: true });
  return (
    <div className="space-y-4">
      <h1 className="font-serif text-2xl font-semibold">{t("admin.system.title")}</h1>
      <div
        role="tablist"
        aria-label={t("admin.system.title")}
        className="flex flex-wrap gap-1 border-b"
      >
        {SYSTEM_TABS.map((id) => (
          <button
            key={id}
            role="tab"
            id={`system-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="system-tabpanel"
            onClick={() => select(id)}
            className={
              tab === id
                ? "px-3 py-2 text-sm font-semibold shadow-[inset_0_-2px_0_var(--link)]"
                : "text-muted-foreground px-3 py-2 text-sm"
            }
          >
            {t(`admin.system.tabs.${id}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="system-tabpanel" aria-labelledby={`system-tab-${tab}`}>
        {tab === "config" && <ConfigTab />}
        {tab === "health" && <HealthTab />}
        {tab === "audit" && <AuditTab />}
      </div>
    </div>
  );
}
