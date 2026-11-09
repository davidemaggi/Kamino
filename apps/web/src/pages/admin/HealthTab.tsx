import type { HealthCheck } from "@kamino/protocol";
import type { Level } from "@kamino/status";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { LEVEL_CLASSES } from "../../components/status/status-icons.js";
import { LevelBadge } from "../../components/status/LevelBadge.js";
import { formatAgo, formatBytes } from "../../lib/format.js";
import { cn } from "../../lib/utils.js";

const STATUS_LEVEL: Record<"ok" | "degraded" | "down", Level> = {
  ok: "safe",
  degraded: "attention",
  down: "blocked",
};
const CHECK_LEVEL: Record<HealthCheck["status"], Level> = {
  ok: "safe",
  warn: "attention",
  error: "blocked",
  off: "working",
};

export function HealthTab() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const health = useQuery({ queryKey: ["admin-health"], queryFn: api.health });
  if (health.isError) return <p role="alert">{errorMessage(health.error, t)}</p>;
  const h = health.data;
  if (!h) return null;
  const value = (c: HealthCheck) =>
    c.name === "disk" && c.value !== undefined
      ? t("admin.system.diskValue", { percent: Math.round(c.value * 100) })
      : c.name === "jobs" && c.value !== undefined
        ? t("admin.system.jobsValue", { count: c.value })
        : "";
  return (
    <div className="space-y-4">
      <section className="bg-card space-y-1 rounded-xl border p-4">
        <p
          className={cn(
            "inline-block rounded-full px-3 py-1 text-sm font-medium",
            LEVEL_CLASSES[STATUS_LEVEL[h.status]],
          )}
        >
          {t(`admin.system.status.${h.status}`)}
        </p>
        <p className="text-muted-foreground text-sm">
          {t("admin.system.version", { version: h.version, codename: h.codename })} ·{" "}
          {t("admin.system.uptime", {
            age: formatAgo(new Date(Date.now() - h.uptimeSeconds * 1000).toISOString(), lang),
          })}
        </p>
      </section>
      <ul className="bg-card divide-y rounded-xl border">
        {h.checks.map((c) => (
          <li
            key={c.name}
            className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"
          >
            <span>
              {t(`admin.system.checks.${c.name}`)}{" "}
              {value(c) && <span className="text-muted-foreground">· {value(c)}</span>}
            </span>
            <span
              className={cn(
                "rounded-full px-2.5 py-0.5 text-xs font-medium",
                LEVEL_CLASSES[CHECK_LEVEL[c.status]],
              )}
            >
              {t(`admin.system.checkStatus.${c.status}`)}
            </span>
          </li>
        ))}
      </ul>
      <section className="bg-card space-y-3 rounded-xl border p-4">
        <h2 className="font-serif text-lg font-semibold">{t("admin.system.totals")}</h2>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          {(
            [
              [t("admin.system.totalUsers"), String(h.totals.users)],
              [t("admin.system.totalVaults"), String(h.totals.vaults)],
              [t("admin.system.totalDevices"), String(h.totals.devices)],
              [t("admin.system.totalStorage"), formatBytes(h.totals.storageBytes, lang)],
            ] as Array<[string, string]>
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="text-lg font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
        <h3 className="text-sm font-medium">{t("admin.system.byLevel")}</h3>
        <ul className="flex flex-wrap gap-2">
          {(Object.entries(h.totals.devicesByLevel) as Array<[Level, number]>).map(([level, n]) => (
            <li key={level} className="flex items-center gap-1">
              <LevelBadge level={level} /> <span className="text-sm">{n}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
