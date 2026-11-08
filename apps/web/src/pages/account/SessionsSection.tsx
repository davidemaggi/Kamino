import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { Button } from "../../components/ui/button.js";
import { SectionCard } from "./SectionCard.js";

export function SessionsSection() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.sessions });
  const refresh = () => qc.invalidateQueries({ queryKey: ["sessions"] });
  // Never silent: a failed sign-out of a session is reported.
  const onError = (err: unknown) => toast.error(errorMessage(err, t));
  const end = useMutation({ mutationFn: api.endSession, onSuccess: refresh, onError });
  const endOthers = useMutation({ mutationFn: api.endOtherSessions, onSuccess: refresh, onError });
  const when = (iso: string) => new Date(iso).toLocaleString(i18n.language);

  return (
    <SectionCard title={t("account.sessions.title")}>
      <ul className="divide-y">
        {sessions.data?.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div>
              <p className="font-medium">
                {s.client}{" "}
                {s.current && (
                  <span className="text-status-safe ml-2 text-sm">
                    {t("account.sessions.current")}
                  </span>
                )}
              </p>
              <p className="text-muted-foreground text-sm">
                {s.ipPrefix} · {t("account.sessions.lastUsed", { when: when(s.lastUsedAt) })}
              </p>
            </div>
            {!s.current && (
              <Button
                size="sm"
                variant="outline"
                disabled={end.isPending}
                onClick={() => end.mutate(s.id)}
              >
                {t("account.sessions.end")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {(sessions.data?.length ?? 0) > 1 && (
        <Button variant="outline" disabled={endOthers.isPending} onClick={() => endOthers.mutate()}>
          {t("account.sessions.endOthers")}
        </Button>
      )}
    </SectionCard>
  );
}
