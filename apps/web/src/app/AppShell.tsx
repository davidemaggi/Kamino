import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Info,
  LayoutDashboard,
  LogOut,
  Menu,
  MonitorSmartphone,
  Settings,
  ShieldCheck,
  Users,
  Vault,
  GitCompareArrows,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../api/endpoints.js";
import { LevelBadge, worstLevel } from "../components/status/LevelBadge.js";
import { Button } from "../components/ui/button.js";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "../components/ui/sheet.js";
import { cn } from "../lib/utils.js";
import { useTheme } from "../theme/ThemeProvider.js";
import { BrandMark } from "./BrandMark.js";

function NavItem({
  to,
  icon,
  label,
  badge,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  badge?: number;
}) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const active = to === "/" ? path === "/" : path === to || path.startsWith(`${to}/`);
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2 text-sm",
        active ? "bg-accent text-accent-foreground font-semibold" : "hover:bg-muted",
      )}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {badge ? (
        <span className="bg-status-decision-surface text-status-decision rounded-full px-2 py-0.5 text-xs font-medium">
          {badge}
        </span>
      ) : null}
    </Link>
  );
}

/** Signed-in layout (spec §8.3): sidebar on desktop, top bar + sheet on narrow screens. */
export function AppShell() {
  const { t, i18n } = useTranslation();
  const { setTheme } = useTheme();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const me = useQuery({ queryKey: ["me"], queryFn: api.me }).data;
  // Language and theme saved on the server win at sign-in (and when the user changes).
  useEffect(() => {
    if (!me) return;
    if (i18n.language !== me.lang) {
      void i18n.changeLanguage(me.lang);
      document.documentElement.lang = me.lang;
    }
    setTheme(me.theme);
  }, [me?.id]); // only when another user signs in
  const summary = useQuery({
    queryKey: ["vaults-summary"],
    queryFn: api.vaultsSummary,
    enabled: !!me && !me.totpSetupRequired,
  }).data;
  const overall = worstLevel(summary?.vaults.map((v) => v.level) ?? []);
  const conflicts = summary?.vaults.reduce((n, v) => n + v.conflicts, 0) ?? 0;

  const logout = async () => {
    // Local data is always cleared; if the server did not confirm, say so (shared computers).
    await api.logout().catch(() => toast.error(t("nav.logoutFailed")));
    qc.clear();
    await navigate({ to: "/login", search: { redirect: "/" } });
  };

  if (!me) return null;
  const minimal = me.totpSetupRequired;

  const nav = (
    <nav aria-label={t("nav.label")} className="flex h-full flex-col gap-1 p-3">
      <div className="px-3 pt-1 pb-3 text-lg">
        <BrandMark size={28} />
      </div>
      {!minimal && (
        <>
          <div className="px-3 pb-3">{summary ? <LevelBadge level={overall} /> : null}</div>
          <NavItem
            to="/"
            icon={<LayoutDashboard className="size-4" aria-hidden="true" />}
            label={t("nav.overview")}
          />
          <NavItem
            to="/vaults"
            icon={<Vault className="size-4" aria-hidden="true" />}
            label={t("nav.vaults")}
          />
          <NavItem
            to="/devices"
            icon={<MonitorSmartphone className="size-4" aria-hidden="true" />}
            label={t("nav.devices")}
          />
          <NavItem
            to="/conflicts"
            icon={<GitCompareArrows className="size-4" aria-hidden="true" />}
            label={t("nav.conflicts")}
            badge={conflicts}
          />
          {me.role === "admin" && (
            <>
              <div className="text-muted-foreground px-3 pt-4 pb-1 text-xs font-medium tracking-wide uppercase">
                {t("nav.admin")}
              </div>
              <NavItem
                to="/admin/users"
                icon={<Users className="size-4" aria-hidden="true" />}
                label={t("nav.users")}
              />
              <NavItem
                to="/admin/system"
                icon={<Settings className="size-4" aria-hidden="true" />}
                label={t("nav.system")}
              />
            </>
          )}
        </>
      )}
      <div className="mt-auto space-y-1 pt-4">
        {!minimal && (
          <>
            <NavItem
              to="/account"
              icon={<ShieldCheck className="size-4" aria-hidden="true" />}
              label={`${t("nav.account")} · ${me.username}`}
            />
            <NavItem
              to="/about"
              icon={<Info className="size-4" aria-hidden="true" />}
              label={t("nav.about")}
            />
          </>
        )}
        <button
          type="button"
          onClick={() => void logout()}
          className="hover:bg-muted flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm"
        >
          <LogOut className="size-4" aria-hidden="true" />
          {t("nav.logout")}
        </button>
        <p className="text-muted-foreground px-3 text-xs">{t(`nav.roles.${me.role}`)}</p>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      <a
        href="#main"
        className="focus:bg-background sr-only focus:not-sr-only focus:absolute focus:p-2"
      >
        {t("nav.skip")}
      </a>
      <aside className="bg-card hidden border-r lg:block">{nav}</aside>
      <header className="bg-card flex items-center justify-between border-b px-3 py-2 lg:hidden">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="sm" aria-label={t("nav.menu")}>
              <Menu className="size-5" aria-hidden="true" />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="w-64 p-0"
            onClick={(e) => (e.target as HTMLElement).closest("a") && setMenuOpen(false)}
          >
            <SheetTitle className="sr-only">{t("nav.label")}</SheetTitle>
            {nav}
          </SheetContent>
        </Sheet>
        <BrandMark />
        {summary && !minimal ? <LevelBadge level={overall} /> : <span />}
      </header>
      <main id="main" className="mx-auto w-full max-w-5xl space-y-4 p-4 lg:p-8">
        {me.adminResetAt && !bannerDismissed && (
          <div
            role="alert"
            className="bg-status-attention-surface text-status-attention flex flex-wrap items-center justify-between gap-2 rounded-lg p-3 text-sm"
          >
            <span>
              {t("shell.resetBanner", { date: new Date(me.adminResetAt).toLocaleString(me.lang) })}
            </span>
            <Button size="sm" variant="outline" onClick={() => setBannerDismissed(true)}>
              {t("shell.resetBannerOk")}
            </Button>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
