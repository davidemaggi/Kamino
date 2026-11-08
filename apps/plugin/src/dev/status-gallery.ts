import { exampleSnapshots, type Lang } from "@kamino/status";
import { Notice, type Plugin } from "obsidian";
import { t } from "../i18n/index.js";
import type { FakeSyncState } from "../state/fake.js";

/** Dev-only: cycles the fake state through the shared example snapshots (indicator and panel follow). */
export function registerStatusGallery(
  plugin: Plugin,
  state: FakeSyncState,
  deps: { now: () => number; lang: Lang },
): void {
  let i = 0;
  plugin.addCommand({
    id: "dev-status-gallery",
    name: t(deps.lang).dev.statusGallery,
    callback: () => {
      const examples = exampleSnapshots(deps.now());
      const ex = examples[i % examples.length]!;
      i += 1;
      new Notice(`${i}/${examples.length} · ${ex.id}`);
      state.setSnapshot(ex.snapshot);
    },
  });
}
