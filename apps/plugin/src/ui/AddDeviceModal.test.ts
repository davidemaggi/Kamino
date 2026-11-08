import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Notice } from "../__mocks__/obsidian.js";
import { makeCtx } from "../__mocks__/ui-context.js";
import { AddDeviceModal } from "./AddDeviceModal.js";

beforeEach(() => {
  vi.useFakeTimers();
  Notice.shown = [];
});
afterEach(() => {
  vi.useRealTimers();
});

async function open() {
  const made = makeCtx();
  const login = await made.server.login("https://sync.example", "demo", "demo");
  if (!login.ok) throw new Error("login");
  await made.server.linkDevice(login.session, "v-notes", "Laptop");
  const modal = new AddDeviceModal(new App() as never, made.ctx);
  modal.open();
  await vi.advanceTimersByTimeAsync(0);
  const root = (modal as unknown as { contentEl: HTMLElement }).contentEl;
  const click = async (text: string) => {
    [...root.querySelectorAll("button")].find((b) => b.textContent === text)!.click();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { ...made, modal, root, click };
}

describe("AddDeviceModal", () => {
  it("shows the QR, the link and the validity", async () => {
    const o = await open();
    const img = o.root.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("Codice QR per collegare un dispositivo");
    expect(img.getAttribute("src")?.startsWith("data:image/svg+xml,")).toBe(true);
    expect(
      (o.root.querySelector("input") as HTMLInputElement).value.startsWith("obsidian://kamino?"),
    ).toBe(true);
    expect(o.root.textContent).toContain("usabile una volta sola");
  });

  it("an incoming request turns the window into the approval", async () => {
    const o = await open();
    o.server.simulateIncomingClaim("Pixel", "Android");
    await vi.advanceTimersByTimeAsync(0);
    expect(o.root.textContent).toContain("Nuovo dispositivo: “Pixel”");
    expect(o.root.querySelector(".kamino-pairing__code")?.textContent).toHaveLength(4);
    const approve = vi.spyOn(o.server, "approve");
    await o.click("Approva");
    expect(approve).toHaveBeenCalled();
    expect(o.root.textContent).toContain("Dispositivo collegato.");
  });

  it("deny", async () => {
    const o = await open();
    o.server.simulateIncomingClaim();
    await vi.advanceTimersByTimeAsync(0);
    await o.click("Rifiuta");
    expect(o.root.textContent).toContain("Richiesta rifiutata.");
  });

  it("expiry offers to generate again", async () => {
    const o = await open();
    const now = o.ctx.now();
    o.ctx.now = () => now + 11 * 60_000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(o.root.textContent).toContain("Codice scaduto.");
    await o.click("Genera di nuovo");
    expect(o.root.querySelector("img")).not.toBeNull();
  });

  it("is showing its pairing while open, not after close", async () => {
    const o = await open();
    const id = (o.modal as unknown as { pairingId: string }).pairingId;
    expect(AddDeviceModal.isShowing(id)).toBe(true);
    o.modal.close();
    expect(AddDeviceModal.isShowing(id)).toBe(false);
  });

  it("opened on an existing request shows the approval directly", async () => {
    const made = makeCtx();
    const login = await made.server.login("https://sync.example", "demo", "demo");
    if (!login.ok) throw new Error("login");
    await made.server.linkDevice(login.session, "v-notes", "Laptop");
    await made.server.startPairing();
    made.server.simulateIncomingClaim("Pixel");
    const request = made.server.pairingRequests()[0]!;
    const modal = new AddDeviceModal(new App() as never, made.ctx, request);
    modal.open();
    await vi.advanceTimersByTimeAsync(0);
    const root = (modal as unknown as { contentEl: HTMLElement }).contentEl;
    expect(root.textContent).toContain("Nuovo dispositivo: “Pixel”");
  });
});
