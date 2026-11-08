import { vi } from "vitest";
import { FakeSyncState } from "../state/fake.js";
import type { UiContext } from "../ui/context.js";
import { Plugin } from "./obsidian.js";

export const TEST_NOW = Date.UTC(2026, 10, 8, 10, 0);

/** UiContext over a FakeSyncState, with spies for navigation. */
export function makeCtx(overrides: Partial<UiContext> = {}) {
  const plugin = new Plugin();
  const state = new FakeSyncState(
    { name: "Laptop", mode: "live", server: "sync.example" },
    () => TEST_NOW,
  );
  const ctx: UiContext = {
    source: state,
    actions: state,
    lang: "it",
    isMobile: false,
    now: () => TEST_NOW,
    available: null,
    openStatusPanel: vi.fn(() => Promise.resolve()),
    openConflict: vi.fn(() => Promise.resolve()),
    openBulkResolve: vi.fn(),
    ...overrides,
  };
  return { ctx, state, plugin };
}
