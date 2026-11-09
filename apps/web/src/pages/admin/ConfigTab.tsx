import type { ConfigPatch, ConfigSource, SystemConfig } from "@kamino/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function Section({
  title,
  children,
  onSave,
  busy,
}: {
  title: string;
  children: ReactNode;
  onSave?: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section aria-label={title} className="bg-card space-y-3 rounded-xl border p-4">
      <h2 className="font-serif text-lg font-semibold">{title}</h2>
      {children}
      {onSave && (
        <Button disabled={busy} onClick={onSave}>
          {t("admin.system.save")}
        </Button>
      )}
    </section>
  );
}

/** E-03: env values are locked and say so. */
function Locked({ source }: { source: ConfigSource }) {
  const { t } = useTranslation();
  return source === "env" ? (
    <span className="text-muted-foreground text-xs">{t("admin.system.fromEnv")}</span>
  ) : null;
}

function Field({
  label,
  source,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  source: ConfigSource;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        disabled={source === "env"}
        onChange={(e) => onChange(e.target.value)}
        {...(placeholder ? { placeholder } : {})}
      />
      <Locked source={source} />
    </div>
  );
}

export function ConfigTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ["admin-config"], queryFn: api.adminConfig });
  const c = config.data;
  const [form, setForm] = useState({
    registration: "closed",
    quota: "",
    retention: "",
    maxFile: "",
    host: "",
    port: "",
    security: "starttls",
    user: "",
    password: "",
    from: "",
    allowInvalid: false,
  });
  useEffect(() => {
    if (!c) return;
    setForm({
      registration: c.registration.value,
      quota: c.defaultQuotaBytes.value === null ? "" : String(c.defaultQuotaBytes.value / GB),
      retention: String(c.maxRetentionDays.value),
      maxFile: String(Math.round(c.maxFileBytes.value / MB)),
      host: c.smtp.host.value,
      port: String(c.smtp.port.value),
      security: c.smtp.security.value,
      user: c.smtp.username.value,
      password: "",
      from: c.smtp.from.value,
      allowInvalid: c.smtp.allowInvalidCerts.value,
    });
  }, [c]);
  const save = useMutation({
    mutationFn: (patch: ConfigPatch) => api.updateConfig(patch),
    onSuccess: (next: SystemConfig) => {
      qc.setQueryData(["admin-config"], next);
      toast(t("admin.system.saved"));
    },
    onError: (err) => toast.error(errorMessage(err, t)),
  });
  const test = useMutation({
    mutationFn: api.smtpTest,
    onError: (err) => toast.error(errorMessage(err, t)),
  });
  if (config.isError) return <p role="alert">{errorMessage(config.error, t)}</p>;
  if (!c) return null;
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  // Only unlocked fields are ever sent (E-03).
  const unlocked = <T,>(source: ConfigSource, value: T): T | undefined =>
    source === "env" ? undefined : value;
  const clean = <T extends object>(o: T): T =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

  return (
    <div className="space-y-4">
      <Section
        title={t("admin.system.registration")}
        busy={save.isPending}
        onSave={() =>
          save.mutate(
            clean({
              registration: unlocked(c.registration.source, form.registration as "closed" | "open"),
            }),
          )
        }
      >
        <div role="radiogroup" aria-label={t("admin.system.registration")} className="space-y-1">
          {(["closed", "open"] as const).map((v) => (
            <label key={v} className="flex items-center gap-2">
              <input
                type="radio"
                name="registration"
                disabled={c.registration.source === "env"}
                checked={form.registration === v}
                onChange={() => set("registration")(v)}
              />
              {t(
                v === "closed"
                  ? "admin.system.registrationClosed"
                  : "admin.system.registrationOpen",
              )}
            </label>
          ))}
          <Locked source={c.registration.source} />
        </div>
      </Section>

      <Section
        title={t("admin.system.limits")}
        busy={save.isPending}
        onSave={() =>
          save.mutate(
            clean({
              defaultQuotaBytes: unlocked(
                c.defaultQuotaBytes.source,
                form.quota === "" ? null : Number(form.quota) * GB,
              ),
              maxRetentionDays: unlocked(c.maxRetentionDays.source, Number(form.retention)),
              maxFileBytes: unlocked(c.maxFileBytes.source, Math.round(Number(form.maxFile) * MB)),
            }),
          )
        }
      >
        <Field
          label={t("admin.system.defaultQuota")}
          source={c.defaultQuotaBytes.source}
          value={form.quota}
          onChange={set("quota")}
          type="number"
        />
        <Field
          label={t("admin.system.maxRetention")}
          source={c.maxRetentionDays.source}
          value={form.retention}
          onChange={set("retention")}
          type="number"
        />
        <Field
          label={t("admin.system.maxFile")}
          source={c.maxFileBytes.source}
          value={form.maxFile}
          onChange={set("maxFile")}
          type="number"
        />
      </Section>

      <Section
        title={t("admin.system.email")}
        busy={save.isPending}
        onSave={() =>
          save.mutate({
            smtp: clean({
              host: unlocked(c.smtp.host.source, form.host),
              port: unlocked(c.smtp.port.source, Number(form.port)),
              security: unlocked(
                c.smtp.security.source,
                form.security as "none" | "starttls" | "tls",
              ),
              username: unlocked(c.smtp.username.source, form.user),
              from: unlocked(c.smtp.from.source, form.from),
              allowInvalidCerts: unlocked(c.smtp.allowInvalidCerts.source, form.allowInvalid),
              password:
                form.password === "" ? undefined : unlocked(c.smtp.passwordSource, form.password),
            }),
          })
        }
      >
        <Field
          label={t("admin.system.smtpHost")}
          source={c.smtp.host.source}
          value={form.host}
          onChange={set("host")}
        />
        <Field
          label={t("admin.system.smtpPort")}
          source={c.smtp.port.source}
          value={form.port}
          onChange={set("port")}
          type="number"
        />
        <label className="block space-y-1 text-sm">
          <span className="font-medium">{t("admin.system.smtpSecurity")}</span>
          <select
            value={form.security}
            disabled={c.smtp.security.source === "env"}
            onChange={(e) => set("security")(e.target.value)}
            className="bg-background block rounded-md border px-2 py-1"
          >
            {(["none", "starttls", "tls"] as const).map((s) => (
              <option key={s} value={s}>
                {t(`admin.system.securities.${s}`)}
              </option>
            ))}
          </select>
          <Locked source={c.smtp.security.source} />
        </label>
        <Field
          label={t("admin.system.smtpUser")}
          source={c.smtp.username.source}
          value={form.user}
          onChange={set("user")}
        />
        <Field
          label={t("admin.system.smtpPassword")}
          source={c.smtp.passwordSource}
          value={form.password}
          onChange={set("password")}
          type="password"
          {...(c.smtp.passwordSet ? { placeholder: t("admin.system.smtpPasswordSet") } : {})}
        />
        <Field
          label={t("admin.system.smtpFrom")}
          source={c.smtp.from.source}
          value={form.from}
          onChange={set("from")}
        />
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            disabled={c.smtp.allowInvalidCerts.source === "env"}
            checked={form.allowInvalid}
            onChange={(e) => setForm((f) => ({ ...f, allowInvalid: e.target.checked }))}
          />
          <span>
            {t("admin.system.allowInvalid")}
            {form.allowInvalid && (
              <span className="text-status-attention block">
                {t("admin.system.allowInvalidWarn")}
              </span>
            )}
          </span>
        </label>
        <div className="space-y-2 border-t pt-3">
          <Button variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
            {t("admin.system.smtpTest")}
          </Button>
          {test.data?.ok === true && (
            <p role="status" className="text-status-safe text-sm">
              {t("admin.system.smtpTestOk")}
            </p>
          )}
          {test.data?.ok === false && (
            <p role="alert" className="text-sm">
              {t("admin.system.smtpTestFail")}{" "}
              <code className="bg-muted rounded px-1">{test.data.error}</code>
            </p>
          )}
        </div>
      </Section>
    </div>
  );
}
