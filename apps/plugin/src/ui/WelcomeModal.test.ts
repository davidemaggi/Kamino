import { describe, expect, it } from "vitest";
import { App } from "../__mocks__/obsidian.js";
import { makeCtx } from "../__mocks__/ui-context.js";
import { WelcomeModal } from "./WelcomeModal.js";

function open() {
  const made = makeCtx();
  const modal = new WelcomeModal(new App() as never, made.ctx);
  modal.open();
  const root = (modal as unknown as { contentEl: HTMLElement }).contentEl;
  const isOpen = () => (modal as unknown as { isOpen: boolean }).isOpen;
  const choice = (text: string) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;
  return { ...made, modal, root, choice, isOpen };
}

// Settings and the status panel open this, not the welcome tab: a tab opens behind the
// settings window (and behind the drawer on mobile), so the button seemed to do nothing.
describe("WelcomeModal", () => {
  it("shows the three choices on top of whatever is open", () => {
    const { root } = open();
    expect([...root.querySelectorAll("button b")].map((b) => b.textContent)).toEqual([
      "È il primo dispositivo",
      "Collega a un vault esistente",
      "Ho un QR o un link",
    ]);
  });

  it("a choice closes it and opens the connect flow", () => {
    const { ctx, choice, isOpen } = open();
    choice("Collega a un vault esistente").click();
    expect(ctx.openConnect).toHaveBeenCalledWith("join");
    expect(isOpen()).toBe(false);
  });

  it("a pasted link closes it and starts the claim", () => {
    const { ctx, root, choice, isOpen } = open();
    choice("Ho un QR o un link").click();
    (root.querySelector("input") as HTMLInputElement).value =
      "obsidian://kamino?server=https%3A%2F%2Fsync.example&token=abc";
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Collega")!.click();
    expect(ctx.openClaim).toHaveBeenCalledWith({ server: "https://sync.example", token: "abc" });
    expect(isOpen()).toBe(false);
  });

  it("closes itself when the vault gets linked", async () => {
    const { server, isOpen } = open();
    const login = await server.login("https://sync.example", "demo", "demo");
    if (!login.ok) throw new Error("login");
    await server.linkDevice(login.session, "v-notes", "Laptop");
    expect(isOpen()).toBe(false);
  });
});
