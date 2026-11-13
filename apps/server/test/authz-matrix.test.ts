import { PROTOCOL_VERSION } from "@kamino/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CSRF_VALUE } from "../src/auth/http.js";
import { PROTOCOL_HEADER } from "../src/devices/auth.js";
import { login } from "./helpers/admin.js";
import { testApp, type Agent, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { linkDevice, uploadContent, user, type TestDevice } from "./helpers/sync.js";

/**
 * M7a A3 (T-01, T-02, T-15): every registered route, with who may call it.
 * - public: no credentials (token in the URL or the body, or nothing secret).
 * - user / admin: a web session; admin also needs the role (a plain user gets 403).
 * - device: a device token; enroll: an enroll token; either: a device token or a web session.
 * - ws: the WebSocket, covered by ws.test.ts (it authenticates inside the socket).
 * `own` marks routes that name someone's resource: another user (an admin, here) gets 404.
 * A route missing from this table fails the test: decide its access before shipping it.
 */
type Kind = "public" | "user" | "admin" | "device" | "enroll" | "either" | "ws";
/** Valid bodies, so ownership is what answers (not validation). */
const BODY: Record<string, object> = {
  "POST /api/v1/enroll/vaults/:vaultId/devices": {
    name: "x",
    platform: "macos",
    pluginVersion: "0.1.0",
    protocolVersion: PROTOCOL_VERSION,
  },
  "PATCH /api/v1/devices/:id": { name: "x" },
  "POST /api/v1/conflicts/:id/resolve": {
    resolution: "keep_mine",
    expectedIncomingAt: new Date(0).toISOString(),
  },
};
/** Scoped to the caller's own rows: someone else's id is a silent no-op (Mario keeps his session). */
const NOOP = new Set(["DELETE /api/v1/account/sessions/:id"]);
const MATRIX: Record<string, { kind: Kind; own?: true }> = {
  "GET /api/v1/version": { kind: "public" },
  "GET /api/v1/setup/status": { kind: "public" },
  "POST /api/v1/setup": { kind: "public" },
  "POST /api/v1/auth/login": { kind: "public" },
  "POST /api/v1/auth/totp": { kind: "public" },
  "POST /api/v1/auth/logout": { kind: "public" },
  "GET /api/v1/me": { kind: "user" },
  "POST /api/v1/auth/forgot": { kind: "public" },
  "POST /api/v1/auth/reset": { kind: "public" },
  "GET /api/v1/invites/:token": { kind: "public" },
  "POST /api/v1/invites/:token/accept": { kind: "public" },
  "PATCH /api/v1/account/profile": { kind: "user" },
  "POST /api/v1/account/password": { kind: "user" },
  "POST /api/v1/account/totp/setup": { kind: "user" },
  "POST /api/v1/account/totp/confirm": { kind: "user" },
  "POST /api/v1/account/totp/disable": { kind: "user" },
  "POST /api/v1/account/totp/recovery-codes": { kind: "user" },
  "GET /api/v1/account/sessions": { kind: "user" },
  "DELETE /api/v1/account/sessions/:id": { kind: "user", own: true },
  "DELETE /api/v1/account/sessions": { kind: "user" },
  "GET /api/v1/account/security-log": { kind: "user" },
  "POST /api/v1/devices/login": { kind: "public" },
  "GET /api/v1/enroll/vaults": { kind: "enroll" },
  "POST /api/v1/enroll/vaults": { kind: "enroll" },
  "POST /api/v1/enroll/vaults/:vaultId/devices": { kind: "enroll", own: true },
  "PATCH /api/v1/device": { kind: "device" },
  "DELETE /api/v1/device": { kind: "device" },
  "GET /api/v1/devices": { kind: "user" },
  "GET /api/v1/devices/:id": { kind: "user", own: true },
  "PATCH /api/v1/devices/:id": { kind: "user", own: true },
  "POST /api/v1/devices/:id/revoke": { kind: "user", own: true },
  "GET /api/v1/device": { kind: "device" },
  "GET /api/v1/vault/devices": { kind: "device" },
  "GET /api/v1/vault/settings": { kind: "device" },
  "PUT /api/v1/vault/settings": { kind: "device" },
  "GET /api/v1/device/settings": { kind: "device" },
  "PUT /api/v1/device/settings": { kind: "device" },
  "POST /api/v1/vaults/:vaultId/blobs/check": { kind: "device", own: true },
  "POST /api/v1/vaults/:vaultId/uploads": { kind: "device", own: true },
  "PUT /api/v1/vaults/:vaultId/uploads/:uploadId/chunks/:index": { kind: "device", own: true },
  "GET /api/v1/vaults/:vaultId/uploads/:uploadId": { kind: "device", own: true },
  "POST /api/v1/vaults/:vaultId/uploads/:uploadId/complete": { kind: "device", own: true },
  "GET /api/v1/vaults/:vaultId/blobs/:contentHash": { kind: "device", own: true },
  "POST /api/v1/vaults/:vaultId/commits": { kind: "device", own: true },
  "GET /api/v1/vaults/:vaultId/changes": { kind: "device", own: true },
  "GET /api/v1/vaults/:vaultId/snapshot": { kind: "device", own: true },
  "POST /api/v1/vaults/:vaultId/ack": { kind: "device", own: true },
  "POST /api/v1/vaults/:vaultId/status": { kind: "device", own: true },
  "GET /api/v1/vaults": { kind: "user" },
  "GET /api/v1/vaults/summary": { kind: "user" },
  "GET /api/v1/vaults/:id": { kind: "user", own: true },
  "PATCH /api/v1/vaults/:id": { kind: "user", own: true },
  "DELETE /api/v1/vaults/:id": { kind: "user", own: true },
  "GET /api/v1/vaults/:id/files": { kind: "user", own: true },
  "GET /api/v1/files/:id/versions": { kind: "user", own: true },
  "GET /api/v1/versions/:id": { kind: "user", own: true },
  "GET /api/v1/vaults/:id/trash": { kind: "user", own: true },
  "GET /api/v1/conflicts": { kind: "user" },
  "GET /api/v1/conflicts/:id": { kind: "user", own: true },
  "GET /api/v1/vaults/:id/zip": { kind: "user", own: true },
  "POST /api/v1/versions/:id/restore": { kind: "user", own: true },
  "POST /api/v1/trash/:id/restore": { kind: "user", own: true },
  "POST /api/v1/conflicts/resolve-all": { kind: "user" },
  "POST /api/v1/conflicts/:id/resolve": { kind: "user", own: true },
  "GET /api/v1/exports/:token": { kind: "public" },
  "POST /api/v1/vaults/:id/pairings": { kind: "either", own: true },
  "GET /api/v1/pairings/:id": { kind: "either", own: true },
  "POST /api/v1/pairings/:id/approve": { kind: "either", own: true },
  "POST /api/v1/pairings/:id/deny": { kind: "either", own: true },
  "POST /api/v1/pairings/:id/cancel": { kind: "either", own: true },
  "POST /api/v1/pairings/claim": { kind: "public" },
  "GET /api/v1/pairings/claims/:claimId": { kind: "public" },
  "POST /api/v1/pairings/claims/:claimId/cancel": { kind: "public" },
  "GET /api/v1/admin/users": { kind: "admin" },
  "POST /api/v1/admin/users": { kind: "admin" },
  "GET /api/v1/admin/users/:id": { kind: "admin" },
  "PATCH /api/v1/admin/users/:id": { kind: "admin" },
  "DELETE /api/v1/admin/users/:id": { kind: "admin" },
  "POST /api/v1/admin/users/:id/block": { kind: "admin" },
  "POST /api/v1/admin/users/:id/unblock": { kind: "admin" },
  "POST /api/v1/admin/users/:id/reset-link": { kind: "admin" },
  "GET /api/v1/admin/config": { kind: "admin" },
  "PATCH /api/v1/admin/config": { kind: "admin" },
  "POST /api/v1/admin/config/smtp-test": { kind: "admin" },
  "GET /api/v1/admin/health": { kind: "admin" },
  "GET /api/v1/admin/audit": { kind: "admin" },
  "GET /api/v1/ws": { kind: "ws" },
  "GET /health/live": { kind: "public" },
  "GET /health/ready": { kind: "public" },
  "GET /version": { kind: "public" },
};

describe.skipIf(dockerUnavailable)("authorization matrix (M7a A3)", () => {
  let pg: TestPostgres;
  let t: TestApp;
  /** Mario's resources, named in the URLs. */
  const ids: Record<string, string> = {};
  let mario: Agent;
  let luigi: Agent; // an admin, and a stranger to Mario's vault
  let anna: Agent; // a plain user
  let luigiDevice: TestDevice;
  let luigiEnroll: string;

  beforeAll(async () => {
    pg = await startPostgres();
    t = await testApp(await pg.createDatabase("authz"));
    const enroll = await user(t, "mario");
    const mac = await linkDevice(t, enroll, undefined, "Mac");
    const phone = await linkDevice(t, enroll, mac.vaultId, "iPhone");
    const put = async (d: TestDevice, ver: string, body: string, base: string | null) => {
      const contentHash = await uploadContent(d, Buffer.from(body));
      ids.contentHash = contentHash;
      await d.call("POST", `/vaults/${d.vaultId}/commits`, {
        ops: [
          {
            type: "put",
            opId: `o-${ver}`,
            fileId: "f1",
            versionId: ver,
            path: "a.md",
            baseVersionId: base,
            contentHash,
            size: body.length,
            mtime: 1,
          },
        ],
      });
    };
    await put(mac, "v1", "one", null);
    await put(mac, "v2", "two", "v1");
    await put(phone, "v3", "three", "v1");
    const upload = (
      await mac.call("POST", `/vaults/${mac.vaultId}/uploads`, {
        contentHash: "a".repeat(64),
        size: 3,
      })
    ).json() as { uploadId: string };
    mario = await login(t, "mario");
    const pairing = (await t.call(mario, "POST", `/vaults/${mac.vaultId}/pairings`)).json() as {
      pairingId: string;
    };
    const q = <T>(s: Promise<T[]>) => s.then((r) => r[0]!);
    Object.assign(ids, {
      vaultId: mac.vaultId,
      fileId: "f1",
      versionId: "v2",
      deviceId: mac.deviceId,
      uploadId: upload.uploadId,
      pairingId: pairing.pairingId,
      conflictId: (await q(t.db.$client<{ id: string }[]>`select id from conflicts`)).id,
      sessionId: (
        await q(
          t.db.$client<{ id: string }[]>`
            select s.id from web_sessions s join users u on u.id = s.user_id
            where u.username = 'mario'`,
        )
      ).id,
    });
    luigiEnroll = await user(t, "luigi");
    luigiDevice = await linkDevice(t, luigiEnroll, undefined, "Luigi's PC");
    luigi = await login(t, "luigi");
    await t.db
      .$client`update users set role = 'admin', totp_enabled_at = now() where username = 'luigi'`;
    await user(t, "anna");
    anna = await login(t, "anna");
  }, 120_000);
  afterAll(async () => {
    await t?.close();
    await pg?.stop();
  });

  const urlOf = (route: string) =>
    route
      .replace(":vaultId", ids.vaultId!)
      .replace(":uploadId", ids.uploadId!)
      .replace(":contentHash", ids.contentHash!)
      .replace(":index", "0")
      .replace(":token", "x".repeat(43))
      .replace(":claimId", "00000000-0000-7000-8000-000000000000")
      .replace(/:id/, () => {
        if (route.includes("/sessions/")) return ids.sessionId!;
        if (route.includes("/devices/")) return ids.deviceId!;
        if (route.includes("/files/") || route.includes("/trash/")) return ids.fileId!;
        if (route.includes("/versions/")) return ids.versionId!;
        if (route.includes("/conflicts/")) return ids.conflictId!;
        if (route.includes("/pairings/")) return ids.pairingId!;
        if (route.includes("/admin/users/")) return ids.deviceId!;
        return ids.vaultId!;
      });
  const send = (
    method: string,
    url: string,
    headers: Record<string, string> = {},
    body: object = {},
  ) =>
    t.app.inject({
      method: method as "GET",
      url,
      headers: {
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        "x-requested-with": CSRF_VALUE,
        ...headers,
      },
      ...(method === "GET" ? {} : { payload: body }),
    });
  const asAgent = (a: Agent) => (a.cookie ? { cookie: a.cookie } : {});

  it("lists every registered route", () => {
    const registered = t.app.routeList.map((r) => `${r.method} ${r.url}`).sort();
    expect(registered).toEqual(Object.keys(MATRIX).sort());
  });

  it("refuses every protected route without credentials", async () => {
    const got: string[] = [];
    for (const [route, { kind }] of Object.entries(MATRIX)) {
      if (kind === "public" || kind === "ws") continue;
      const [method, path] = route.split(" ") as [string, string];
      const r = await send(method, urlOf(path));
      if (r.statusCode !== 401) got.push(`${route} → ${r.statusCode}`);
    }
    expect(got).toEqual([]);
  });

  it("admin routes refuse a plain user", async () => {
    const got: string[] = [];
    for (const [route, { kind }] of Object.entries(MATRIX)) {
      if (kind !== "admin") continue;
      const [method, path] = route.split(" ") as [string, string];
      const r = await send(method, urlOf(path), asAgent(anna));
      if (r.statusCode !== 403) got.push(`${route} → ${r.statusCode}`);
    }
    expect(got).toEqual([]);
  });

  it("someone else's resources are a 404, for an admin too (no bypass)", async () => {
    const got: string[] = [];
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
    for (const [route, { kind, own }] of Object.entries(MATRIX)) {
      if (!own) continue;
      const [method, path] = route.split(" ") as [string, string];
      const tries =
        kind === "device"
          ? [bearer(luigiDevice.token)]
          : kind === "enroll"
            ? [bearer(luigiEnroll)]
            : kind === "either"
              ? [asAgent(luigi), bearer(luigiDevice.token)]
              : [asAgent(luigi)];
      for (const h of tries) {
        const r = await send(method, urlOf(path), h, BODY[route]);
        const want = NOOP.has(route) ? 204 : 404;
        if (r.statusCode !== want) got.push(`${route} → ${r.statusCode}`);
      }
    }
    expect(got).toEqual([]);
    // Nothing of Mario's moved meanwhile.
    expect((await t.call(mario, "GET", `/vaults/${ids.vaultId}`)).statusCode).toBe(200);
    expect((await t.call(mario, "GET", "/me")).statusCode).toBe(200);
  });
});
