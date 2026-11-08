import { describe, expect, it } from "vitest";
import { makeCtx, TEST_NOW } from "../__mocks__/ui-context.js";
import { conflictScenario } from "../state/scenarios.js";
import { ConflictView } from "./ConflictView.js";
import { CONFLICT_VIEW, openConflict } from "./workspace.js";

describe("openConflict", () => {
  it("reuses the tab already open on the same conflict", async () => {
    const { ctx, state, plugin } = makeCtx();
    state.loadScenario(conflictScenario(TEST_NOW));
    plugin.registerView(CONFLICT_VIEW, (leaf) => new ConflictView(leaf as never, ctx) as never);
    await openConflict(plugin.app as never, "c-shopping");
    await openConflict(plugin.app as never, "c-shopping");
    await openConflict(plugin.app as never, "c-plan");
    expect(plugin.app.workspace.getLeavesOfType(CONFLICT_VIEW)).toHaveLength(2);
  });
});
