import { Notice } from "../__mocks__/obsidian.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigReloadPrompt } from "./config-reload.js";

beforeEach(() => {
  Notice.shown = [];
});

describe("ConfigReloadPrompt", () => {
  it("shows one notice with a reload button, and doesn't repeat it", () => {
    const reload = vi.fn();
    const p = new ConfigReloadPrompt({ text: "changed", button: "Reload" }, reload);
    p.configApplied();
    p.configApplied();
    expect(Notice.shown).toEqual(["changed"]);
    const button = Notice.last!.messageEl.querySelector("button")!;
    expect(button.textContent).toBe("Reload");
    button.click();
    expect(reload).toHaveBeenCalledOnce();
  });
});
