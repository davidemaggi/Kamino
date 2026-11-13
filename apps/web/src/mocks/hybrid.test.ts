// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { adminHandlers } from "./admin-handlers.js";
import { activeHandlers, REAL } from "./browser.js";
import { handlers } from "./handlers.js";
import {
  conflictHandlers,
  historyHandlers,
  pairingHandlers,
  vaultDetailHandlers,
} from "./user-handlers.js";

describe("hybrid mode", () => {
  it("leaves the user area and admin to the real server, keeps pairing fake", () => {
    const active = activeHandlers(true);
    for (const h of [
      ...vaultDetailHandlers,
      ...historyHandlers,
      ...conflictHandlers,
      ...adminHandlers,
    ])
      expect(active).not.toContain(h);
    for (const h of pairingHandlers) expect(active).toContain(h);
    expect(active.length).toBe(handlers.length - REAL.length);
    expect(activeHandlers(false)).toBe(handlers);
  });
});
