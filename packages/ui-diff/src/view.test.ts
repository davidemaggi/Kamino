// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createDiffView, type DiffViewOptions } from "./view.js";

const MINE = "- milk\n- bread\n- eggs (6)\n";
const INCOMING = "- milk\n- bread\n- eggs (12)\n- apples\n";
const labels = { mine: "Mine", incoming: "Incoming" };

function mount(opts: Partial<DiffViewOptions>) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const handle = createDiffView(parent, {
    mine: MINE,
    incoming: INCOMING,
    layout: "split",
    editable: false,
    labels,
    ...opts,
  });
  return { parent, handle };
}

const editable = (p: HTMLElement) => p.querySelectorAll('[contenteditable="true"]').length;

afterEach(() => {
  document.body.replaceChildren();
});

describe("createDiffView", () => {
  it("split, read-only: merge view, nothing editable, merged = mine", () => {
    const { parent, handle } = mount({});
    expect(parent.querySelector(".diff-view--split .cm-mergeView")).not.toBeNull();
    expect(editable(parent)).toBe(0);
    expect(handle.getMerged()).toBe(MINE);
  });

  it("split, editable: only mine is editable", () => {
    const { parent, handle } = mount({ editable: true });
    expect(editable(parent)).toBe(1);
    expect(handle.getMerged()).toBe(MINE);
  });

  it("unified: one editor whose document is mine", () => {
    const { parent, handle } = mount({ layout: "unified", editable: true });
    expect(parent.querySelectorAll(".diff-view--unified .cm-editor")).toHaveLength(1);
    expect(editable(parent)).toBe(1);
    expect(handle.getMerged()).toBe(MINE);
  });

  it("unified, read-only: nothing editable", () => {
    const { parent } = mount({ layout: "unified" });
    expect(editable(parent)).toBe(0);
  });

  it("destroy removes everything", () => {
    const { parent, handle } = mount({ layout: "unified" });
    handle.destroy();
    expect(parent.children).toHaveLength(0);
  });
});
