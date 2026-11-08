// @vitest-environment jsdom
import { exampleSnapshots } from "@kamino/status";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n } from "../i18n/index.js";
import { ThemeProvider } from "../theme/ThemeProvider.js";
import GalleryPage from "./GalleryPage.js";

afterEach(cleanup);

describe("GalleryPage", () => {
  it("renders one badge per example snapshot in each theme pane", () => {
    render(
      <I18nextProvider i18n={createI18n("it")}>
        <ThemeProvider>
          <GalleryPage />
        </ThemeProvider>
      </I18nextProvider>,
    );
    const n = exampleSnapshots(0).length;
    expect(screen.getAllByRole("status")).toHaveLength(n * 2 + 2);
  });
});
