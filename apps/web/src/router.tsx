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
import { NotFoundPage } from "./pages/NotFoundPage.js";
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
  component: () => <PlaceholderPage titleKey="auth.login.title" />,
});
export const setupRoute = createRoute({
  getParentRoute: () => publicRoute,
  path: "/setup",
  component: () => <PlaceholderPage titleKey="auth.setup.title" />,
});
export const forgotRoute = createRoute({
  getParentRoute: () => publicRoute,
  path: "/forgot",
  component: () => <PlaceholderPage titleKey="auth.forgot.title" />,
});
export const resetRoute = createRoute({
  getParentRoute: () => publicRoute,
  path: "/reset/$token",
  component: () => <PlaceholderPage titleKey="auth.reset.title" />,
});
export const inviteRoute = createRoute({
  getParentRoute: () => publicRoute,
  path: "/invite/$token",
  component: () => <PlaceholderPage titleKey="auth.invite.title" />,
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

export const overviewRoute = page("/", "nav.overview");
export const vaultsRoute = page("/vaults", "nav.vaults");
export const devicesRoute = page("/devices", "nav.devices");
export const conflictsRoute = page("/conflicts", "nav.conflicts");
export const accountRoute = page("/account", "nav.account");
export const totpSetupRoute = page("/account/totp-setup", "auth.totp.title");
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
    devicesRoute,
    conflictsRoute,
    accountRoute,
    totpSetupRoute,
    aboutRoute,
    adminRoute.addChildren([adminUsersRoute, adminSystemRoute]),
  ]),
]);

export function createAppRouter(opts: { queryClient: QueryClient; history?: RouterHistory }) {
  return createRouter({
    routeTree,
    context: { queryClient: opts.queryClient },
    ...(opts.history ? { history: opts.history } : {}),
    defaultNotFoundComponent: NotFoundPage,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
