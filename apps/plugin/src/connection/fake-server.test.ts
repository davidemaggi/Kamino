import { describe, expect, it, vi } from "vitest";
import { FakeServer, VERIFICATION_ALPHABET, type FakeServerOptions } from "./fake-server.js";
import type { ConnectionEvent, LinkInfo } from "./types.js";

const MIN = 60_000;

function make(over: Partial<FakeServerOptions> = {}) {
  let now = Date.UTC(2026, 10, 8, 10, 0);
  let saved: LinkInfo | null = null;
  const events: ConnectionEvent[] = [];
  const server = new FakeServer({
    isMobile: false,
    clock: () => now,
    delay: () => Promise.resolve(),
    random: () => 0.5,
    localFileCount: () => 12,
    pluginVersion: "0.0.0",
    platform: "macOS",
    store: { load: () => saved, save: (l) => (saved = l) },
    autoRun: false,
    ...over,
  });
  server.onChange((e) => events.push(e));
  return { server, events, tick: (ms: number) => (now += ms), saved: () => saved };
}

async function linkedDemo() {
  const ctx = make();
  const login = await ctx.server.login("https://sync.example", "demo", "demo");
  if (!login.ok) throw new Error("login");
  await ctx.server.linkDevice(login.session, "v-notes", "Laptop");
  return ctx;
}

describe("checkServer", () => {
  it.each([
    ["nope", { ok: false, reason: "invalid_url" }],
    ["ftp://sync.example", { ok: false, reason: "invalid_url" }],
    ["https://unreachable.example", { ok: false, reason: "unreachable" }],
    ["https://old.example", { ok: false, reason: "incompatible" }],
    ["https://sync.example", { ok: true, host: "sync.example", insecure: false }],
    ["http://10.0.0.2:8080", { ok: true, host: "10.0.0.2:8080", insecure: true }],
  ])("%s on desktop", async (url, result) => {
    expect(await make().server.checkServer(url)).toEqual(result);
  });

  it("blocks http on mobile", async () => {
    expect(await make({ isMobile: true }).server.checkServer("http://10.0.0.2")).toEqual({
      ok: false,
      reason: "insecure_on_mobile",
    });
  });
});

describe("login", () => {
  const s = "https://sync.example";
  it.each([
    ["demo", "demo", undefined, true],
    ["demo", "wrong", undefined, "bad_credentials"],
    ["nobody", "demo", undefined, "bad_credentials"],
    ["locked", "demo", undefined, "locked"],
    ["demo2fa", "demo", undefined, "totp_required"],
    ["demo2fa", "demo", "000000", "bad_totp"],
    ["demo2fa", "demo", "123456", true],
  ])("%s / %s / %s", async (user, password, totp, expected) => {
    const r = await make().server.login(s, user, password, totp);
    if (expected === true) expect(r.ok).toBe(true);
    else expect(r).toEqual({ ok: false, reason: expected });
  });
});

describe("vaults and linking", () => {
  it("lists vaults for demo, none for demo2fa", async () => {
    const { server } = make();
    const a = await server.login("https://sync.example", "demo", "demo");
    const b = await server.login("https://sync.example", "demo2fa", "demo", "123456");
    if (!a.ok || !b.ok) throw new Error("login");
    expect((await server.listVaults(a.session)).length).toBeGreaterThan(0);
    expect(await server.listVaults(b.session)).toEqual([]);
  });

  it("links, persists, renames and unlinks", async () => {
    const { server, events, saved } = await linkedDemo();
    expect(server.link()).toMatchObject({
      host: "sync.example",
      user: "demo",
      vaultId: "v-notes",
      deviceName: "Laptop",
    });
    expect(saved()).toEqual(server.link());
    expect(events).toContainEqual({ type: "linked" });
    await server.renameDevice("Studio");
    expect(server.link()?.deviceName).toBe("Studio");
    expect(events).toContainEqual({ type: "device_renamed" });
    await server.unlink();
    expect(server.link()).toBeNull();
    expect(saved()).toBeNull();
    expect(events).toContainEqual({ type: "unlinked" });
  });

  it("restores the link from the store", () => {
    const link: LinkInfo = {
      server: "https://s",
      host: "s",
      user: "demo",
      vaultId: "v",
      vaultName: "V",
      deviceName: "D",
    };
    const server = new FakeServer({
      isMobile: false,
      clock: () => 0,
      delay: () => Promise.resolve(),
      random: () => 0,
      localFileCount: () => 0,
      pluginVersion: "0.0.0",
      platform: "macOS",
      store: { load: () => link, save: () => undefined },
      autoRun: false,
    });
    expect(server.link()).toEqual(link);
  });
});

