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

  it("an unreachable server or an http link on a phone says why", async () => {
    for (const [reason, text] of [
      ["unreachable", "Server non raggiungibile"],
      ["insecure_on_mobile", "Su telefono serve un indirizzo https://"],
    ] as const) {
      const made = makeCtx();
      vi.spyOn(made.server, "claim").mockResolvedValueOnce({ ok: false, reason });
      const modal = new PairingClaimModal(new App() as never, made.ctx, {
        server: "https://sync.example",
        token: "remote",
      });
      modal.open();
      const root = (modal as unknown as { contentEl: HTMLElement }).contentEl;
      [...root.querySelectorAll("button")].find((b) => b.textContent === "Collega")!.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(root.textContent).toContain(text);
    }
  });

  it("stops polling when closed", async () => {
    const o = await open();
    await o.click("Collega");
    const spy = vi.spyOn(o.server, "claimStatus");
    o.modal.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spy).not.toHaveBeenCalled();
  });

  it("closing while the claim is in flight cancels it and never links", async () => {
    const o = await open();
    let release: (v: Awaited<ReturnType<typeof o.server.claim>>) => void = () => undefined;
    const real = o.server.claim.bind(o.server);
    vi.spyOn(o.server, "claim").mockImplementation(
      (link, name) => new Promise((r) => void real(link, name).then((v) => (release = () => r(v)))),
    );
    const cancel = vi.spyOn(o.server, "cancelClaim");
    const start = vi.spyOn(o.ctx.transfer, "start");
    [...o.root.querySelectorAll("button")].find((b) => b.textContent === "Collega")!.click();
    await vi.advanceTimersByTimeAsync(0);
    o.modal.close();
    release(undefined as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalled();
    o.server.simulateClaimAnswer("approved");
    await vi.advanceTimersByTimeAsync(5000);
    expect(start).not.toHaveBeenCalled();
  });

  it("closing on the reconciliation step after approval unlinks", async () => {
    const o = await open("remote", 5);
    await o.click("Collega");
    o.server.simulateClaimAnswer("approved");
    await vi.advanceTimersByTimeAsync(2000);
    expect(o.root.textContent).toContain("Questo vault contiene già 5 file");
    o.modal.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(o.server.link()).toBeNull();
  });

  it("the countdown does not rebuild the window (focus stays on Cancel)", async () => {
    const o = await open();
    await o.click("Collega");
    await vi.advanceTimersByTimeAsync(0);
    expect(o.root.querySelector(".kamino-pairing__code")).not.toBeNull();
    const cancel = [...o.root.querySelectorAll("button")].find((b) => b.textContent === "Annulla")!;
    await vi.advanceTimersByTimeAsync(3000);
    // Same element: the window was not rebuilt (the modal content is detached in the mock, so no isConnected).
    expect([...o.root.querySelectorAll("button")].find((b) => b.textContent === "Annulla")).toBe(
      cancel,
    );
    expect(o.root.textContent).toContain("scade tra");
  });
});
