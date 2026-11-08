import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { App } from "./App.js";
import { createI18n, detectLanguage } from "./i18n/index.js";
import { ThemeProvider } from "./theme/ThemeProvider.js";
import "./index.css";

const i18n = createI18n(detectLanguage(navigator.language));
document.documentElement.lang = i18n.language;

async function start(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("missing #root");
  // Dev-only: design system gallery (outside the app, no API needed).
  if (import.meta.env.DEV && location.pathname.startsWith("/dev/gallery")) {
    const Gallery = lazy(() => import("./dev/GalleryPage.js"));
    createRoot(root).render(
      <StrictMode>
        <I18nextProvider i18n={i18n}>
          <ThemeProvider>
            <Suspense>
              <Gallery />
            </Suspense>
          </ThemeProvider>
        </I18nextProvider>
      </StrictMode>,
    );
    return;
  }
  // Dev-only: fake API (MSW). `import.meta.env.DEV` is a build-time constant: dropped in production.
  if (import.meta.env.DEV) {
    const { startMocks } = await import("./mocks/browser.js");
    await startMocks();
  }
  createRoot(root).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </I18nextProvider>
    </StrictMode>,
  );
}

void start();