describe("pairing", () => {
  it("full flow on the same instance: offer, claim, request, approve", async () => {
    const { server, events } = await linkedDemo();
    const offer = await server.startPairing();
    expect(offer.link.startsWith("obsidian://kamino?server=")).toBe(true);
    const token = new URL(offer.link).searchParams.get("token")!;
    const claim = await server.claim({ server: "https://sync.example", token }, "iPhone");
    if (!claim.ok) throw new Error("claim");
    expect(claim.code).toHaveLength(4);
    expect([...claim.code].every((c) => VERIFICATION_ALPHABET.includes(c))).toBe(true);
    expect(server.pairingRequests()).toHaveLength(1);
    expect(events.some((e) => e.type === "pairing_request")).toBe(true);
    expect(await server.claimStatus(claim.claimId)).toBe("pending");
    await server.approve(offer.pairingId);
    expect(await server.claimStatus(claim.claimId)).toBe("approved");
    expect(server.pairingRequests()).toEqual([]);
    expect(events).toContainEqual({ type: "pairing_closed", pairingId: offer.pairingId });
  });

  it("deny closes the request and the claim", async () => {
    const { server } = await linkedDemo();
    const offer = await server.startPairing();
    const token = new URL(offer.link).searchParams.get("token")!;
    const claim = await server.claim({ server: "https://sync.example", token }, "iPhone");
    if (!claim.ok) throw new Error("claim");
    await server.deny(offer.pairingId);
    expect(await server.claimStatus(claim.claimId)).toBe("denied");
  });

  it("a second claim is refused and the origin is warned", async () => {
    const { server, events } = await linkedDemo();
    const offer = await server.startPairing();
    const token = new URL(offer.link).searchParams.get("token")!;
    await server.claim({ server: "https://sync.example", token }, "iPhone");
    expect(await server.claim({ server: "https://sync.example", token }, "Other")).toEqual({
      ok: false,
      reason: "already_claimed",
    });
    expect(events).toContainEqual({ type: "pairing_reused", pairingId: offer.pairingId });
  });

  it("offers and claims expire after 10 minutes", async () => {
    const { server, tick } = await linkedDemo();
    const offer = await server.startPairing();
    const token = new URL(offer.link).searchParams.get("token")!;
    const claim = await server.claim({ server: "https://sync.example", token }, "iPhone");
    if (!claim.ok) throw new Error("claim");
    tick(10 * MIN);
    expect(server.pairingRequests()).toEqual([]);
    expect(await server.claimStatus(claim.claimId)).toBe("expired");
  });

  it("approving an expired or already answered request is refused", async () => {
    const { server, tick } = await linkedDemo();
    const offer = await server.startPairing();
    const token = new URL(offer.link).searchParams.get("token")!;
    const claim = await server.claim({ server: "https://sync.example", token }, "iPhone");
    if (!claim.ok) throw new Error("claim");
    tick(10 * 60_000);
    await expect(server.approve(offer.pairingId)).rejects.toThrow();
    expect(await server.claimStatus(claim.claimId)).toBe("expired");
  });

  it("answering twice is refused", async () => {
    const { server } = await linkedDemo();
    const offer = await server.startPairing();
    const token = new URL(offer.link).searchParams.get("token")!;
    await server.claim({ server: "https://sync.example", token }, "iPhone");
    await server.deny(offer.pairingId);
    await expect(server.approve(offer.pairingId)).rejects.toThrow();
  });

  it("special tokens simulate remote errors", async () => {
    const { server } = make();
    expect(await server.claim({ server: "https://s", token: "expired" }, "X")).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(await server.claim({ server: "https://s", token: "used" }, "X")).toEqual({
      ok: false,
      reason: "already_claimed",
    });
    expect(await server.claim({ server: "https://s", token: "bad" }, "X")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("a remote claim is answered by the dev simulation and approval links the device", async () => {
    const { server, events } = make();
    const claim = await server.claim({ server: "https://sync.example", token: "remote" }, "iPhone");
    if (!claim.ok) throw new Error("claim");
    expect(claim.host).toBe("sync.example");
    server.simulateClaimAnswer("approved");
    expect(await server.claimStatus(claim.claimId)).toBe("approved");
    expect(server.link()).toMatchObject({ host: "sync.example", deviceName: "iPhone" });
    expect(events).toContainEqual({ type: "linked" });
  });

  it("simulateIncomingClaim creates a request for an open offer", async () => {
    const { server } = await linkedDemo();
    await server.startPairing();
    server.simulateIncomingClaim("Pixel", "Android");
    expect(server.pairingRequests()[0]).toMatchObject({ deviceName: "Pixel", platform: "Android" });
  });

  it("cancelPairing closes the offer", async () => {
    const { server, events } = await linkedDemo();
    const offer = await server.startPairing();
    await server.cancelPairing(offer.pairingId);
    expect(events).toContainEqual({ type: "pairing_closed", pairingId: offer.pairingId });
  });
});

describe("initial transfer", () => {
  it("upload of the local files: advance, pause, resume, done", () => {
    const { server } = make();
    const listener = vi.fn();
    server.transfer.onChange(listener);
    expect(server.transfer.progress()).toBeNull();
    server.transfer.start("upload");
    expect(server.transfer.progress()).toMatchObject({
      direction: "upload",
      phase: "running",
      files: { done: 0, total: 12 },
    });
    server.advance(5);
    expect(server.transfer.progress()?.files.done).toBe(5);
    server.transfer.pause();
    expect(server.transfer.progress()?.phase).toBe("paused");
    server.advance(1);
    expect(server.transfer.progress()?.files.done).toBe(5);
    server.transfer.resume();
    server.advance(100);
    expect(server.transfer.progress()).toMatchObject({
      phase: "done",
      files: { done: 12, total: 12 },
    });
    expect(listener).toHaveBeenCalled();
  });

  it("interruption, failure and retry", () => {
    const { server } = make();
    server.transfer.start("download");
    server.interruptTransfer();
    expect(server.transfer.progress()?.phase).toBe("interrupted");
    server.failTransfer();
    expect(server.transfer.progress()?.phase).toBe("failed");
    server.transfer.retry();
    expect(server.transfer.progress()?.phase).toBe("running");
  });

  it("unlink clears the transfer", async () => {
    const { server } = await linkedDemo();
    server.transfer.start("upload");
    await server.unlink();
    expect(server.transfer.progress()).toBeNull();
  });
});
