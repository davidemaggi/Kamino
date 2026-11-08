import type { BinaryMeta, Resolution } from "@kamino/protocol";
import { diffSummary } from "@kamino/ui-diff";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { ApiError } from "../../api/http.js";
import { DiffView, type DiffViewApi } from "../../components/DiffView.js";
import { Button } from "../../components/ui/button.js";
import { formatBytes, formatDateTime } from "../../lib/format.js";
import { useIsNarrow } from "../../lib/useMediaQuery.js";

type Tab = "mine" | "diff" | "incoming";

/** One conflict (spec §4.7): diff/previews, actions, stale and "already resolved". */
export function ConflictDetailPane({ id, onResolved }: { id: string; onResolved: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const narrow = useIsNarrow();
  const detail = useQuery({
    queryKey: ["conflict", id],
    queryFn: () => api.conflict(id),
    retry: false,
  });
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<Tab>("diff");
  const [stale, setStale] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const diff = useRef<DiffViewApi>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    setEditing(false);
    setTab("diff");
    setStale(false);
    setDraft(null);
    return () => {
      alive.current = false;
    };
  }, [id]);

  const lang = i18n.language;
  const d = detail.data;
  const gone =
    detail.isError && detail.error instanceof ApiError && detail.error.code === "not_found";
  if (gone || (!d && detail.isError)) {
    return (
      <section className="space-y-3">
        <p role="status">{t("conflicts.gone")}</p>
        {draft !== null && (
          <>
            <p className="text-sm">{t("conflicts.unsavedMerge")}</p>
            <pre className="bg-muted overflow-auto rounded p-3 text-sm whitespace-pre-wrap">
              {draft}
            </pre>
          </>
        )}
      </section>
    );
  }
  if (!d) return null;

  const when = (iso: string) => formatDateTime(iso, lang);
  const apply = async (resolution: Resolution) => {
    if (busy) return;
    if (typeof resolution === "object") setDraft(resolution.manual);
    setBusy(true);
    try {
      await api.resolveConflict(d.id, resolution, d.incoming.at);
      const key =
        typeof resolution === "object"
          ? "doneMerge"
          : resolution === "keep_mine"
            ? "doneMine"
            : resolution === "keep_incoming"
              ? "doneIncoming"
              : "doneBoth";
      toast(t(`conflicts.${key}`, { device: d.incoming.device }));
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ["conflicts"] });
      void qc.invalidateQueries({ queryKey: ["vaults"] });
      void qc.invalidateQueries({ queryKey: ["vaults-summary"] });
      if (alive.current) onResolved();
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && err.code === "stale_resolution") {
        setStale(true);
        await qc.invalidateQueries({ queryKey: ["conflict", id] });
      } else if (err instanceof ApiError && err.code === "not_found") {
        await qc.invalidateQueries({ queryKey: ["conflict", id] });
      } else toast.error(errorMessage(err, t));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const labels = {
    mine: t("conflicts.labelMine", { device: d.mine.device }),
    incoming: t("conflicts.labelIncoming", {
      device: d.incoming.device,
      when: when(d.incoming.at),
    }),
  };
  const phrases = {
    Accept: t("conflicts.chunkKeepMine"),
    Reject: t("conflicts.chunkTakeIncoming"),
    "Revert this chunk": t("conflicts.chunkTakeIncoming"),
    "$ unchanged lines": t("conflicts.unchangedLines"),
  };
  const summaryKey =
    d.kind === "both_created" ? "conflicts.summaryCreated" : "conflicts.summaryEdit";
  const mineBase = editing && draft !== null ? draft : d.binary ? "" : d.mineText;

  return (
    <section className="space-y-4">
      {narrow && (
        <Link to="/conflicts" className="text-link text-sm underline">
          {t("conflicts.back")}
        </Link>
      )}
      <h2 className="font-serif text-xl font-semibold break-all">{d.path}</h2>
      <p className="text-muted-foreground text-sm">
        {d.vaultName} ·{" "}
        {t(summaryKey, {
          mineDevice: d.mine.device,
          mine: when(d.mine.at),
          device: d.incoming.device,
          incoming: when(d.incoming.at),
        })}
      </p>
      {stale && (
        <p
          role="alert"
          className="bg-status-attention-surface text-status-attention rounded-md p-2 text-sm"
        >
          {t("conflicts.stale")}
        </p>
      )}
      {d.binary ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              [t("conflicts.tabMine"), d.mineFile, d.mine.device],
              [t("conflicts.tabIncoming"), d.incomingFile, d.incoming.device],
            ] as Array<[string, BinaryMeta, string]>
          ).map(([title, f, device]) => (
            <figure key={title} className="bg-card space-y-2 rounded-xl border p-3">
              <figcaption className="font-medium">
                {title} · {device}
              </figcaption>
              {f.previewUrl ? (
                <img src={f.previewUrl} alt={title} className="max-w-full rounded" />
              ) : (
                <p className="text-muted-foreground text-sm">{t("conflicts.noPreview")}</p>
              )}
              <p className="text-muted-foreground text-sm">
                {t("conflicts.fileSize")}: {formatBytes(f.size, lang)} · {t("conflicts.fileType")}:{" "}
                {f.mime}
              </p>
            </figure>
          ))}
        </div>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            {t("conflicts.changes", { count: diffSummary(d.mineText, d.incomingText).changes })}
          </p>
          {narrow ? (
            <>
              <div role="tablist" className="flex border-b">
                {(["mine", "diff", "incoming"] as const).map((x) => (
                  <button
                    key={x}
                    role="tab"
                    aria-selected={tab === x}
                    disabled={editing && x !== "diff"}
                    onClick={() => setTab(x)}
                    className={
                      tab === x
                        ? "flex-1 py-2 text-sm font-semibold shadow-[inset_0_-2px_0_var(--link)]"
                        : "text-muted-foreground flex-1 py-2 text-sm"
                    }
                  >
                    {t(
                      `conflicts.tab${x === "mine" ? "Mine" : x === "diff" ? "Diff" : "Incoming"}`,
                    )}
                  </button>
                ))}
              </div>
              {tab === "diff" ? (
                <DiffView
                  ref={diff}
                  mine={mineBase}
                  incoming={d.incomingText}
                  layout="unified"
                  editable={editing}
                  labels={labels}
                  phrases={phrases}
                />
              ) : (
                <pre className="bg-card overflow-auto rounded-lg border p-3 text-sm whitespace-pre-wrap">
                  {tab === "mine" ? d.mineText : d.incomingText}
                </pre>
              )}
            </>
          ) : (
            <DiffView
              ref={diff}
              mine={mineBase}
              incoming={d.incomingText}
              layout="split"
              editable={editing}
              labels={labels}
              phrases={phrases}
            />
          )}
        </>
      )}
      <div className={narrow ? "flex flex-col gap-2" : "flex flex-wrap gap-2"}>
        {editing ? (
          <>
            <Button
              disabled={busy}
              onClick={() => {
                const merged = diff.current?.getMerged();
                if (merged !== null && merged !== undefined) void apply({ manual: merged });
              }}
            >
              {t("conflicts.saveMerge")}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setDraft(null);
              }}
            >
              {t("conflicts.cancel")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" disabled={busy} onClick={() => void apply("keep_mine")}>
              {t("conflicts.keepMine")}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void apply("keep_incoming")}>
              {t("conflicts.keepIncoming")}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void apply("keep_both")}>
              {t("conflicts.keepBoth")}
            </Button>
            {!d.binary && (
              <Button
                disabled={busy}
                onClick={() => {
                  setEditing(true);
                  setTab("diff");
                }}
              >
                {t("conflicts.edit")}
              </Button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
