import { PRODUCT_NAME } from "@kamino/brand";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { createI18n, detectLanguage } from "./i18n/index.js";
import { AboutPage } from "./pages/AboutPage.js";
import { ThemeProvider } from "./theme/ThemeProvider.js";
import "./index.css";

const i18n = createI18n(detectLanguage(navigator.language));
document.documentElement.lang = i18n.language;
document.title = PRODUCT_NAME;

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <AboutPage />
      </ThemeProvider>
    </I18nextProvider>
  </StrictMode>,
);
