import { describe, expect, it } from "vitest";
import { ObsidianNetwork } from "./obsidian-network.js";

const net = (o: Partial<ConstructorParameters<typeof ObsidianNetwork>[0]>) =>
  new ObsidianNetwork({
    isMobile: true,
    isIos: false,
    connection: () => undefined,
    confirm: async () => ({ ok: false, dontAsk: false }),
    ...o,
  });

describe("ObsidianNetwork (S-08)", () => {
  it("desktop is never metered", () => {
    expect(net({ isMobile: false, connection: () => ({ type: "cellular" }) }).kind()).toBe("free");
  });

  it("reads navigator.connection on Android", () => {
    expect(net({ connection: () => ({ type: "cellular" }) }).kind()).toBe("metered");
    expect(net({ connection: () => ({ type: "wifi", saveData: true }) }).kind()).toBe("metered");
    expect(net({ connection: () => ({ type: "wifi" }) }).kind()).toBe("free");
    expect(net({ connection: () => ({ type: "ethernet" }) }).kind()).toBe("free");
    expect(net({ connection: () => undefined }).kind()).toBe("free");
  });

  it("iOS asks; 'don't ask again' makes it free for the session", async () => {
    let answer = { ok: true, dontAsk: false };
    const n = net({ isIos: true, confirm: async () => answer });
    expect(n.kind()).toBe("ask");
    expect(await n.ask()).toBe(true);
    expect(n.kind()).toBe("ask");
    answer = { ok: true, dontAsk: true };
    await n.ask();
    expect(n.kind()).toBe("free");
  });
});
