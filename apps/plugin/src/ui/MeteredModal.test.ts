import { describe, expect, it } from "vitest";
import { App } from "../__mocks__/obsidian.js";
import { MeteredModal } from "./MeteredModal.js";

describe("MeteredModal", () => {
  it("remembers 'don't ask again' only with a yes; closing means wait", () => {
    const answers: { ok: boolean; dontAsk: boolean }[] = [];
    const m = new MeteredModal(new App() as never, "it", (r) => answers.push(r));
    m.open();
    const el = (m as unknown as { contentEl: HTMLElement }).contentEl;
    const box = el.querySelector("input")!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    [...el.querySelectorAll("button")].find((b) => b.textContent === "Usa questa rete")!.click();
    expect(answers).toEqual([{ ok: true, dontAsk: true }]);
    const m2 = new MeteredModal(new App() as never, "it", (r) => answers.push(r));
    m2.open();
    m2.close();
    expect(answers.at(-1)).toEqual({ ok: false, dontAsk: false });
  });
});
