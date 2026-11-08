import { vi } from "vitest";
import { FakeServer } from "../connection/fake-server.js";
import { SettingsStore } from "../settings/store.js";
import { FakeSyncState } from "../state/fake.js";
import type { UiContext } from "../ui/context.js";
import { Plugin } from "./obsidian.js";

export const TEST_NOW = Date.UTC(2026, 10, 8, 10, 0);

/** UiContext over in-memory fakes, with spies for navigation. */
export function makeCtx(overrides: Partial<UiContext> = {}) {
  const plugin = new Plugin();
  const state = new FakeSyncState(
    { name: "Laptop", mode: "live", server: "sync.example" },
    () => TEST_NOW,
  );
  const store = new SettingsStore(plugin, overrides.isMobile ?? false);
  const server = new FakeServer({
    isMobile: overrides.isMobile ?? false,
    clock: () => TEST_NOW,
    delay: () => Promise.resolve(),
    random: () => 0.5,
    localFileCount: () => plugin.app.vault.getFiles().length,
    pluginVersion: "0.0.0",
    platform: "macOS",
    store: store.linkStore,
    autoRun: false,
  });
  const ctx: UiContext = {
    source: state,
    actions: state,
    connection: server,
    transfer: server.transfer,
    settings: store,
    engineAvailable: false,
    lang: "it",
    isMobile: false,
    isIos: false,
    platformLabel: "macOS",
    vaultName: "Prova",
    configDir: ".obsidian",
    now: () => TEST_NOW,
    available: null,
    localFileCount: () => plugin.app.vault.getFiles().length,
    openStatusPanel: vi.fn(() => Promise.resolve()),
    openConflict: vi.fn(() => Promise.resolve()),
    openBulkResolve: vi.fn(),
    openWelcome: vi.fn(() => Promise.resolve()),
    openTransfer: vi.fn(() => Promise.resolve()),
    openConnect: vi.fn(),
    openClaim: vi.fn(),
    openAddDevice: vi.fn(),
    confirm: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  };
  return { ctx, state, plugin, server, store };
}
