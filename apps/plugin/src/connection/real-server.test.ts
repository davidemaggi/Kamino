import type { Http, HttpRequest, HttpResponse } from "@kamino/sync-engine";
import { describe, expect, it } from "vitest";
import type { LinkStore } from "./fake-server.js";
import { RealConnection, type StoredLink } from "./real-server.js";
import type { ConnectionEvent, LinkInfo } from "./types.js";

const err = (status: number, code: string): HttpResponse => ({
  status,
  json: { error: { code, message: code, retryable: false } },
});

function setup(
  handler: (r: HttpRequest, server: string) => HttpResponse | Promise<HttpResponse>,
  isMobile = false,
  extra: { linked?: StoredLink; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
) {
  let stored: LinkInfo | null = extra.linked ?? null;
  const store: LinkStore = { load: () => stored, save: (l) => (stored = l) };
  const log: Array<HttpRequest & { server: string }> = [];
  const conn = new RealConnection({
    isMobile,
    store,
    pluginVersion: "0.1.0",
    platform: "linux",
    http: (server): Http => ({
      request: async (r) => {
        log.push({ ...r, server });
        return handler(r, server);
      },
    }),
    ...(extra.now ? { now: extra.now } : {}),
    // Default: the fallback polling never wakes up unless a test drives it.
    sleep: extra.sleep ?? (() => new Promise<void>(() => {})),
  });
  const events: ConnectionEvent[] = [];
  conn.onChange((e) => events.push(e));
  return { conn, log, events, stored: () => stored as StoredLink | null };
}

const version = {
  status: 200,
  json: { version: "1", codename: "x", protocol: { min: 1, max: 1 }, commit: "c", buildDate: "d" },
};

describe("RealConnection", () => {
  it("checks the server: address, https on mobile, reachability, protocol", async () => {
    const { conn } = setup((r) => (r.path === "/version" ? version : err(404, "not_found")));
    expect(await conn.checkServer("not a url")).toEqual({ ok: false, reason: "invalid_url" });
    expect(await conn.checkServer("https://sync.example.org")).toEqual({
      ok: true,
      host: "sync.example.org",
      insecure: false,
    });
    expect((await conn.checkServer("http://nas.local:8080")).ok).toBe(true);
    const mobile = setup(() => version, true).conn;
    expect(await mobile.checkServer("http://nas.local")).toEqual({
      ok: false,
      reason: "insecure_on_mobile",
    });
    const old = setup(() => ({
      ...version,
      json: { ...version.json, protocol: { min: 9, max: 9 } },
    }));
    expect(await old.conn.checkServer("https://s")).toEqual({ ok: false, reason: "incompatible" });
    const down = setup(() => {
      throw new Error("offline");
    });
    expect(await down.conn.checkServer("https://s")).toEqual({ ok: false, reason: "unreachable" });
  });

  it("logs in with the TOTP in the same request and maps the server's answers", async () => {
    let answer: HttpResponse = {
      status: 200,
      json: { status: "ok", enrollToken: "enr", expiresAt: "2026-11-11T10:00:00Z" },
    };
    const { conn, log } = setup(() => answer);
    const ok = await conn.login("https://s", "ada", "pw", "123456");
    expect(ok).toEqual({
      ok: true,
      session: {
        server: "https://s",
        user: "ada",
        expiresAt: Date.parse("2026-11-11T10:00:00Z"),
        token: "enr",
      },
    });
    expect(log[0]).toMatchObject({
      path: "/devices/login",
      json: { username: "ada", totp: "123456" },
    });
    const cases: Array<[HttpResponse, string]> = [
      [{ status: 200, json: { status: "totp_required" } }, "totp_required"],
      [err(401, "invalid_credentials"), "bad_credentials"],
      [err(401, "totp_invalid"), "bad_totp"],
      [err(403, "totp_mandatory"), "totp_mandatory"],
      [err(429, "rate_limited"), "rate_limited"],
      [err(403, "user_blocked"), "locked"],
      [{ status: 502 }, "unreachable"],
      [err(426, "protocol_unsupported"), "update_required"],
    ];
    for (const [res, reason] of cases) {
      answer = res;
      expect(await conn.login("https://s", "ada", "pw")).toEqual({ ok: false, reason });
    }
    const down = setup(() => {
      throw new Error("offline");
    });
    expect(await down.conn.login("https://s", "a", "p")).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  it("lists, creates and links a vault, keeping the device token out of link()", async () => {
    const { conn, log, events, stored } = setup((r) => {
      if (r.path === "/enroll/vaults" && r.method === "GET")
        return {
          status: 200,
          json: { vaults: [{ id: "v1", name: "Notes", fileCount: 3, deviceCount: 1 }] },
        };
      if (r.path === "/enroll/vaults")
        return { status: 200, json: { id: "v2", name: "New", fileCount: 0, deviceCount: 0 } };
      return {
        status: 200,
        json: { deviceId: "d1", deviceToken: "secret", vault: { id: "v1", name: "Notes" } },
      };
    });
    const session = {
      server: "https://sync.example.org/",
      user: "ada",
      expiresAt: 0,
      token: "enr",
    };
    expect(await conn.listVaults(session)).toEqual([
      { id: "v1", name: "Notes", fileCount: 3, deviceCount: 1 },
    ]);
    expect((await conn.createVault(session, "New")).id).toBe("v2");
    const info = await conn.linkDevice(session, "v1", "Laptop");
    expect(info).toEqual({
      server: "https://sync.example.org",
      host: "sync.example.org",
      user: "ada",
      vaultId: "v1",
      vaultName: "Notes",
      deviceName: "Laptop",
    });
    expect(log.at(-1)).toMatchObject({
      path: "/enroll/vaults/v1/devices",
      headers: { authorization: "Bearer enr" },
      json: { name: "Laptop", platform: "linux", pluginVersion: "0.1.0" },
    });
    expect(stored()).toMatchObject({ deviceId: "d1", deviceToken: "secret" });
    expect(conn.link()).toEqual(info);
    expect(conn.credentials()).toEqual({ deviceId: "d1", deviceToken: "secret" });
    expect(events).toEqual([{ type: "linked" }]);
  });

  it("renames and unlinks with the device token; unlinking works even if the server refuses", async () => {
    let refuse = false;
    const { conn, log, events, stored } = setup((r) => {
      if (r.path === "/enroll/vaults/v1/devices")
        return {
          status: 200,
          json: { deviceId: "d1", deviceToken: "secret", vault: { id: "v1", name: "N" } },
        };
      return refuse ? err(401, "device_revoked") : { status: 204 };
    });
    await conn.linkDevice({ server: "https://s", user: "u", expiresAt: 0, token: "e" }, "v1", "A");
    await conn.renameDevice("B");
    expect(log.at(-1)).toMatchObject({
      method: "PATCH",
      path: "/device",
      headers: { authorization: "Bearer secret" },
    });
    expect(conn.link()?.deviceName).toBe("B");
    refuse = true;
    await conn.unlink();
    expect(stored()).toBeNull();
    expect(conn.link()).toBeNull();
    expect(events.map((e) => e.type)).toEqual(["linked", "device_renamed", "unlinked"]);
  });

  const LINKED: StoredLink = {
    server: "https://sync.example.org",
    host: "sync.example.org",
    user: "ada",
    vaultId: "v1",
    vaultName: "Notes",
    deviceName: "Mac",
    deviceId: "d1",
    deviceToken: "dev-token",
  };
  const EXPIRES = "2026-11-13T10:10:00.000Z";
  const LINK = { server: "https://sync.example.org/", token: "link-token" };

  it("new device: claims, shows the code, and on approval stores the token once", async () => {
    let answer: HttpResponse = { status: 200, json: { status: "pending" } };
    const { conn, log, events, stored } = setup((r) => {
      if (r.path === "/pairings/claim")
        return {
          status: 200,
          json: {
            claimId: "c1",
            claimSecret: "claim-secret",
            verificationCode: "AB3K",
            expiresAt: EXPIRES,
          },
        };
      return answer;
    });
    const c = await conn.claim(LINK, "iPhone");
    expect(c).toEqual({
      ok: true,
      claimId: "c1",
      code: "AB3K",
      expiresAt: Date.parse(EXPIRES),
      host: "sync.example.org",
    });
    expect(log[0]).toMatchObject({
      server: "https://sync.example.org",
      method: "POST",
      path: "/pairings/claim",
      json: {
        token: "link-token",
        deviceName: "iPhone",
        platform: "linux",
        pluginVersion: "0.1.0",
      },
    });
    expect(log[0]!.headers?.["authorization"]).toBeUndefined();
    expect(await conn.claimStatus("c1")).toBe("pending");
    expect(log.at(-1)).toMatchObject({
      method: "GET",
      path: "/pairings/claims/c1",
      headers: { authorization: "Claim claim-secret" },
    });
    expect(stored()).toBeNull();

    answer = {
      status: 200,
      json: {
        status: "approved",
        deviceId: "d9",
        deviceToken: "new-token",
        username: "ada",
        vault: { id: "v1", name: "Notes" },
      },
    };
    expect(await conn.claimStatus("c1")).toBe("approved");
    expect(stored()).toEqual({
      server: "https://sync.example.org",
      host: "sync.example.org",
      user: "ada",
      vaultId: "v1",
      vaultName: "Notes",
      deviceName: "iPhone",
      deviceId: "d9",
      deviceToken: "new-token",
    });
    expect(JSON.stringify(stored())).not.toContain("claim-secret");
    expect(events).toEqual([{ type: "linked" }]);
    // The answer is kept: no further polls, no second "linked".
    const before = log.length;
    expect(await conn.claimStatus("c1")).toBe("approved");
    expect(log.length).toBe(before);
    expect(await conn.claimStatus("unknown")).toBe("expired");
  });

  it("polls in flight are shared, so a second poll can't see the token as already consumed", async () => {
    let release!: (r: HttpResponse) => void;
    let polls = 0;
    const { conn, events } = setup((r) => {
      if (r.path === "/pairings/claim")
        return {
          status: 200,
          json: { claimId: "c1", claimSecret: "s", verificationCode: "AB3K", expiresAt: EXPIRES },
        };
      polls++;
      return new Promise<HttpResponse>((res) => (release = res));
    });
    await conn.claim(LINK, "iPhone");
    const a = conn.claimStatus("c1");
    const b = conn.claimStatus("c1");
    await Promise.resolve();
    release({
      status: 200,
      json: {
        status: "approved",
        deviceId: "d9",
        deviceToken: "t",
        username: "ada",
        vault: { id: "v1", name: "Notes" },
      },
    });
    expect(await Promise.all([a, b])).toEqual(["approved", "approved"]);
    expect(polls).toBe(1);
    expect(events).toEqual([{ type: "linked" }]);
  });

  it("maps the claim's failures and the other side's answers", async () => {
    let claimAnswer: HttpResponse = err(400, "token_invalid");
    let poll: HttpResponse = { status: 200, json: { status: "denied" } };
    const { conn, log } = setup((r) => {
      if (r.path === "/pairings/claim") return claimAnswer;
      return r.path.endsWith("/cancel") ? { status: 204 } : poll;
    });
    const cases: Array<[HttpResponse, string]> = [
      [err(400, "token_invalid"), "invalid"],
      [err(410, "token_expired"), "expired"],
      [err(409, "pairing_already_claimed"), "already_claimed"],
      [err(426, "protocol_unsupported"), "incompatible"],
      [{ status: 502 }, "unreachable"],
    ];
    for (const [res, reason] of cases) {
      claimAnswer = res;
      expect(await conn.claim(LINK, "iPhone")).toEqual({ ok: false, reason });
    }
    const down = setup(() => {
      throw new Error("offline");
    });
    expect(await down.conn.claim(LINK, "x")).toEqual({ ok: false, reason: "unreachable" });
    const phone = setup(() => version, true);
    expect(await phone.conn.claim({ server: "http://nas.local", token: "t" }, "x")).toEqual({
      ok: false,
      reason: "insecure_on_mobile",
    });
    expect(phone.log).toEqual([]);

    const ok = {
      status: 200,
      json: { claimId: "c1", claimSecret: "s", verificationCode: "AB3K", expiresAt: EXPIRES },
    };
    for (const [state, want] of [
      ["denied", "denied"],
      ["expired", "expired"],
      ["consumed", "expired"],
    ] as const) {
      claimAnswer = ok;
      poll = { status: 200, json: { status: state } };
      await conn.claim(LINK, "iPhone");
      expect(await conn.claimStatus("c1")).toBe(want);
    }
    // Withdrawing while waiting tells the server, with the claim secret.
    claimAnswer = ok;
    await conn.claim(LINK, "iPhone");
    await conn.cancelClaim("c1");
    expect(log.at(-1)).toMatchObject({
      method: "POST",
      path: "/pairings/claims/c1/cancel",
      headers: { authorization: "Claim s" },
    });
    expect(await conn.claimStatus("c1")).toBe("expired");
  });

  it("origin: offers, hears the request over realtime, answers with the device token", async () => {
    const { conn, log, events } = setup(
      (r) => {
        if (r.path === "/vaults/v1/pairings")
          return {
            status: 200,
            json: { pairingId: "p1", link: "obsidian://kamino?x", expiresAt: EXPIRES },
          };
        if (r.path === "/pairings/p2/deny") return err(409, "pairing_closed");
        return { status: 200, json: { status: "approved" } };
      },
      false,
      { linked: LINKED, now: () => Date.parse(EXPIRES) - 60_000 },
    );
    expect(conn.pairingAvailable).toBe(true);
    expect(await conn.startPairing()).toEqual({
      pairingId: "p1",
      link: "obsidian://kamino?x",
      expiresAt: Date.parse(EXPIRES),
    });
    expect(log[0]).toMatchObject({
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
    });
    const msg = {
      type: "pairing_request" as const,
      pairingId: "p1",
      deviceName: "iPhone",
      platform: "ios",
      pluginVersion: "0.2.0",
      code: "AB3K",
      expiresAt: EXPIRES,
    };
    conn.receive(msg);
    conn.receive(msg);
    const request = {
      pairingId: "p1",
      deviceName: "iPhone",
      platform: "ios",
      pluginVersion: "0.2.0",
      code: "AB3K",
      at: Date.parse(EXPIRES) - 60_000,
      expiresAt: Date.parse(EXPIRES),
    };
    expect(events).toEqual([{ type: "pairing_request", request }]);
    expect(conn.pairingRequests()).toEqual([request]);
    await conn.approve("p1");
    expect(log.at(-1)).toMatchObject({ method: "POST", path: "/pairings/p1/approve" });
    expect(conn.pairingRequests()).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "pairing_closed", pairingId: "p1" });

    // Answered elsewhere meanwhile: the request goes away and the UI is told.
    conn.receive({ ...msg, pairingId: "p2" });
    await expect(conn.deny("p2")).rejects.toThrow();
    expect(conn.pairingRequests()).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "pairing_closed", pairingId: "p2" });
    conn.receive({ type: "pairing_reused", pairingId: "p3" });
    expect(events.at(-1)).toEqual({ type: "pairing_reused", pairingId: "p3" });
    conn.receive({ ...msg, pairingId: "p4" });
    conn.receive({ type: "pairing_closed", pairingId: "p4" });
    expect(events.at(-1)).toEqual({ type: "pairing_closed", pairingId: "p4" });
  });

  it("origin: without realtime, polling the open offer still brings the request", async () => {
    const wakes: Array<() => void> = [];
    const tick = async () => {
      wakes.shift()!();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    let state: unknown = { status: "waiting" };
    const { conn, events } = setup(
      (r) =>
        r.method === "POST"
          ? {
              status: 200,
              json: { pairingId: "p1", link: "obsidian://kamino?x", expiresAt: EXPIRES },
            }
          : { status: 200, json: state },
      false,
      {
        linked: LINKED,
        now: () => Date.parse(EXPIRES) - 60_000,
        sleep: () => new Promise<void>((r) => wakes.push(r)),
      },
    );
    await conn.startPairing();
    await tick();
    expect(events).toEqual([]);
    state = {
      status: "requested",
      reused: true,
      request: { deviceName: "iPhone", platform: "ios", pluginVersion: "0.2.0", code: "AB3K" },
    };
    await tick();
    expect(events.map((e) => e.type)).toEqual(["pairing_reused", "pairing_request"]);
    await tick();
    expect(events).toHaveLength(2);
    state = { status: "approved" };
    await tick();
    expect(events.at(-1)).toEqual({ type: "pairing_closed", pairingId: "p1" });
    expect(wakes).toEqual([]);
  });
});
