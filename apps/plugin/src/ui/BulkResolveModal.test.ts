import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, Notice } from "../__mocks__/obsidian.js";
import { makeCtx, TEST_NOW } from "../__mocks__/ui-context.js";
import { conflictScenario } from "../state/scenarios.js";
import { BulkResolveModal } from "./BulkResolveModal.js";

beforeEach(() => {
  Notice.shown = [];
});

function open() {
  const { ctx, state } = makeCtx();
  state.loadScenario(conflictScenario(TEST_NOW));
  const modal = new BulkResolveModal(new App() as never, ctx);
  modal.open();
  const root = (modal as unknown as { contentEl: HTMLElement }).contentEl;
  const apply = [...root.querySelectorAll("button")].find((b) => b.textContent === "Applica")!;
  return { modal, root, apply, state };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("BulkResolveModal", () => {
  it("lists three options, none selected, and the count", () => {
    const { root, apply } = open();
    const radios = [...root.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    expect(radios).toHaveLength(3);
    expect(radios.some((r) => r.checked)).toBe(false);
    expect(root.textContent).toContain("Si applica a 3 file");
    expect(apply.disabled).toBe(true);
  });

  it("does nothing without a choice", async () => {
    const { apply, state } = open();
    const spy = vi.spyOn(state, "resolveAll");
    apply.click();
    await flush();
    expect(spy).not.toHaveBeenCalled();
  });

  it("applies the chosen strategy, notifies and closes", async () => {
    const { modal, root, apply, state } = open();
    const spy = vi.spyOn(state, "resolveAll");
    const keepBoth = root.querySelector('input[value="keep_both"]') as HTMLInputElement;
    keepBoth.checked = true;
    keepBoth.dispatchEvent(new Event("change"));
    expect(apply.disabled).toBe(false);
    apply.click();
    await flush();
    expect(spy).toHaveBeenCalledWith("keep_both", ["c-shopping", "c-plan", "c-photo"]);
    expect(Notice.shown).toContain("Conflitti risolti: 3");
    expect((modal as unknown as { isOpen: boolean }).isOpen).toBe(false);
  });

  it("cancel closes without applying", () => {
    const { modal, root, state } = open();
    const spy = vi.spyOn(state, "resolveAll");
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Annulla")!.click();
    expect(spy).not.toHaveBeenCalled();
    expect((modal as unknown as { isOpen: boolean }).isOpen).toBe(false);
  });

  function choose(root: HTMLElement, value: string) {
    const input = root.querySelector(`input[value="${value}"]`) as HTMLInputElement;
    input.checked = true;
    input.dispatchEvent(new Event("change"));
  }

  it("only resolves the conflicts that were shown", async () => {
    const { root, apply, state } = open();
    const spy = vi.spyOn(state, "resolveAll");
    const sc = conflictScenario(TEST_NOW);
    state.loadScenario({
      ...sc,
      conflicts: [...sc.conflicts, { ...sc.conflicts[0]!, id: "c-new" }],
    });
    choose(root, "keep_mine");
    apply.click();
    await flush();
    expect(spy).toHaveBeenCalledWith("keep_mine", ["c-shopping", "c-plan", "c-photo"]);
    expect(state.conflicts().map((c) => c.id)).toEqual(["c-new"]);
  });

  it("ignores a second click while applying", async () => {
    const { root, apply, state } = open();
    let release: (v: { resolved: number }) => void = () => undefined;
    const spy = vi
      .spyOn(state, "resolveAll")
      .mockImplementation(() => new Promise((r) => (release = r)));
    choose(root, "keep_mine");
    apply.click();
    apply.click();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(apply.disabled).toBe(true);
    release({ resolved: 3 });
    await flush();
  });

  it("a failure shows an error and keeps the modal open", async () => {
    const { modal, root, apply, state } = open();
    vi.spyOn(state, "resolveAll").mockRejectedValueOnce(new Error("network"));
    choose(root, "keep_mine");
    apply.click();
    await flush();
    expect(Notice.shown).toEqual(["Non è stato possibile risolvere i conflitti. Riprova."]);
    expect((modal as unknown as { isOpen: boolean }).isOpen).toBe(true);
    expect(apply.disabled).toBe(false);
  });
});
