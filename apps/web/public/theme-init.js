// Applies the dark class before first paint (no theme flash).
// External file, not inline, so a strict CSP without 'unsafe-inline' still works.
// Storage key must match THEME_STORAGE_KEY in src/theme/ThemeProvider.tsx (tested).
/* global window, document */
(function () {
  var stored = null;
  try {
    stored = window.localStorage.getItem("theme");
  } catch {
    // storage unavailable: follow the system preference
  }
  var prefersDark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  var dark = stored === "dark" || (stored !== "light" && prefersDark);
  if (dark) document.documentElement.classList.add("dark");
})();
