import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "../i18n/index.js";
import { createAppInstance } from "../app/instance.js";
import { Toaster } from "../components/ui/sonner.js";
import { ThemeProvider } from "../theme/ThemeProvider.js";

/** Renders the whole app at a path, against the MSW fake API. */
export async function renderRoute(path: string, lang: "it" | "en" = "it") {
  const { router, queryClient, dispose } = createAppInstance({
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const i18n = createI18n(lang);
  const utils = render(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
          <Toaster />
        </QueryClientProvider>
      </ThemeProvider>
    </I18nextProvider>,
  );
  await router.load();
  return { ...utils, router, queryClient, dispose };
}
