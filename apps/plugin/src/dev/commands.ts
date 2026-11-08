import type { Lang } from "@kamino/status";
import type { Plugin } from "obsidian";
import { t } from "../i18n/index.js";
import { DiffTestModal } from "./diff-test.js";

export interface DevDeps {
  lang: Lang;
}

/** Registers development-only commands (called only when __DEV__). */
export function registerDevCommands(plugin: Plugin, deps: DevDeps): void {
  plugin.addCommand({
    id: "dev-diff-test",
    name: t(deps.lang).dev.diffTest,
    callback: () => new DiffTestModal(plugin.app, deps.lang).open(),
  });
}
