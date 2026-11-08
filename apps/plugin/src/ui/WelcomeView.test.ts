import { describe, expect, it } from "vitest";
import { WorkspaceLeaf } from "../__mocks__/obsidian.js";
import { makeCtx } from "../__mocks__/ui-context.js";
import type { UiContext } from "./context.js";
import { WelcomeView } from "./WelcomeView.js";
import { WELCOME_VIEW } from "./workspace.js";

async function open(over: Partial<UiContext> = {}) {
  const made = makeCtx(over);
  made.plugin.registerView(
    WELCOME_VIEW,
    (leaf) => new WelcomeView(leaf as never, made.ctx) as never,
  );
  const leaf = new WorkspaceLeaf(made.plugin.app);
  await leaf.setViewState({ type: WELCOME_VIEW });
  const root = leaf.view!.contentEl;
  const button = (text: string) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  return { ...made, leaf, root, button };
}

describe("WelcomeView", () => {
  it("shows the product name and the three choices", async () => {
    const { root } = await open();
    expect(root.querySelector("h2")?.textContent).toBe("Benvenuto in Kamino");
    expect([...root.querySelectorAll("button b")].map((b) => b.textContent)).toEqual([
      "È il primo dispositivo",
      "Collega a un vault esistente",
      "Ho un QR o un link",
    ]);
  });

  it("first two choices open the connect flow", async () => {
    const { ctx, button } = await open();
    button("È il primo dispositivo")!.click();
    expect(ctx.openConnect).toHaveBeenCalledWith("create");
    button("Collega a un vault esistente")!.click();
    expect(ctx.openConnect).toHaveBeenCalledWith("join");
  });

  it("desktop: paste a link to start the claim", async () => {
    const { ctx, root, button } = await open();
    button("Ho un QR o un link")!.click();
    const input = root.querySelector("input") as HTMLInputElement;
    input.value = "nonsense";
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Collega")!.click();
    expect(root.textContent).toContain("Questo non è un link di collegamento valido.");
    input.value = "obsidian://kamino?server=https%3A%2F%2Fsync.example&token=abc";
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Collega")!.click();
    expect(ctx.openClaim).toHaveBeenCalledWith({ server: "https://sync.example", token: "abc" });
  });

  it("mobile: instructions only, no paste field", async () => {
    const { root, button } = await open({ isMobile: true });
    button("Ho un QR o un link")!.click();
    expect(root.textContent).toContain("Inquadra il QR con la fotocamera del telefono");
    expect(root.querySelector("input")).toBeNull();
  });

  it("closes itself when the vault gets linked", async () => {
    const { server, leaf } = await open();
    const login = await server.login("https://sync.example", "demo", "demo");
    if (!login.ok) throw new Error("login");
    await server.linkDevice(login.session, "v-notes", "Laptop");
    expect(leaf.view).toBeNull();
  });
});
