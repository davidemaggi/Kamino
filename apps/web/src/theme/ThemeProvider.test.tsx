// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, ThemeProvider, useTheme, type Theme } from "./ThemeProvider.js";

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
  it("defaults to dark", () => {
    mount();
    expect(api.theme).toBe("dark");
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

describe("ThemeProvider system mode", () => {
  function stubMatchMedia(initial: boolean) {
    const listeners = new Set<() => void>();
    const mq = {
      matches: initial,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    };
    vi.stubGlobal("matchMedia", () => mq);
    return {
      set(dark: boolean) {
        mq.matches = dark;
        for (const l of listeners) l();
      },
      listeners,
    };
  }

  afterEach(() => vi.unstubAllGlobals());

  it("follows the system preference and its changes", () => {
    const media = stubMatchMedia(false);
    localStorage.setItem(THEME_STORAGE_KEY, "system");
    mount();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    act(() => media.set(true));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    act(() => media.set(false));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("stops listening when leaving system mode", () => {
    const media = stubMatchMedia(false);
    mount();
    act(() => api.setTheme("light"));
    expect(media.listeners.size).toBe(0);
    act(() => media.set(true));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
