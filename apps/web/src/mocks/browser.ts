import { setupWorker } from "msw/browser";
import { signInAs } from "./db.js";
import { authHandlers, handlers } from "./handlers.js";
import { deviceHandlers, vaultListHandlers } from "./user-handlers.js";

/** Dev only: fake API in the browser (data-msw marks this module for the build test). */
export const MSW_MARKER = "data-msw";

/**
 * B6: `VITE_KAMINO_API=hybrid` sends setup, login, account, (M1c) the vault list and summary and
 * (M2a) the devices
 * to the real server (Vite proxy);
 * everything not implemented there yet stays on MSW, signed in as the fake admin.
 */
export const HYBRID = import.meta.env["VITE_KAMINO_API"] === "hybrid";

export async function startMocks(): Promise<void> {
  const real = [...authHandlers, ...vaultListHandlers, ...deviceHandlers];
  const active = HYBRID ? handlers.filter((h) => !real.includes(h)) : handlers;
  await setupWorker(...active).start({
    onUnhandledFrame: "bypass",
    quiet: true,
    serviceWorker: { url: "/mockServiceWorker.js" },
  });
  if (HYBRID) signInAs("admin");
}
