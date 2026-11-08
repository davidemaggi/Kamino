import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { Toaster } from "./components/ui/sonner.js";
import { createAppRouter } from "./router.js";

const DevPanel = import.meta.env.DEV ? lazy(() => import("./mocks/DevPanel.js")) : null;

export function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
  );
  const [router] = useState(() => createAppRouter({ queryClient }));
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
      {DevPanel && (
        <Suspense>
          <DevPanel
            onChange={() => void queryClient.invalidateQueries().then(() => router.invalidate())}
          />
        </Suspense>
      )}
    </QueryClientProvider>
  );
}
