import { DEFAULT_THRESHOLDS, describeStatus, exampleSnapshots, type Lang } from "@kamino/status";
import { Notice, type Plugin } from "obsidian";
import { t } from "../i18n/index.js";
import type { StatusIndicator } from "../ui/StatusIndicator.js";

/** Dev-only: cycles the indicator through the shared example snapshots. */
export function registerStatusGallery(
  plugin: Plugin,
  indicator: StatusIndicator,
  deps: { now: () => number; lang: Lang },
): void {
  let i = 0;
  plugin.addCommand({
    id: "dev-status-gallery",
    name: t(deps.lang).dev.statusGallery,
    callback: () => {
      const now = deps.now();
      const examples = exampleSnapshots(now);
      const ex = examples[i % examples.length]!;
      i += 1;
      new Notice(`${i}/${examples.length} · ${ex.id}`);
      indicator.update(describeStatus(ex.snapshot, DEFAULT_THRESHOLDS, now));
    },
  });
}
