import type { Me } from "@kamino/protocol";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  notFound,
  Outlet,
  redirect,
  type RouterHistory,
} from "@tanstack/react-router";
import { api } from "./api/endpoints.js";
import { ApiError } from "./api/http.js";
import { safeRedirect } from "./api/redirect.js";
import { AppShell } from "./app/AppShell.js";
import { AboutPage } from "./pages/AboutPage.js";
import { ForgotPage } from "./pages/auth/ForgotPage.js";
import { InvitePage } from "./pages/auth/InvitePage.js";
import { LoginPage } from "./pages/auth/LoginPage.js";
import { ResetPage } from "./pages/auth/ResetPage.js";
import { SetupPage } from "./pages/auth/SetupPage.js";
import { AccountPage } from "./pages/account/AccountPage.js";
import { DevicePage } from "./pages/devices/DevicePage.js";
import { DevicesPage } from "./pages/devices/DevicesPage.js";
import { ErrorPage } from "./pages/ErrorPage.js";
import { OverviewPage } from "./pages/overview/OverviewPage.js";
import { VaultPage } from "./pages/vaults/VaultPage.js";
import { VaultsPage } from "./pages/vaults/VaultsPage.js";
import { NotFoundPage } from "./pages/NotFoundPage.js";
import { TotpSetupPage } from "./pages/TotpSetupPage.js";
import { PlaceholderPage } from "./pages/PlaceholderPage.js";

export interface RouterContext {
  queryClient: QueryClient;
}

/** Signed-in user or null (401). Other errors propagate. */
async function loadMe(qc: QueryClient): Promise<Me | null> {
  try {
    return await qc.fetchQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 30_000 });
  } catch (err) {
    if (err instanceof ApiError && err.code === "unauthorized") return null;
    throw err;
  }
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFoundPage,
});

// ---- public pages ---------------------------------------------------------------------------

const publicRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "public",
  beforeLoad: async ({ context, location }) => {
    const status = await context.queryClient.fetchQuery({
      queryKey: ["setup-status"],
      queryFn: api.setupStatus,
    });
    if (status.needed && location.pathname !== "/setup") throw redirect({ to: "/setup" });
    if (!status.needed && location.pathname === "/setup")
      throw redirect({ to: "/login", search: { redirect: "/" } });
    if (!status.needed && (await loadMe(context.queryClient))) throw redirect({ to: "/" });
  },
  component: Outlet,
});

export const loginRoute = createRoute({
  getParentRoute: () => publicRoute,
  path: "/login",
  validateSearch: (s: Record<string, unknown>): { redirect: string } => ({
    redirect: safeRedirect(s["redirect"]),
  }),
  component: LoginPage,
});
export const setupRoute = createRoute({
  getParentRoute: () => publicRoute,
  path: "/setup",
  component: SetupPage,
});
export const forgotRoute = createRoute({
  getParentRoute: () => publicRoute,
  path: "/forgot",
  component: ForgotPage,
});
export const resetRoute = createRoute({
  getParentRoute: () => publicRoute,
  path: "/reset/$token",
  component: ResetPage,
});
export const inviteRoute = createRoute({
  getParentRoute: () => publicRoute,
  path: "/invite/$token",
  component: InvitePage,
});

// ---- signed-in area -------------------------------------------------------------------------

export const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: async ({ context, location }) => {
    const status = await context.queryClient.fetchQuery({
      queryKey: ["setup-status"],
      queryFn: api.setupStatus,
    });
    if (status.needed) throw redirect({ to: "/setup" });
    const me = await loadMe(context.queryClient);
    if (!me) throw redirect({ to: "/login", search: { redirect: safeRedirect(location.href) } });
    if (me.totpSetupRequired && location.pathname !== "/account/totp-setup")
      throw redirect({ to: "/account/totp-setup" });
    return { me };
  },
  component: AppShell,
});

/** Generic on the path so the route keeps its literal type (typed links and redirects). */
const page = <P extends string>(path: P, titleKey: string) =>
  createRoute({
    getParentRoute: () => appRoute,
    path,
    component: () => <PlaceholderPage titleKey={titleKey} />,
  });

export const VAULT_TABS = ["devices", "conflicts", "history", "settings"] as const;
export type VaultTab = (typeof VAULT_TABS)[number];

export const overviewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: OverviewPage,
});
export const vaultsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/vaults",
  component: VaultsPage,
});
export const vaultRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/vaults/$vaultId",
  validateSearch: (s: Record<string, unknown>): { tab: VaultTab } => ({
    tab: VAULT_TABS.includes(s["tab"] as VaultTab) ? (s["tab"] as VaultTab) : "devices",
  }),
  component: VaultPage,
});
export const devicesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/devices",
  component: DevicesPage,
});
export const deviceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/devices/$deviceId",
  component: DevicePage,
});
export const conflictsRoute = page("/conflicts", "nav.conflicts");
// Placeholder until task 5 (conflict center).
export const conflictRoute = page("/conflicts/$conflictId", "nav.conflicts");
export const accountRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/account",
  component: AccountPage,
});
export const totpSetupRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/account/totp-setup",
  // Re-keying an active TOTP is not offered here (Account → regenerate codes / turn off instead).
  beforeLoad: ({ context }) => {
    if (context.me.totpEnabled && !context.me.totpSetupRequired) throw redirect({ to: "/account" });
  },
  component: () => <TotpSetupPage />,
});
export const aboutRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/about",
  component: AboutPage,
});

const adminRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin",
  beforeLoad: ({ context }) => {
    if (context.me.role !== "admin") throw notFound();
  },
  component: Outlet,
});
const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/admin/users" });
  },
});
export const adminUsersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/users",
  component: () => <PlaceholderPage titleKey="nav.users" />,
});
export const adminSystemRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/system",
  component: () => <PlaceholderPage titleKey="nav.system" />,
});

export const routeTree = rootRoute.addChildren([
  publicRoute.addChildren([loginRoute, setupRoute, forgotRoute, resetRoute, inviteRoute]),
  appRoute.addChildren([
    overviewRoute,
    vaultsRoute,
    vaultRoute,
    devicesRoute,
    deviceRoute,
    conflictsRoute,
    conflictRoute,
    accountRoute,
    totpSetupRoute,
    aboutRoute,
    adminRoute.addChildren([adminIndexRoute, adminUsersRoute, adminSystemRoute]),
  ]),
]);

export function createAppRouter(opts: { queryClient: QueryClient; history?: RouterHistory }) {
  return createRouter({
    routeTree,
    context: { queryClient: opts.queryClient },
    ...(opts.history ? { history: opts.history } : {}),
    defaultNotFoundComponent: NotFoundPage,
    defaultErrorComponent: ErrorPage,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
