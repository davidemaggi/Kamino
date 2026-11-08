import { beforeEach, describe, expect, it, vi } from "vitest";

const diffCalls: Array<{ layout: string; editable: boolean }> = [];
const diffMine: string[] = [];
const destroyed: number[] = [];
vi.mock("@kamino/ui-diff", () => ({
  diffSummary: () => ({ changes: 2 }),
  createDiffView: (
    parent: HTMLElement,
    opts: { layout: string; editable: boolean; mine: string },
  ) => {
    const n = diffCalls.push({ layout: opts.layout, editable: opts.editable });
    diffMine.push(opts.mine);
    const el = parent.ownerDocument.createElement("div");
    el.className = "fake-diff";
    parent.append(el);
    return { getMerged: () => "merged text", destroy: () => destroyed.push(n) };
  },
}));

import { Notice, WorkspaceLeaf } from "../__mocks__/obsidian.js";
import { makeCtx, TEST_NOW } from "../__mocks__/ui-context.js";
import { conflictScenario } from "../state/scenarios.js";
import { ConflictView } from "./ConflictView.js";
import { CONFLICT_VIEW } from "./workspace.js";

beforeEach(() => {
  diffCalls.length = 0;
  diffMine.length = 0;
  destroyed.length = 0;
  Notice.shown = [];
});

async function openConflict(id: string, isMobile = false) {
  const { ctx, state, plugin } = makeCtx({ isMobile });
  state.loadScenario(conflictScenario(TEST_NOW));
  plugin.registerView(CONFLICT_VIEW, (leaf) => new ConflictView(leaf as never, ctx) as never);
  const leaf = new WorkspaceLeaf(plugin.app);
  await leaf.setViewState({ type: CONFLICT_VIEW, state: { conflictId: id } });
  const root = leaf.view!.contentEl;
  const button = (text: string) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent === text);
  return { ctx, state, plugin, leaf, root, button };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ConflictView, text, desktop", () => {
  it("shows header, summary and a split read-only diff", async () => {
    const { root, button } = await openConflict("c-shopping");
    expect(root.querySelector("h2")?.textContent).toBe("Spesa.md");
    expect(root.textContent).toContain("Entrambe le versioni sono salvate.");
    expect(root.textContent).toContain("Differenze: 2");
    expect(diffCalls).toEqual([{ layout: "split", editable: false }]);
    for (const b of [
      "Tieni la mia",
      "Tieni quella in arrivo",
      "Tieni entrambe",
      "Modifica e unisci…",
    ]) {
      expect(button(b)).toBeDefined();
    }
  });

  it.each([
    [
      "Tieni la mia",
      { type: "keep_mine" },
      "Hai tenuto la tua versione. Quella di iPhone resta nello storico.",
    ],
    [
      "Tieni quella in arrivo",
      { type: "keep_incoming" },
      "Hai tenuto la versione di iPhone. La tua resta nello storico.",
    ],
    [
      "Tieni entrambe",
      { type: "keep_both" },
      "Hai tenuto entrambe: la tua è salvata come file affiancato.",
    ],
  ])("%s resolves, notifies and closes", async (label, resolution, notice) => {
    const { state, leaf, button } = await openConflict("c-shopping");
    const spy = vi.spyOn(state, "resolve");
    button(label)!.click();
    await flush();
    expect(spy).toHaveBeenCalledWith("c-shopping", resolution);
    expect(Notice.shown).toContain(notice);
    expect(leaf.view).toBeNull();
  });

  it("edit and merge saves the merged text as a manual resolution", async () => {
    const { state, button } = await openConflict("c-shopping");
    const spy = vi.spyOn(state, "resolve");
    button("Modifica e unisci…")!.click();
    expect(diffCalls.at(-1)).toEqual({ layout: "split", editable: true });
    button("Salva l'unione")!.click();
    await flush();
    expect(spy).toHaveBeenCalledWith("c-shopping", { type: "manual", text: "merged text" });
    expect(Notice.shown).toContain("Unione salvata.");
  });

  it("cancel leaves edit mode", async () => {
    const { button } = await openConflict("c-shopping");
    button("Modifica e unisci…")!.click();
    button("Annulla")!.click();
    expect(diffCalls.at(-1)).toEqual({ layout: "split", editable: false });
    expect(button("Tieni la mia")).toBeDefined();
  });

  it("stale: reloads, warns, no success notice, stays open", async () => {
    const { state, leaf, root, button } = await openConflict("c-shopping");
    state.nextResolveStale();
    button("Tieni la mia")!.click();
    await flush();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(
      "È arrivata una versione più recente: controlla di nuovo prima di scegliere.",
    );
    expect(Notice.shown).toEqual([]);
    expect(leaf.view).not.toBeNull();
  });

  it("resolved elsewhere: shows 'already resolved'", async () => {
    const { state, root, button } = await openConflict("c-shopping");
    await state.resolve("c-shopping", { type: "keep_mine" });
    await flush();
    expect(root.textContent).toContain("Questo conflitto è già stato risolto.");
    expect(button("Chiudi")).toBeDefined();
  });

  it("destroys the diff on close", async () => {
    const { leaf } = await openConflict("c-shopping");
    leaf.detach();
    await flush();
    expect(destroyed.length).toBeGreaterThan(0);
  });
});

