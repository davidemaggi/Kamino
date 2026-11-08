import { setupWorker } from "msw/browser";
import { handlers } from "./handlers.js";

/** Dev only: fake API in the browser (data-msw marks this module for the build test). */
export const MSW_MARKER = "data-msw";

export async function startMocks(): Promise<void> {
  await setupWorker(...handlers).start({
    onUnhandledFrame: "bypass",
    quiet: true,
    serviceWorker: { url: "/mockServiceWorker.js" },
  });
}
