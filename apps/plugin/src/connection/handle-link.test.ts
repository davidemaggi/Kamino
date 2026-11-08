import { beforeEach, describe, expect, it } from "vitest";
import { Notice } from "../__mocks__/obsidian.js";
import { makeCtx } from "../__mocks__/ui-context.js";
import { handlePairingLink } from "./handle-link.js";
import { watchPairingEvents } from "./pairing-notices.js";

beforeEach(() => {
  Notice.shown = [];
});

describe("handlePairingLink", () => {
  it("invalid link: notice, no flow", () => {
    const { ctx } = makeCtx();
    handlePairingLink({ action: "kamino", token: "x" }, ctx);
    expect(Notice.shown).toEqual(["Link di collegamento non valido."]);
    expect(ctx.openClaim).not.toHaveBeenCalled();
  });

  it("valid link: opens the claim", () => {
    const { ctx } = makeCtx();
    handlePairingLink({ action: "kamino", server: "https://sync.example", token: "abc" }, ctx);
    expect(ctx.openClaim).toHaveBeenCalledWith({ server: "https://sync.example", token: "abc" });
  });

  it("http on mobile: blocked", () => {
    const { ctx } = makeCtx({ isMobile: true });
    handlePairingLink({ action: "kamino", server: "http://10.0.0.2", token: "abc" }, ctx);
    expect(ctx.openClaim).not.toHaveBeenCalled();
    expect(Notice.shown[0]).toContain("Su telefono serve un indirizzo https://");
  });

  it("already linked: explains, no flow", async () => {
    const { ctx, server } = makeCtx();
    const login = await server.login("https://sync.example", "demo", "demo");
    if (!login.ok) throw new Error("login");
    await server.linkDevice(login.session, "v-notes", "Laptop");
    handlePairingLink({ action: "kamino", server: "https://sync.example", token: "abc" }, ctx);
    expect(ctx.confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmText: null }));
    expect(ctx.openClaim).not.toHaveBeenCalled();
  });
});

describe("watchPairingEvents", () => {
  it("notifies requests (clickable), joined devices and reused links", async () => {
    const { ctx, server } = makeCtx();
    watchPairingEvents(ctx);
    const login = await server.login("https://sync.example", "demo", "demo");
    if (!login.ok) throw new Error("login");
    await server.linkDevice(login.session, "v-notes", "Laptop");
    await server.startPairing();
    server.simulateIncomingClaim("Pixel");
    expect(Notice.shown).toEqual([
      "Un nuovo dispositivo chiede di collegarsi. Tocca per rispondere.",
    ]);
    Notice.last!.noticeEl.click();
    expect(ctx.openAddDevice).toHaveBeenCalledWith(
      expect.objectContaining({ deviceName: "Pixel" }),
    );
    server.simulateDeviceJoined("iPad");
    expect(Notice.shown.at(-1)).toBe("Nuovo dispositivo collegato: iPad.");
  });
});
