import type { VersionInfo } from "@kamino/protocol";
import { PRODUCT_NAME } from "@kamino/brand";
import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { fetchVersion } from "../api/client.js";
import { BrandMark } from "../app/BrandMark.js";
import { useDocumentTitle } from "../app/useDocumentTitle.js";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { formatDateTime } from "../lib/format.js";

type State = { status: "loading" } | { status: "error" } | { status: "ready"; info: VersionInfo };

/** The commit as `git log --oneline` shows it; anything that isn't a hash stays as it is. */
const shortCommit = (c: string) => (/^[0-9a-f]{12,}$/i.test(c) ? c.slice(0, 7) : c);

export function AboutPage() {
  const { t, i18n } = useTranslation();
  useDocumentTitle(t("about.title"));
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    fetchVersion(ctrl.signal).then(
      (info) => setState({ status: "ready", info }),
      () => {
        if (!ctrl.signal.aborted) setState({ status: "error" });
      },
    );
    return () => ctrl.abort();
  }, []);

  const rows = (info: VersionInfo): [string, string, boolean?][] => {
    const date = Number.isNaN(Date.parse(info.buildDate))
      ? info.buildDate
      : formatDateTime(info.buildDate, i18n.language);
    const { min, max } = info.protocol;
    return [
      [t("about.version"), info.version],
      [t("about.codename"), info.codename],
      [
        t("about.protocol"),
        min === max ? t("about.protocolOne", { v: min }) : t("about.protocolRange", { min, max }),
      ],
      [t("about.commit"), shortCommit(info.commit), true],
      [t("about.buildDate"), date],
    ];
  };

  const copy = (info: VersionInfo) => {
    const text = [
      `${PRODUCT_NAME} ${info.version} (${info.codename})`,
      `protocol ${info.protocol.min}-${info.protocol.max}`,
      `commit ${info.commit}`,
      `built ${info.buildDate}`,
    ].join("\n");
    // navigator.clipboard is missing on plain HTTP (e.g. a LAN install).
    if (!navigator.clipboard) {
      toast.error(t("about.copyFailed"));
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => toast.success(t("about.copied")),
      () => toast.error(t("about.copyFailed")),
    );
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-1">
        <h1 className="font-serif text-2xl font-semibold">{t("about.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("about.intro")}</p>
      </div>

      {state.status === "error" ? (
        <Alert variant="destructive">
          <AlertTitle>{t("about.error")}</AlertTitle>
          <AlertDescription>{t("about.errorHint")}</AlertDescription>
        </Alert>
      ) : (
        <section className="bg-card rounded-xl border">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b p-5">
            <BrandMark size={36} className="text-xl" />
            {state.status === "ready" && (
              <Button variant="outline" size="sm" onClick={() => copy(state.info)}>
                <Copy aria-hidden />
                {t("about.copy")}
              </Button>
            )}
          </div>

          {state.status === "loading" ? (
            <div className="space-y-4 p-5" role="status" aria-label={t("about.loading")}>
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="flex justify-between gap-6">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-24" />
                </div>
              ))}
            </div>
          ) : (
            <dl className="divide-y px-5">
              {rows(state.info).map(([label, value, mono]) => (
                <div
                  key={label}
                  className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3"
                >
                  <dt className="text-muted-foreground text-sm">{label}</dt>
                  <dd
                    className={
                      mono
                        ? "font-mono text-sm tabular-nums select-all"
                        : "text-sm font-medium tabular-nums"
                    }
                  >
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      )}
    </div>
  );
}
