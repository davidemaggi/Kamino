import type { ConflictSummary } from "@kamino/protocol";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { formatAgo } from "../../lib/format.js";
import { cn } from "../../lib/utils.js";

export function ConflictList({
  conflicts,
  selectedId,
}: {
  conflicts: ConflictSummary[];
  selectedId: string | null;
}) {
  const { t, i18n } = useTranslation();
  const groups = new Map<string, ConflictSummary[]>();
  for (const c of conflicts) groups.set(c.vaultName, [...(groups.get(c.vaultName) ?? []), c]);
  return (
    <nav aria-label={t("conflicts.title")} className="bg-card space-y-3 rounded-xl border p-2">
      {[...groups].map(([vault, items]) => (
        <div key={vault}>
          <p className="text-muted-foreground px-2 pt-1 text-xs font-medium">{vault}</p>
          <ul>
            {items.map((c) => (
              <li key={c.id}>
                <Link
                  to="/conflicts/$conflictId"
                  params={{ conflictId: c.id }}
                  aria-current={c.id === selectedId ? "page" : undefined}
                  className={cn(
                    "block rounded-md px-2 py-2 text-sm",
                    c.id === selectedId ? "bg-accent font-semibold" : "hover:bg-muted",
                  )}
                >
                  <span className="block break-all">{c.path}</span>
                  <span className="text-muted-foreground text-xs">
                    {c.incoming.device} · {formatAgo(c.incoming.at, i18n.language)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
