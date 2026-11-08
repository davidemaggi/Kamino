import type { BulkStrategy } from "@kamino/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { LevelBadge } from "../../components/status/LevelBadge.js";
import { Button } from "../../components/ui/button.js";
import { useIsNarrow } from "../../lib/useMediaQuery.js";
import { BulkResolveDialog } from "./BulkResolveDialog.js";
import { ConflictDetailPane } from "./ConflictDetailPane.js";
import { ConflictList } from "./ConflictList.js";

/** Conflict center (spec §4.7): list + detail on desktop; two pages on a phone. */
export function ConflictCenter({ selectedId }: { selectedId?: string }) {
  const { t } = useTranslation();
  useDocumentTitle(t("conflicts.title"));
  const narrow = useIsNarrow();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const conflicts = useQuery({ queryKey: ["conflicts"], queryFn: api.conflicts });
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const list = conflicts.data ?? [];
  const current = selectedId ?? (narrow ? undefined : list[0]?.id);

  const goNext = async () => {
    const fresh = await qc.fetchQuery({ queryKey: ["conflicts"], queryFn: api.conflicts });
    const next = fresh[0];
    if (next)
      await navigate({
        to: "/conflicts/$conflictId",
        params: { conflictId: next.id },
        replace: true,
      });
    else await navigate({ to: "/conflicts", replace: true });
  };

  const applyBulk = async (strategy: BulkStrategy) => {
    setBulkBusy(true);
    try {
      const { resolved } = await api.resolveAll(
        strategy,
        list.map((c) => c.id),
      );
      toast(t("conflicts.bulkDone", { count: resolved }));
      setBulkOpen(false);
      await qc.invalidateQueries();
      await navigate({ to: "/conflicts", replace: true });
    } catch (err) {
      toast.error(errorMessage(err, t));
    } finally {
      setBulkBusy(false);
    }
  };

  if (conflicts.isError)
    return (
      <div className="space-y-3">
        <p role="alert">{errorMessage(conflicts.error, t)}</p>
        <Button variant="outline" onClick={() => void conflicts.refetch()}>
          {t("shell.retry")}
        </Button>
      </div>
    );
  if (!conflicts.data) return null;
  if (list.length === 0) {
    return (
      <div className="space-y-3">
        <h1 className="font-serif text-2xl font-semibold">{t("conflicts.title")}</h1>
        <p>{t("conflicts.none")}</p>
        <LevelBadge level="safe" />
      </div>
    );
  }

  const showList = !narrow || !selectedId;
  const showDetail = !!current && (!narrow || !!selectedId);
  return (
    <div className="space-y-4">
      {showList && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="font-serif text-2xl font-semibold">{t("conflicts.title")}</h1>
          {list.length >= 2 && (
            <Button variant="outline" onClick={() => setBulkOpen(true)}>
              {t("conflicts.resolveAll")}
            </Button>
          )}
        </div>
      )}
      <div className={narrow ? "" : "grid grid-cols-[260px_1fr] gap-4"}>
        {showList && <ConflictList conflicts={list} selectedId={current ?? null} />}
        {showDetail && current && (
          <ConflictDetailPane
            key={current}
            id={current}
            onResolved={() => void goNext()}
            onEditStart={() => {
              if (!selectedId)
                void navigate({
                  to: "/conflicts/$conflictId",
                  params: { conflictId: current },
                  replace: true,
                });
            }}
          />
        )}
      </div>
      <BulkResolveDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        count={list.length}
        busy={bulkBusy}
        onApply={(s) => void applyBulk(s)}
      />
    </div>
  );
}

export function ConflictsIndexPage() {
  return <ConflictCenter />;
}
