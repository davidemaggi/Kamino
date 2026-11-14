import { setupServer } from "msw/node";
import { toast } from "sonner";
import { afterAll, afterEach, beforeAll } from "vitest";
import { resetDb } from "../mocks/db.js";
import { handlers } from "../mocks/handlers.js";

// jsdom has no matchMedia (used by the toaster and by useIsNarrow): default to "no match"
// (desktop, light). Tests that need a phone or dark mode stub their own.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// Nor ResizeObserver (Radix measures the checkbox with it): a no-op is enough for tests.
if (typeof window !== "undefined" && typeof window.ResizeObserver !== "function") {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

export const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledFrame: "bypass" }));
afterEach(() => {
  // Toasts live in a module-level store: never let one leak into the next test.
  toast.dismiss();
  server.resetHandlers();
  resetDb();
});
afterAll(() => server.close());
