import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Notice } from "../__mocks__/obsidian.js";
import { ForceSyncModal, type ForceSyncDeps } from "./ForceSyncModal.js";

beforeEach(() => {
  vi.useFakeTimers();
  Notice.shown = [];
});
afterEach(() => vi.useRealTimers());

async function open(deps: ForceSyncDeps) {
  const modal = new ForceSyncModal(new App() as never, "it", deps);
  modal.open();
  await vi.advanceTimersByTimeAsync(0);
  const root = (modal as unknown as { contentEl: HTMLElement }).contentEl;
  const button = (text: string) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent === text)!;
  return { root, button };
}

describe("ForceSyncModal", () => {
  it("sends the chosen devices only, once one is chosen", async () => {
    const request = vi.fn(async () => {});
    const o = await open({
      devices: async () => [
        { id: "p", name: "iPhone" },
        { id: "t", name: "iPad" },
      ],
      request,
    });
    const go = o.button("Forza");
    expect(go.disabled).toBe(true);
    const boxes = [...o.root.querySelectorAll("input")];
    expect(boxes).toHaveLength(2);
    boxes[1]!.checked = true;
    boxes[1]!.dispatchEvent(new Event("change"));
    expect(go.disabled).toBe(false);
    go.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledWith(["t"]);
    expect(Notice.shown.join(" ")).toContain("alla prossima connessione");
  });

  it("says when there is no other device", async () => {
    const o = await open({ devices: async () => [], request: async () => {} });
    expect(o.root.textContent).toContain("Nessun altro dispositivo");
  });
});
