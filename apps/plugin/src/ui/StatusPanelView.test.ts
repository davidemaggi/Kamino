import { describe, expect, it } from "vitest";
import { makeCtx, TEST_NOW } from "../__mocks__/ui-context.js";
import { WorkspaceLeaf } from "../__mocks__/obsidian.js";
import { conflictScenario } from "../state/scenarios.js";
import type { UiContext } from "./context.js";
import { StatusPanelView } from "./StatusPanelView.js";

async function open(ctx: UiContext, plugin: { app: unknown }) {
  const view = new StatusPanelView(new WorkspaceLeaf(plugin.app as never) as never, ctx);
  await (view as unknown as { open(): Promise<void> }).open();
  const root = (view as unknown as { contentEl: HTMLElement }).contentEl;
  return { view, root };
}
const headings = (root: HTMLElement) => [...root.querySelectorAll("h3")].map((x) => x.textContent);
const buttons = (root: HTMLElement) => [...root.querySelectorAll("button")];

describe("StatusPanelView", () => {
  it("never synced: summary and device only", async () => {
    const { ctx, plugin } = makeCtx();
    const { root } = await open(ctx, plugin);
    expect(root.textContent).toContain("Mai sincronizzato");
    expect(headings(root)).toEqual(["Questo dispositivo"]);
  });

  it("safe: 'Tutto al sicuro', no other sections", async () => {
    const { ctx, state, plugin } = makeCtx();
    state.setSnapshot({ ...state.snapshot(), lastConfirmedAt: TEST_NOW - 60_000 });
    const { root } = await open(ctx, plugin);
    expect(root.textContent).toContain("Tutto al sicuro");
    expect(headings(root)).toEqual(["Questo dispositivo"]);
  });

  it("scenario: all sections in order", async () => {
    const { ctx, state, plugin } = makeCtx();
    state.loadScenario(conflictScenario(TEST_NOW));
    const { root } = await open(ctx, plugin);
    expect(headings(root)).toEqual([
      "Conflitti · 3",
      "Non ancora sul server · 3",
      "In attesa di Wi-Fi · 1",
      "Questo dispositivo",
    ]);
  });

  it("conflict rows open the conflict; 'Risolvi tutti…' opens the bulk modal", async () => {
    const { ctx, state, plugin } = makeCtx();
    state.loadScenario(conflictScenario(TEST_NOW));
    const { root } = await open(ctx, plugin);
    buttons(root)
      .find((b) => b.textContent?.includes("Spesa.md"))!
      .click();
    expect(ctx.openConflict).toHaveBeenCalledWith("c-shopping");
    buttons(root)
      .find((b) => b.textContent === "Risolvi tutti…")!
      .click();
    expect(ctx.openBulkResolve).toHaveBeenCalled();
  });

  it("no 'Risolvi tutti…' with a single conflict", async () => {
    const { ctx, state, plugin } = makeCtx();
    const sc = conflictScenario(TEST_NOW);
    state.loadScenario({ ...sc, conflicts: sc.conflicts.slice(0, 1) });
    const { root } = await open(ctx, plugin);
    expect(buttons(root).some((b) => b.textContent === "Risolvi tutti…")).toBe(false);
  });

  it("pending list shows 5 rows then 'Mostra tutte'", async () => {
    const { ctx, state, plugin } = makeCtx();
    const sc = conflictScenario(TEST_NOW);
    const pending = Array.from({ length: 8 }, (_, i) => ({
      path: `n${i}.md`,
      op: "modify" as const,
      since: TEST_NOW - 60_000,
    }));
    state.loadScenario({ ...sc, pending });
    const { root } = await open(ctx, plugin);
    expect(root.textContent).not.toContain("n7.md");
    buttons(root)
      .find((b) => b.textContent === "Mostra tutte (8)")!
      .click();
    expect(root.textContent).toContain("n7.md");
  });

  it("sync now and upload now call the actions; panel re-renders on change", async () => {
    const { ctx, state, plugin } = makeCtx();
    state.loadScenario(conflictScenario(TEST_NOW));
    const { root } = await open(ctx, plugin);
    buttons(root)
      .find((b) => b.textContent === "Carica ora")!
      .click();
    await Promise.resolve();
    expect(headings(root)).not.toContain("In attesa di Wi-Fi · 1");
    buttons(root)
      .find((b) => b.textContent === "Sincronizza ora")!
      .click();
    await Promise.resolve();
    expect(headings(root)).not.toContain("Non ancora sul server · 3");
  });

  it("stops listening on close", async () => {
    const { ctx, state, plugin } = makeCtx();
    const { view, root } = await open(ctx, plugin);
    await (view as unknown as { close(): Promise<void> }).close();
    const before = root.innerHTML;
    state.loadScenario(conflictScenario(TEST_NOW));
    expect(root.innerHTML).toBe(before);
  });

  it("not linked: 'Collega…' opens the welcome view", async () => {
    const { ctx, state, plugin } = makeCtx();
    state.setLinked(false);
    const { root } = await open(ctx, plugin);
    expect(root.textContent).toContain("Non collegato");
    buttons(root)
      .find((b) => b.textContent === "Collega…")!
      .click();
    expect(ctx.openWelcome).toHaveBeenCalled();
  });

  it("pairing requests appear on top and open the approval", async () => {
    const { ctx, server, plugin } = makeCtx();
    const login = await server.login("https://sync.example", "demo", "demo");
    if (!login.ok) throw new Error("login");
    await server.linkDevice(login.session, "v-notes", "Laptop");
    await server.startPairing();
    const { root } = await open(ctx, plugin);
    server.simulateIncomingClaim("Pixel", "Android");
    expect(headings(root)[0]).toBe("Richieste di collegamento · 1");
    buttons(root)
      .find((b) => b.textContent?.includes("Pixel"))!
      .click();
    expect(ctx.openAddDevice).toHaveBeenCalledWith(
      expect.objectContaining({ deviceName: "Pixel" }),
    );
  });
});
