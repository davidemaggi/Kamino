// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeProvider, useTheme, type Theme } from "./ThemeProvider.js";

let api: { theme: Theme; setTheme: (t: Theme) => void };
function Probe() {
  api = useTheme();
  return null;
}
function mount() {
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("ThemeProvider", () => {
  it("defaults to system", () => {
    mount();
    expect(api.theme).toBe("system");
  });

  it("persists the choice and applies the dark class", () => {
    mount();
    act(() => api.setTheme("dark"));
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    act(() => api.setTheme("light"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("restores the stored theme", () => {
    localStorage.setItem("theme", "dark");
    mount();
    expect(api.theme).toBe("dark");
  });
});
