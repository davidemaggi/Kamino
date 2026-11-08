import { QueryClient } from "@tanstack/react-query";
import type { RouterHistory } from "@tanstack/react-router";
import { onUnauthorized } from "../api/http.js";
import { safeRedirect } from "../api/redirect.js";
import { createAppRouter } from "../router.js";

const PUBLIC = ["/login", "/setup", "/forgot", "/reset", "/invite"];

/** Router + query client wired together (used by the app and by the tests). */
export function createAppInstance(opts: { history?: RouterHistory } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const router = createAppRouter({
    queryClient,
    ...(opts.history ? { history: opts.history } : {}),
  });
  // Session revoked or expired mid-session: forget cached data and go to sign-in, keeping the page.
  const dispose = onUnauthorized(() => {
    const { pathname, href } = router.state.location;
    if (PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return;
    queryClient.clear();
    void router.navigate({ to: "/login", search: { redirect: safeRedirect(href) } });
  });
  return { router, queryClient, dispose };
}
