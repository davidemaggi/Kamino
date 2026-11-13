import type { RequestHandler } from "msw";
import { setupWorker } from "msw/browser";
import { adminHandlers } from "./admin-handlers.js";
import { signInAs } from "./db.js";
import { authHandlers, handlers } from "./handlers.js";
import {
  conflictHandlers,
  deviceHandlers,
  historyHandlers,
  vaultDetailHandlers,
  vaultListHandlers,
} from "./user-handlers.js";

/** Dev only: fake API in the browser (data-msw marks this module for the build test). */
export const MSW_MARKER = "data-msw";

/**
 * B6: `VITE_KAMINO_API=hybrid` sends to the real server (Vite proxy) what it implements: setup,
 * login, account, (M1c) the vault list and summary, (M2a) the devices, (M4) the vault detail,
 * history, trash, conflicts and ZIP and (M5) the admin area. Everything else (pairing) stays on
 * MSW, signed in as the fake admin.
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
];

export function activeHandlers(hybrid: boolean): RequestHandler[] {
  return hybrid ? handlers.filter((h) => !REAL.includes(h)) : handlers;
}

export async function startMocks(): Promise<void> {
  await setupWorker(...activeHandlers(HYBRID)).start({
    onUnhandledFrame: "bypass",
    quiet: true,
    serviceWorker: { url: "/mockServiceWorker.js" },
  });
  if (HYBRID) signInAs("admin");
}
