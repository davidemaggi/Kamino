import type { ConfigPatch, ConfigSource, SystemConfig } from "@kamino/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { ErrorText } from "../auth/AuthCard.js";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

type Form = ReturnType<typeof fromConfig>;
type SectionId = "registration" | "limits" | "email";

function fromConfig(c: SystemConfig) {
  return {
    registration: c.registration.value as string,
    quotaUnlimited: c.defaultQuotaBytes.value === null,
    quota: c.defaultQuotaBytes.value === null ? "" : String(c.defaultQuotaBytes.value / GB),
    retention: String(c.maxRetentionDays.value),
    maxFile: String(Math.round(c.maxFileBytes.value / MB)),
    host: c.smtp.host.value,
    port: String(c.smtp.port.value),
    security: c.smtp.security.value as string,
    user: c.smtp.username.value,
    password: "",
    from: c.smtp.from.value,
    allowInvalid: c.smtp.allowInvalidCerts.value,
  };
}

/** After a save only that section is re-synced: unsaved edits elsewhere are kept. */
const SECTION_FIELDS: Record<SectionId, Array<keyof Form>> = {
  registration: ["registration"],
  limits: ["quotaUnlimited", "quota", "retention", "maxFile"],
  email: ["host", "port", "security", "user", "password", "from", "allowInvalid"],
};

/** Integer in [min, max], or undefined (empty, decimal, out of range). */
function int(v: string, min: number, max: number): number | undefined {
  const n = Number(v);
  return v.trim() !== "" && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

function Section({
  title,
  children,
  onSave,
  busy,
  footer,
}: {
  title: string;
  children: ReactNode;
  onSave?: () => void;
  /** Disables saving (in-flight request or invalid values). */
  busy?: boolean;
  /** Rendered after the save button (e.g. the test email, which uses the saved values). */
  footer?: ReactNode;
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
      {footer}
    </section>
  );
}

/** E-03: env values are locked and say so. */
function Locked({ source, id }: { source: ConfigSource; id?: string }) {
  const { t } = useTranslation();
  return source === "env" ? (
    <span id={id} className="text-muted-foreground block text-xs">
      {t("admin.system.fromEnv")}
    </span>
  ) : null;
}

function Field({
  label,
  source,
  value,
  onChange,
  type = "text",
  placeholder,
  error,
}: {
  label: string;
  source: ConfigSource;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  error?: string | null;
}) {
  const id = useId();
  const describedBy = [source === "env" ? `${id}-env` : "", error ? `${id}-err` : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="max-w-md space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        disabled={source === "env"}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
        {...(describedBy ? { "aria-describedby": describedBy } : {})}
        {...(placeholder ? { placeholder } : {})}
      />
      <Locked source={source} id={`${id}-env`} />
      {error && <ErrorText id={`${id}-err`}>{error}</ErrorText>}
    </div>
  );
}

export function ConfigTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ["admin-config"], queryFn: api.adminConfig });
  const c = config.data;
  const [form, setForm] = useState<Form | null>(null);
  const loaded = useRef(false);
  useEffect(() => {
    // Fill the form once; later refetches must not overwrite what the admin is typing.
    if (!c || loaded.current) return;
    loaded.current = true;
    setForm(fromConfig(c));
  }, [c]);
  const save = useMutation({
    mutationFn: ({ patch }: { section: SectionId; patch: ConfigPatch }) => api.updateConfig(patch),
    onSuccess: (next, { section }) => {
      qc.setQueryData(["admin-config"], next);
      const fresh = fromConfig(next);
      setForm((f) =>
        f
          ? {
              ...f,
              ...Object.fromEntries(SECTION_FIELDS[section].map((k) => [k, fresh[k]])),
            }
          : fresh,
      );
      toast(t("admin.system.saved"));
    },
    onError: (err) => toast.error(errorMessage(err, t)),
  });
  const test = useMutation({
    mutationFn: api.smtpTest,
    onError: (err) => toast.error(errorMessage(err, t)),
  });
  if (config.isError) return <p role="alert">{errorMessage(config.error, t)}</p>;
  if (!c || !form) return null;
  const set =
    <K extends keyof Form>(k: K) =>
    (v: Form[K]) =>
      setForm((f) => (f ? { ...f, [k]: v } : f));
  // Only unlocked fields are ever sent (E-03).
  const unlocked = <T,>(source: ConfigSource, value: T): T | undefined =>
    source === "env" ? undefined : value;
  const clean = <T extends object>(o: T): T =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  const send = (section: SectionId, patch: ConfigPatch) => save.mutate({ section, patch });

  // Validation: never send empty or out-of-range numbers (e.g. "" → 0 days of history).
  const invalid = t("admin.system.invalidNumber");
  const quotaGb = Number(form.quota);
  const quotaOk = form.quotaUnlimited || (Number.isFinite(quotaGb) && quotaGb > 0);
  const retention = int(form.retention, 0, 90);
  const maxFile = int(form.maxFile, 1, 1_000_000);
  const port = int(form.port, 1, 65535);
  const err = (source: ConfigSource, ok: boolean) => (source !== "env" && !ok ? invalid : null);
  const limitsErrors = {
    quota: err(c.defaultQuotaBytes.source, quotaOk),
    retention: err(c.maxRetentionDays.source, retention !== undefined),
    maxFile: err(c.maxFileBytes.source, maxFile !== undefined),
  };
  const portError = err(c.smtp.port.source, port !== undefined);
  const limitsInvalid = Object.values(limitsErrors).some(Boolean);

  return (
    <div className="space-y-4">
      <Section
        title={t("admin.system.registration")}
        busy={save.isPending}
        onSave={() =>
          send(
            "registration",
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
        busy={save.isPending || limitsInvalid}
        onSave={() =>
          send(
            "limits",
            clean({
              defaultQuotaBytes: unlocked(
                c.defaultQuotaBytes.source,
                form.quotaUnlimited ? null : Math.round(quotaGb * GB),
              ),
              maxRetentionDays: unlocked(c.maxRetentionDays.source, retention),
              maxFileBytes: unlocked(
                c.maxFileBytes.source,
                maxFile === undefined ? undefined : maxFile * MB,
              ),
            }),
          )
        }
      >
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            disabled={c.defaultQuotaBytes.source === "env"}
            checked={form.quotaUnlimited}
            onChange={(e) => set("quotaUnlimited")(e.target.checked)}
          />
          {t("admin.system.defaultQuotaUnlimited")}
        </label>
        {!form.quotaUnlimited && (
          <Field
            label={t("admin.system.defaultQuota")}
            source={c.defaultQuotaBytes.source}
            value={form.quota}
            onChange={set("quota")}
            type="number"
            error={limitsErrors.quota}
          />
        )}
        <Field
          label={t("admin.system.maxRetention")}
          source={c.maxRetentionDays.source}
          value={form.retention}
          onChange={set("retention")}
          type="number"
          error={limitsErrors.retention}
        />
        <Field
          label={t("admin.system.maxFile")}
          source={c.maxFileBytes.source}
          value={form.maxFile}
          onChange={set("maxFile")}
          type="number"
          error={limitsErrors.maxFile}
        />
      </Section>

      <Section
        title={t("admin.system.email")}
        busy={save.isPending || portError !== null}
        onSave={() =>
          send("email", {
            smtp: clean({
              host: unlocked(c.smtp.host.source, form.host),
              port: unlocked(c.smtp.port.source, port),
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
        footer={
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
          error={portError}
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
            onChange={(e) => set("allowInvalid")(e.target.checked)}
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
      </Section>
    </div>
  );
}
