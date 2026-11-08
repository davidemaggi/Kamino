import type { Lang } from "@kamino/status";
import type { ConflictActions, SyncStateSource } from "../state/types.js";

/** Everything the views need: data, actions, environment and navigation. */
export interface UiContext {
  source: SyncStateSource;
  actions: ConflictActions;
  lang: Lang;
  isMobile: boolean;
  now: () => number;
  available: ReadonlySet<string> | null;
  openStatusPanel(): Promise<void>;
  openConflict(id: string): Promise<void>;
  openBulkResolve(): void;
}
