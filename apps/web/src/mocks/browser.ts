import type { RequestHandler } from "msw";
import { setupWorker } from "msw/browser";
import { adminHandlers } from "./admin-handlers.js";
import { authHandlers, handlers } from "./handlers.js";
import {
  conflictHandlers,
  deviceHandlers,
  historyHandlers,
  pairingHandlers,
  vaultDetailHandlers,
  vaultListHandlers,
} from "./user-handlers.js";

/** Dev only: fake API in the browser (data-msw marks this module for the build test). */
export const MSW_MARKER = "data-msw";

/**
 * B6: `VITE_KAMINO_API=hybrid` sends to the real server (Vite proxy) what it implements: setup,
 * login, account, (M1c) the vault list and summary, (M2a) the devices, (M4) the vault detail,
 * history, trash, conflicts and ZIP, (M5) the admin area and (M6) pairing: since M6 that is the
 * whole API, so in hybrid mode MSW doesn't start at all.
 */
export const HYBRID = import.meta.env["VITE_KAMINO_API"] === "hybrid";

/** The handlers the real server replaces in hybrid mode. */
export const REAL: readonly RequestHandler[] = [
  ...authHandlers,
  ...vaultListHandlers,
  ...deviceHandlers,
  ...vaultDetailHandlers,
  ...historyHandlers,
  ...conflictHandlers,
  ...adminHandlers,
  ...pairingHandlers,
];

export function activeHandlers(hybrid: boolean): RequestHandler[] {
  return hybrid ? handlers.filter((h) => !REAL.includes(h)) : handlers;
}

export async function startMocks(): Promise<void> {
  const active = activeHandlers(HYBRID);
  if (active.length === 0) return;
  await setupWorker(...active).start({
    onUnhandledFrame: "bypass",
    quiet: true,
    serviceWorker: { url: "/mockServiceWorker.js" },
  });
}
