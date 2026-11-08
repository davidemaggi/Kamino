import type { Lang } from "@kamino/status";
import type { Plugin } from "obsidian";
import { t } from "../i18n/index.js";
import type { FakeSyncState } from "../state/fake.js";
import { conflictScenario } from "../state/scenarios.js";
import type { UiContext } from "../ui/context.js";
import { DiffTestModal } from "./diff-test.js";
import { LinkTestModal } from "./link-test.js";
import { registerStatusGallery } from "./status-gallery.js";

export interface DevDeps {
  lang: Lang;
  now: () => number;
  state: FakeSyncState;
  ctx: UiContext;
}

/** Registers development-only commands (called only when __DEV__). */
export function registerDevCommands(plugin: Plugin, deps: DevDeps): void {
  registerStatusGallery(plugin, deps.state, deps);
  plugin.addCommand({
    id: "dev-conflict-scenario",
    name: t(deps.lang).dev.conflictScenario,
    callback: () => {
      deps.state.loadScenario(conflictScenario(deps.now()));
      void deps.ctx.openStatusPanel();
    },
  });
  plugin.addCommand({
    id: "dev-diff-test",
    name: t(deps.lang).dev.diffTest,
    callback: () => new DiffTestModal(plugin.app, deps.lang).open(),
  });
  plugin.addCommand({
    id: "dev-link-test",
    name: t(deps.lang).dev.linkTest,
    callback: () => new LinkTestModal(plugin.app, deps.lang).open(),
  });
}
