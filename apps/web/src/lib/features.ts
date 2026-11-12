/**
 * What the server behind the app can do yet. Restoring history and resolving conflicts arrive
 * with M3 (the server answers 501 until then): they work only against the fake API (dev without
 * `VITE_KAMINO_API=hybrid`), elsewhere the buttons stay disabled with a "coming soon" note.
 * Mutable so tests can switch it.
 */
export const features = {
  historyWrites: import.meta.env.DEV && import.meta.env["VITE_KAMINO_API"] !== "hybrid",
};
