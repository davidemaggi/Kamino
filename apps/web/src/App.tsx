import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";
import { createAppInstance } from "./app/instance.js";
import { Toaster } from "./components/ui/sonner.js";

/** Dev only, and not in hybrid mode: everything is on the real server there, no fake data. */
const DevPanel =
  import.meta.env.DEV && import.meta.env["VITE_KAMINO_API"] !== "hybrid"
    ? lazy(() => import("./mocks/DevPanel.js"))
    : null;

export function App() {
  const [{ router, queryClient, dispose }] = useState(() => createAppInstance());
  useEffect(() => dispose, [dispose]);
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