describe("ConflictView, text, mobile", () => {
  it("opens on the Differences tab with a unified diff", async () => {
    const { root } = await openConflict("c-shopping", true);
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    expect(tabs.map((x) => x.textContent)).toEqual(["La tua", "Differenze", "In arrivo"]);
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(diffCalls).toEqual([{ layout: "unified", editable: false }]);
  });

  it("'La tua' shows the full text without a diff", async () => {
    const { root } = await openConflict("c-shopping", true);
    (root.querySelector('[role="tab"]') as HTMLElement).click();
    expect(root.querySelector("pre")?.textContent).toContain("uova (6)");
    expect(root.querySelector(".fake-diff")).toBeNull();
  });
});

describe("ConflictView, binary", () => {
  it("shows previews and no edit action", async () => {
    const { root, button } = await openConflict("c-photo");
    expect(root.querySelectorAll("img")).toHaveLength(2);
    expect(root.textContent).toContain("Due file con lo stesso nome");
    expect(button("Modifica e unisci…")).toBeUndefined();
    expect(diffCalls).toEqual([]);
  });

  it("shows a placeholder when there is no preview", async () => {
    const { ctx, state, plugin } = makeCtx();
    const sc = conflictScenario(TEST_NOW);
    const photo = sc.conflicts[2]!;
    if (!photo.binary) throw new Error("fixture");
    state.loadScenario({
      ...sc,
      conflicts: [{ ...photo, mineFile: { ...photo.mineFile, previewUrl: null } }],
    });
    plugin.registerView(CONFLICT_VIEW, (leaf) => new ConflictView(leaf as never, ctx) as never);
    const leaf = new WorkspaceLeaf(plugin.app);
    await leaf.setViewState({ type: CONFLICT_VIEW, state: { conflictId: "c-photo" } });
    const root = leaf.view!.contentEl;
    expect(root.querySelectorAll("img")).toHaveLength(1);
    expect(root.textContent).toContain("Anteprima non disponibile");
  });
});

describe("ConflictView, safety", () => {
  it("ignores a second click while a resolution is in flight", async () => {
    const { state, button } = await openConflict("c-shopping");
    let release: (v: { ok: true }) => void = () => undefined;
    const spy = vi
      .spyOn(state, "resolve")
      .mockImplementation(() => new Promise((r) => (release = r)));
    button("Tieni entrambe")!.click();
    button("Tieni la mia")!.click();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(button("Tieni la mia")!.disabled).toBe(true);
    release({ ok: true });
    await flush();
  });

  it("a failed resolution shows an error and keeps the view usable", async () => {
    const { state, leaf, button } = await openConflict("c-shopping");
    vi.spyOn(state, "resolve").mockRejectedValueOnce(new Error("network"));
    button("Tieni la mia")!.click();
    await flush();
    expect(Notice.shown).toEqual(["Non è stato possibile applicare la scelta. Riprova."]);
    expect(leaf.view).not.toBeNull();
    expect(button("Tieni la mia")!.disabled).toBe(false);
  });

  it("stale during a manual merge keeps the merged text in edit mode", async () => {
    const { state, button } = await openConflict("c-shopping");
    button("Modifica e unisci…")!.click();
    state.nextResolveStale();
    button("Salva l'unione")!.click();
    await flush();
    expect(button("Salva l'unione")).toBeDefined();
    expect(diffCalls.at(-1)).toEqual({ layout: "split", editable: true });
    expect(diffMine.at(-1)).toBe("merged text");
  });

  it("resolved elsewhere during a merge still shows the unsaved merged text", async () => {
    const { state, root, button } = await openConflict("c-shopping");
    button("Modifica e unisci…")!.click();
    state.nextResolveStale();
    button("Salva l'unione")!.click();
    await flush();
    await state.resolve("c-shopping", { type: "keep_mine" });
    await flush();
    expect(root.textContent).toContain("Questo conflitto è già stato risolto.");
    expect(root.querySelector("pre")?.textContent).toBe("merged text");
  });

  it("a load finishing after close does not create a diff", async () => {
    const { state, plugin } = makeCtx();
    state.loadScenario(conflictScenario(TEST_NOW));
    const { ctx } = { ctx: { ...makeCtx().ctx, source: state, actions: state } };
    const real = state.conflict.bind(state);
    vi.spyOn(state, "conflict").mockImplementation(
      (id) => new Promise((r) => setTimeout(() => void real(id).then(r), 5)),
    );
    plugin.registerView(CONFLICT_VIEW, (leaf) => new ConflictView(leaf as never, ctx) as never);
    const leaf = new WorkspaceLeaf(plugin.app);
    const opening = leaf.setViewState({ type: CONFLICT_VIEW, state: { conflictId: "c-shopping" } });
    leaf.detach();
    await opening;
    await new Promise((r) => setTimeout(r, 20));
    expect(diffCalls).toEqual([]);
  });

  it("resolved elsewhere while editing keeps the in-progress merge visible", async () => {
    const { state, root, button } = await openConflict("c-shopping");
    button("Modifica e unisci…")!.click();
    await state.resolve("c-shopping", { type: "keep_mine" });
    await flush();
    expect(root.textContent).toContain("La tua unione non è stata salvata");
    expect(root.querySelector("pre")?.textContent).toBe("merged text");
  });
});
