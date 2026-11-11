import type { Http, HttpRequest, HttpResponse } from "@kamino/sync-engine";
import { describe, expect, it } from "vitest";
import type { LinkStore } from "./fake-server.js";
import { RealConnection, type StoredLink } from "./real-server.js";
import type { ConnectionEvent, LinkInfo } from "./types.js";

const err = (status: number, code: string): HttpResponse => ({
  status,
  json: { error: { code, message: code, retryable: false } },
});

function setup(handler: (r: HttpRequest, server: string) => HttpResponse, isMobile = false) {
  let stored: LinkInfo | null = null;
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

  it("pairing with a QR code is not available yet", async () => {
    const { conn } = setup(() => version);
    expect(conn.pairingAvailable).toBe(false);
    expect(conn.pairingRequests()).toEqual([]);
    await expect(conn.startPairing()).rejects.toThrow();
  });
});
