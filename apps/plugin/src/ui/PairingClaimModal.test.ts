import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../__mocks__/obsidian.js";
import { makeCtx } from "../__mocks__/ui-context.js";
import { PairingClaimModal } from "./PairingClaimModal.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function open(token = "remote", files = 0) {
  const made = makeCtx();
  made.plugin.app.vault.files = Array.from({ length: files }, (_, i) => ({ path: `n${i}.md` }));
  const modal = new PairingClaimModal(new App() as never, made.ctx, {
    server: "https://sync.example",
    token,
  });
  modal.open();
  const root = (modal as unknown as { contentEl: HTMLElement }).contentEl;
  const click = async (text: string) => {
    [...root.querySelectorAll("button")].find((b) => b.textContent === text)!.click();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { ...made, modal, root, click };
}

describe("PairingClaimModal", () => {
  it("shows the host and the device name, then the code", async () => {
    const o = await open();
    expect(o.root.querySelector("h2")?.textContent).toBe("Collegamento a sync.example");
    await o.click("Collega");
    expect(o.root.querySelector(".kamino-pairing__code")?.textContent).toHaveLength(4);
    expect(o.root.textContent).toContain("In attesa di approvazione");
  });

  it("approved without local files: starts the download", async () => {
    const o = await open();
    await o.click("Collega");
    const start = vi.spyOn(o.ctx.transfer, "start");
    o.server.simulateClaimAnswer("approved");
    await vi.advanceTimersByTimeAsync(2000);
    expect(start).toHaveBeenCalledWith("download");
    expect(o.ctx.openTransfer).toHaveBeenCalled();
  });

  it("approved with local files: reconciliation; cancel unlinks", async () => {
    const o = await open("remote", 5);
    await o.click("Collega");
    o.server.simulateClaimAnswer("approved");
    await vi.advanceTimersByTimeAsync(2000);
    expect(o.root.textContent).toContain("Questo vault contiene già 5 file");
    await o.click("Annulla");
    expect(o.server.link()).toBeNull();
  });

  it("denied", async () => {
    const o = await open();
    await o.click("Collega");
    o.server.simulateClaimAnswer("denied");
    await vi.advanceTimersByTimeAsync(2000);
    expect(o.root.textContent).toContain("Collegamento rifiutato dall'altro dispositivo.");
  });

  it.each([
    ["expired", "Tempo scaduto"],
    ["used", "Il link è già stato usato."],
    ["bad", "Il link non è valido."],
  ])("claim error %s", async (token, text) => {
    const o = await open(token);
    await o.click("Collega");
    expect(o.root.textContent).toContain(text);
  });

  it("stops polling when closed", async () => {
    const o = await open();
    await o.click("Collega");
    const spy = vi.spyOn(o.server, "claimStatus");
    o.modal.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spy).not.toHaveBeenCalled();
  });
});
