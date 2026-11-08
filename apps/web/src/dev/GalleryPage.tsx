import {
  DEFAULT_THRESHOLDS,
  describeStatus,
  exampleSnapshots,
  formatStatusMessage,
} from "@kamino/status";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { StatusBadge, StatusDot, useLang } from "@/components/status/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ThemeSwitcher } from "@/theme/ThemeSwitcher";

const TOKENS = [
  "background",
  "card",
  "foreground",
  "muted",
  "muted-foreground",
  "primary",
  "link",
  "border",
  "status-safe",
  "status-working",
  "status-attention",
  "status-decision",
  "status-blocked",
];

function Pane({ theme, now }: { theme: "light" | "dark"; now: number }) {
  const { t } = useTranslation();
  const lang = useLang();
  const examples = useMemo(() => exampleSnapshots(now), [now]);
  const device = describeStatus(examples[0]!.snapshot, DEFAULT_THRESHOLDS, now);
  return (
    <section className={`${theme} bg-background text-foreground space-y-6 rounded-xl p-6`}>
      <h2 className="font-serif text-xl font-semibold">{theme}</h2>

      <div>
        <h3 className="mb-2 text-sm font-semibold">{t("gallery.palette")}</h3>
        <ul className="grid grid-cols-4 gap-2 text-xs">
          {TOKENS.map((tok) => (
            <li key={tok} className="flex items-center gap-2">
              <span className="size-6 rounded-md border" style={{ background: `var(--${tok})` }} />
              <code>{tok}</code>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t("gallery.typography")}</h3>
        <p className="font-serif text-2xl font-semibold">{t("gallery.sampleHeading")}</p>
        <p>{t("gallery.sampleBody")}</p>
        <p className="text-muted-foreground text-sm">{t("gallery.sampleBody")}</p>
        <a className="text-link underline" href="#gallery">
          {t("gallery.syncNow")}
        </a>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{t("gallery.components")}</h3>
        <div className="flex flex-wrap gap-2">
          <Button>{t("gallery.syncNow")}</Button>
          <Button variant="outline">{t("gallery.syncNow")}</Button>
          <Badge variant="secondary">{t("gallery.secondary")}</Badge>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{t("gallery.statuses")}</h3>
        <ul className="space-y-2">
          {examples.map((ex) => {
            const s = describeStatus(ex.snapshot, DEFAULT_THRESHOLDS, now);
            return (
              <li key={ex.id} className="flex flex-wrap items-center gap-2 text-sm">
                <code className="text-muted-foreground w-44">{ex.id}</code>
                <StatusBadge status={s} now={now} />
                {s.secondary.length > 0 && (
                  <span className="text-muted-foreground text-xs">
                    {s.secondary.map((m) => formatStatusMessage(m, lang)).join(" · ")}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{t("gallery.device")}</h3>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <StatusDot level={device.level} />
              {t("gallery.sampleDevice")}
            </CardTitle>
            <CardDescription>
              <StatusBadge status={device} now={now} />
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button size="sm">{t("gallery.syncNow")}</Button>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

export default function GalleryPage() {
  const { t, i18n } = useTranslation();
  const now = useMemo(() => Date.now(), []);
  return (
    <main data-dev-gallery="true" className="mx-auto max-w-7xl space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-serif text-3xl font-semibold">{t("gallery.title")}</h1>
        <div className="flex items-center gap-4">
          <ThemeSwitcher />
          <div role="group" aria-label={t("gallery.language")} className="inline-flex gap-1">
            {(["it", "en"] as const).map((l) => (
              <Button
                key={l}
                size="sm"
                variant={i18n.language === l ? "default" : "outline"}
                aria-pressed={i18n.language === l}
                onClick={() => {
                  void i18n.changeLanguage(l);
                  document.documentElement.lang = l;
                }}
              >
                {l.toUpperCase()}
              </Button>
            ))}
          </div>
        </div>
      </header>
      <div className="grid gap-6 lg:grid-cols-2">
        <Pane theme="light" now={now} />
        <Pane theme="dark" now={now} />
      </div>
    </main>
  );
}
