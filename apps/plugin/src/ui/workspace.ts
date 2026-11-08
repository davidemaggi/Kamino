import { PRODUCT_SLUG } from "@kamino/brand";
import type { App } from "obsidian";

export const STATUS_VIEW = `${PRODUCT_SLUG}-status-panel`;
export const CONFLICT_VIEW = `${PRODUCT_SLUG}-conflict`;

/** Opens (or reveals) the status panel in the right sidebar (the drawer on mobile). */
export async function openStatusPanel(app: App): Promise<void> {
  const existing = app.workspace.getLeavesOfType(STATUS_VIEW)[0];
  const leaf = existing ?? app.workspace.getRightLeaf(false);
  if (!leaf) return;
  if (!existing) await leaf.setViewState({ type: STATUS_VIEW, active: true });
  await app.workspace.revealLeaf(leaf);
}

/** Opens (or reveals) the resolution tab of one conflict. */
export async function openConflict(app: App, id: string): Promise<void> {
  const existing = app.workspace
    .getLeavesOfType(CONFLICT_VIEW)
    // getViewState, not view.getState: restored background tabs are deferred (Obsidian ≥ 1.7)
    // and their view is not a ConflictView until shown.
    .find((l) => l.getViewState().state?.["conflictId"] === id);
  const leaf = existing ?? app.workspace.getLeaf("tab");
  if (!existing)
    await leaf.setViewState({ type: CONFLICT_VIEW, active: true, state: { conflictId: id } });
  await app.workspace.revealLeaf(leaf);
}
