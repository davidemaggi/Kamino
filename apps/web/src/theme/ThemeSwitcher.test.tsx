// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n } from "../i18n/index.js";
import { ThemeProvider } from "./ThemeProvider.js";
import { ThemeSwitcher } from "./ThemeSwitcher.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("ThemeSwitcher", () => {
  it("shows the three options and marks the current one", () => {
    render(
      <I18nextProvider i18n={createI18n("it")}>
        <ThemeProvider>
          <ThemeSwitcher />
        </ThemeProvider>
      </I18nextProvider>,
    );
    expect(screen.getByRole("group", { name: "Tema" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Sistema" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Scuro" }));
    expect(screen.getByRole("button", { name: "Scuro" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
