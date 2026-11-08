import { PRODUCT_NAME } from "@kamino/brand";
import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { createI18n, detectLanguage } from "./i18n/index.js";
import { AboutPage } from "./pages/AboutPage.js";
import { ThemeProvider } from "./theme/ThemeProvider.js";
import "./index.css";

const i18n = createI18n(detectLanguage(navigator.language));
document.documentElement.lang = i18n.language;
document.title = PRODUCT_NAME;

// Dev-only: `import.meta.env.DEV` is a build-time constant, so the gallery chunk is
// dropped from production builds (checked by test/build.test.ts).
const Page =
  import.meta.env.DEV && location.pathname.startsWith("/dev/gallery")
    ? lazy(() => import("./dev/GalleryPage.js"))
    : AboutPage;

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <Suspense>
          <Page />
        </Suspense>
      </ThemeProvider>
    </I18nextProvider>
  </StrictMode>,
);
