import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { LevelBadge } from "../../components/status/LevelBadge.js";
import { Button } from "../../components/ui/button.js";
import { formatAgo, formatBytes } from "../../lib/format.js";
import { cn } from "../../lib/utils.js";
import { CreateUserDialog } from "./CreateUserDialog.js";

export function UsersPage() {
  const { t, i18n } = useTranslation();
  useDocumentTitle(t("admin.users.title"));
  const users = useQuery({ queryKey: ["admin-users"], queryFn: api.adminUsers });
  const [createOpen, setCreateOpen] = useState(false);
  const lang = i18n.language;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-serif text-2xl font-semibold">{t("admin.users.title")}</h1>
        <Button onClick={() => setCreateOpen(true)}>{t("admin.users.create")}</Button>
      </div>
      <p className="text-muted-foreground text-sm">{t("admin.users.privacy")}</p>
      {users.isError && <p role="alert">{errorMessage(users.error, t)}</p>}
      <div className="bg-card overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground text-left">
            <tr>
              {[
                "username",
                "role",
                "status",
                "space",
                "vaults",
                "devices",
                "sync",
                "lastLogin",
              ].map((k) => (
                <th key={k} scope="col" className="p-3 font-medium">
                  {t(`admin.users.${k}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {users.data?.map((u) => (
              <tr key={u.id}>
                <th scope="row" className="p-3 text-left font-medium">
                  <Link
                    to="/admin/users/$userId"
                    params={{ userId: u.id }}
                    className="text-link underline"
                  >
                    {u.username}
                  </Link>
                  <span className="text-muted-foreground block text-xs font-normal">{u.email}</span>
                </th>
                <td className="p-3">{t(`admin.user.roles.${u.role}`)}</td>
                <td className="p-3">{t(`admin.users.statuses.${u.status}`)}</td>
                <td className="p-3 whitespace-nowrap">
                  {formatBytes(u.usedBytes, lang)} /{" "}
                  {u.quotaBytes === null
                    ? t("admin.users.unlimited")
                    : formatBytes(u.quotaBytes, lang)}
                  {u.quotaBytes !== null && u.quotaBytes > 0 && (
                    <div aria-hidden className="bg-muted mt-1 h-1 w-full rounded-full">
                      <div
                        className={cn(
                          "h-1 rounded-full",
                          u.usedBytes >= u.quotaBytes ? "bg-status-attention" : "bg-link",
                        )}
                        style={{ width: `${Math.min(100, (u.usedBytes / u.quotaBytes) * 100)}%` }}
                      />
                    </div>
                  )}
                </td>
                <td className="p-3">{u.vaultCount}</td>
                <td className="p-3">{u.deviceCount}</td>
                <td className="p-3">
                  <LevelBadge level={u.syncLevel} />
                </td>
                <td className="p-3 whitespace-nowrap">
                  {u.lastLoginAt ? formatAgo(u.lastLoginAt, lang) : t("admin.users.never")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
