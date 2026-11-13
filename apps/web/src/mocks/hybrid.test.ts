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
  it("leaves the whole API to the real server, pairing included", () => {
    const active = activeHandlers(true);
    for (const h of [
      ...vaultDetailHandlers,
      ...historyHandlers,
      ...conflictHandlers,
      ...adminHandlers,
      ...pairingHandlers,
    ])
      expect(active).not.toContain(h);
    expect(active).toEqual([]);
    expect(REAL.length).toBe(handlers.length);
    expect(activeHandlers(false)).toBe(handlers);
  });
});
